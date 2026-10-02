/**
 * 浏览器会话管理器：headless 常驻实例 + 标签页账本。
 *
 * 设计约束（PROPOSAL.md §6.3 / §6.7，均有参照证据）：
 * - headless 默认，绝不主动弹出可见窗口（§6.7-1）；
 * - 只驱动托管实例，绝不 attach 用户日常浏览器（§6.7-5）；
 * - open() 同站复用标签页，避免堆积（参照官方 browser-client.mjs:1942 的复用语义）；
 * - 动作目标必须唯一定位：0 个 → ELEMENT_UNAVAILABLE(reobserve)；多个 → 拒绝并要求收窄，
 *   不做位置捷径（官方 control-browser SKILL.md:109 的纪律）；
 * - 页面内容是不可信数据，只用于定位，绝不当作指令（SKILL.md:175）；
 * - goto 只接受 http/https（对齐官方 IAB 的导航边界，SKILL.md:164）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ControlXError } from '../core/errors.js';
import { findBrowserExecutable } from './discover.js';

const GOTO_TIMEOUT_MS = 20000;
/** goto 超时后的宽限等待：实测（2026-10-02 两次端到端）导航会真实发生、只是
 * domcontentloaded 迟到（URL 已设置、标题暂空，稍后 load 正常触发）。 */
const GOTO_GRACE_MS = 10000;
const ACTION_TIMEOUT_MS = 5000;
const SNAPSHOT_MAX_CHARS = 30000;
/** 浏览器空闲回收默认时长（毫秒）；0 = 关闭回收。 */
const DEFAULT_IDLE_MS = 300000;
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

function assertNavigableUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ControlXError(`无效 URL：${JSON.stringify(rawUrl)}`, { code: 'INTERNAL' });
  }
  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new ControlXError(
      `只允许 http/https 导航，收到 ${parsed.protocol}: —— file:/data:/javascript: 一律拒绝`,
      { code: 'ACTION_UNAVAILABLE' },
    );
  }
  return parsed;
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export class BrowserManager {
  /** @param {object} cfg Config 归一后的配置（headless/browserPath/browserIdleMs）。 */
  constructor(cfg) {
    this.cfg = cfg;
    this.context = null;
    this.launching = null;
    /** @type {Map<string, import('playwright-core').Page>} */
    this.pages = new Map();
    this.seq = 0;
    /** 空闲回收：headless 实例是 9 个进程、数百 MB 的常驻树，无人使用时必须还回去。 */
    this.holds = 0;
    this.idleTimer = null;
    this.lastUsedAt = 0;
    /** 登录窗口流程状态与元素选择的常驻 CDP 会话（tabId → session）。 */
    this.loginActive = false;
    this.lastLoginUrl = null;
    this.pickSessions = null;
  }

  get idleMs() {
    const v = Number(this.cfg.browserIdleMs);
    return Number.isFinite(v) ? v : DEFAULT_IDLE_MS;
  }

  /** 记录一次使用（工具调用、面板轮询）→ 重置回收计时。 */
  touch() {
    this.lastUsedAt = Date.now();
    this.scheduleIdleCheck();
  }

  /** 外部持有（面板推流期间）：持有期内绝不回收，否则画面会在用户眼前断掉。 */
  hold() {
    this.holds += 1;
    this.clearIdleTimer();
  }

  release() {
    this.holds = Math.max(0, this.holds - 1);
    this.scheduleIdleCheck();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleCheck() {
    this.clearIdleTimer();
    if (!this.context || this.launching || this.holds > 0 || this.loginActive || this.idleMs <= 0) return;
    const remaining = this.lastUsedAt + this.idleMs - Date.now();
    // 下限 100ms 只为避免定时器抖动成忙循环；不能用 1s —— 那样 release() 放开一个
    // 早已超时的实例还要多挂 1 秒，短 browserIdleMs 更是直接失效。
    this.idleTimer = setTimeout(() => { this.idleCheck(); }, Math.max(100, remaining));
    this.idleTimer.unref?.();
  }

  async idleCheck() {
    this.idleTimer = null;
    if (!this.context || this.launching || this.holds > 0 || this.loginActive || this.idleMs <= 0) return;
    if (Date.now() - this.lastUsedAt < this.idleMs) return this.scheduleIdleCheck();
    await this.shutdown().catch(() => undefined);
  }

  get userDataDir() {
    // DHCX_BROWSER_PROFILE 仅供验收/CI 指定独立 profile：
    // 插件实例在跑时它持有默认 profile 的单例锁，验收脚本直接复用会启动失败。
    return process.env.DHCX_BROWSER_PROFILE
      || join(homedir(), '.dsh', 'cache', 'dsh-control-x', 'browser-profile');
  }

  /** 懒启动：首次浏览器工具调用才拉起实例。headless 可覆盖（登录窗口流程用）。 */
  async ensureContext({ headless } = {}) {
    this.touch();
    if (this.context && this.context.browser()?.isConnected() !== false) return this.context;
    this.pages.clear();
    const executablePath = findBrowserExecutable(this.cfg.browserPath);
    if (!executablePath) {
      throw new ControlXError(
        '未找到 Chrome/Edge 可执行文件；请在插件设置中配置 browserPath，或安装 Edge/Chrome。',
        { code: 'HELPER_UNAVAILABLE' },
      );
    }
    this.launching ??= chromium
      .launchPersistentContext(this.userDataDir, {
        executablePath,
        headless: headless !== undefined ? headless : this.cfg.headless !== false,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-field-trial-config'],
        // 设置页「忽略证书校验」：只影响内置浏览器；改动需下次启动生效。
        ignoreHTTPSErrors: this.cfg.ignoreCertErrors === true,
      })
      .then((context) => {
        this.context = context;
        this.launching = null;
        this.touch();
        context.on('close', () => {
          this.context = null;
          this.pages.clear();
          this.clearIdleTimer();
          const wasLogin = this.loginActive;
          this.loginActive = false;
          this.holds = 0;
          this.pickSessions = null;
          // 登录窗口被用户手动关掉（点了窗口的 ×）：自动回无头并还原页面，
          // 别让侧边栏画面跟着一起熄灭。恢复是异步的，这里只触发。
          if (wasLogin && this.lastLoginUrl) {
            const url = this.lastLoginUrl;
            setTimeout(() => {
              this.ensureContext()
                .then((ctx) => ctx.newPage())
                .then((page) => {
                  this.bind(page);
                  return page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }).catch(() => undefined);
                })
                .catch(() => undefined);
            }, 50);
          }
        });
        return context;
      })
      .catch((err) => {
        this.launching = null;
        throw new ControlXError(`浏览器启动失败：${err.message}`, { code: 'HELPER_UNAVAILABLE' });
      });
    return this.launching;
  }

  /** 标签页账本：剔除已关闭页，返回元数据（不含 Page 对象，对齐官方 tabs.list 纪律）。 */
  listTabs() {
    this.touch();
    const tabs = [];
    for (const [id, page] of this.pages) {
      if (page.isClosed()) {
        this.pages.delete(id);
        continue;
      }
      tabs.push({ id, url: page.url(), title: page._cxTitle ?? '' });
    }
    return tabs;
  }

  bind(page) {
    for (const [id, existing] of this.pages) {
      if (existing === page) return id;
    }
    const id = `t${++this.seq}`;
    this.pages.set(id, page);
    return id;
  }

  get(tabId) {
    this.touch();
    const page = this.pages.get(tabId);
    if (!page || page.isClosed()) {
      throw new ControlXError(
        `标签页 ${tabId} 不存在或已关闭。先调用 x_browser_tabs 获取当前列表，再按 id 选择。`,
        { code: 'STALE_STATE' },
      );
    }
    return page;
  }

  requireTabId(hint) {
    const tabs = this.listTabs();
    if (tabs.length === 0) {
      throw new ControlXError('当前没有任何标签页：请先用 x_browser_open 打开页面。', {
        code: 'STALE_STATE',
      });
    }
    if (hint !== undefined) return hint;
    if (tabs.length === 1) return tabs[0].id;
    throw new ControlXError(
      `存在 ${tabs.length} 个标签页且未指定 tab_id：先调用 x_browser_tabs 查看，再显式选择。不做位置捷径。`,
      { code: 'STALE_STATE' },
    );
  }

  /** open()：同站（hostname 相同）复用并原地跳转；否则新开。 */
  async open(rawUrl, { reuse = true } = {}) {
    const url = assertNavigableUrl(rawUrl);
    let page;
    if (reuse) {
      const host = url.hostname.toLowerCase();
      for (const [id, candidate] of this.pages) {
        if (!candidate.isClosed() && hostnameOf(candidate.url()) === host) {
          page = candidate;
          try {
            await this.gotoWithGrace(page, url.href);
          } catch (err) {
            throw this.mapNavigationError(err, url.href);
          }
          return this.tabInfo(id, page);
        }
      }
    }
    const context = await this.ensureContext();
    page = await context.newPage();
    const id = this.bind(page);
    try {
      await this.gotoWithGrace(page, url.href);
    } catch (err) {
      throw this.mapNavigationError(err, url.href);
    }
    return this.tabInfo(id, page);
  }

  /**
   * goto + 超时宽限。goto 报 Timeout ≠ 导航失败：2026-10-02 两次端到端实测，DSH 宿主里
   * 导航已提交（URL 已设置）只是 domcontentloaded 迟到，x_browser_wait 等 load 随后成功。
   * 所以对超时类错误先给一次有界宽限等待，等到了就当慢启动成功；非超时错误（如
   * net::ERR_CONNECTION_REFUSED）与宽限内仍未到 DCL 的，原样上抛由 mapNavigationError 归一。
   */
  async gotoWithGrace(page, href) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      return;
    } catch (err) {
      if (!/Timeout .*exceeded/i.test(String(err?.message ?? err))) throw err;
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: GOTO_GRACE_MS });
      } catch {
        throw err;
      }
    }
  }

  async navigate(tabId, rawUrl) {
    const url = assertNavigableUrl(rawUrl);
    const page = this.get(this.requireTabId(tabId));
    try {
      await this.gotoWithGrace(page, url.href);
    } catch (err) {
      throw this.mapNavigationError(err, url.href);
    }
    return this.tabInfo(this.bind(page), page);
  }

  /** 历史导航与刷新（面板工具栏 ← → ↻）。无历史时 playwright 返回 null，不算错误。 */
  async history(tabId, action) {
    const page = this.get(this.requireTabId(tabId));
    try {
      if (action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } else if (action === 'forward') {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } else if (action === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } else {
        throw new ControlXError(`未知导航动作 ${JSON.stringify(action)}（支持 back/forward/reload）`, {
          code: 'INTERNAL',
        });
      }
    } catch (err) {
      // 历史导航同样吃慢启动（同 open/navigate 的宽限逻辑），但 goBack 等返回 null 表示
      // 无历史，属正常路径，这里只对超时类补宽限。
      if (err instanceof ControlXError) throw err;
      if (/Timeout .*exceeded/i.test(String(err?.message ?? err))) {
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: GOTO_GRACE_MS });
        } catch {
          throw this.mapNavigationError(err, `${action} ${page.url()}`);
        }
      } else {
        throw this.mapNavigationError(err, `${action} ${page.url()}`);
      }
    }
    return this.tabInfo(this.bind(page), page);
  }

  /**
   * 清除浏览器数据（设置页「浏览器数据」卡片）：
   * - cache：Network.clearBrowserCache（HTTP/磁盘缓存，保留 Cookie 与站点数据）
   * - all：  再加 Cookie 与所有已打开站点 origin 的本地数据
   * 需要活页拿 CDP 会话；浏览器未启动时无数据可清，直接报告。
   */
  async clearData(mode = 'cache') {
    const tabs = this.listTabs();
    if (tabs.length === 0) {
      return { ok: true, mode, cleared: [], note: '浏览器未启动（无标签页），没有可清除的数据。' };
    }
    const page = this.get(tabs[0].id);
    const cdp = await page.context().newCDPSession(page);
    const cleared = [];
    try {
      await cdp.send('Network.clearBrowserCache');
      cleared.push('cache');
      if (mode === 'all') {
        await page.context().clearCookies();
        cleared.push('cookies');
        const origins = new Set();
        for (const tab of this.listTabs()) {
          try {
            const origin = new URL(tab.url).origin;
            if (origin && origin !== 'null') origins.add(origin);
          } catch {
            // 非法 URL 跳过
          }
        }
        for (const origin of origins) {
          await cdp.send('Storage.clearDataForOrigin', {
            origin,
            storageTypes: 'appcache,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage',
          });
        }
        if (origins.size) cleared.push('storage');
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
    return { ok: true, mode, cleared };
  }

  mapNavigationError(err, url) {
    if (err instanceof ControlXError) return err;
    const msg = String(err?.message ?? err);
    if (/Timeout .*exceeded/i.test(msg)) {
      return new ControlXError(
        `导航超时（20s+10s 宽限）：${url}。domcontentloaded 一直没到。` +
        '可先 x_browser_tabs 查看该页状态：URL 已设置说明导航已提交，只是加载慢——'
        + '用 x_browser_wait(loadState) 再等或重试一次是正当恢复；URL 都没有才是真的不可达。',
        { code: 'TIMEOUT', details: { url } },
      );
    }
    return new ControlXError(`导航失败：${msg.split('\n')[0]}`, { code: 'INTERNAL', details: { url } });
  }

  async tabInfo(tabId, page) {
    let title = '';
    try {
      title = await page.title();
    } catch {
      // 标题读取失败不阻断；记录为空。
    }
    page._cxTitle = title;
    return { id: tabId, url: page.url(), title };
  }

  /** 唯一目标定位：role+name 优先，selector 次之，text 兜底。 */
  resolveLocator(page, target = {}) {
    const { role, name, exact = false, selector, text } = target;
    const described = role
      ? `role=${role}${name ? ` name=${JSON.stringify(name)}` : ''}`
      : selector
        ? `selector=${selector}`
        : `text=${JSON.stringify(text)}`;
    if (!role && !selector && !text) {
      throw new ControlXError('需要目标：优先 role+name（来自 x_browser_read 的快照），或 CSS selector。', {
        code: 'INTERNAL',
      });
    }
    const locator = role
      ? page.getByRole(role, name === undefined ? undefined : { name, exact })
      : selector
        ? page.locator(selector)
        : page.getByText(text, { exact });
    return { locator, described };
  }

  async resolveUnique(page, target) {
    const { locator, described } = this.resolveLocator(page, target);
    let count;
    try {
      count = await locator.count();
    } catch (err) {
      throw new ControlXError(`目标表达式无效（${described}）：${String(err.message).split('\n')[0]}`, {
        code: 'INTERNAL',
      });
    }
    if (count === 0) {
      throw new ControlXError(
        `目标未找到（${described}）。不要重试同一目标：重新调用 x_browser_read 取新快照再定位。`,
        { code: 'ELEMENT_UNAVAILABLE', details: { target: described } },
      );
    }
    if (count > 1) {
      throw new ControlXError(
        `目标命中 ${count} 个元素（${described}）。请收窄：补 name 全文、换更精确的 role，或改用唯一 CSS selector。`,
        { code: 'NOT_SELECTABLE', details: { target: described, matches: count } },
      );
    }
    return locator;
  }

  async click(tabId, target) {
    const page = this.get(this.requireTabId(tabId));
    const locator = await this.resolveUnique(page, target);
    try {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw this.mapActionError(err, 'click');
    }
    return this.tabInfo(this.bind(page), page);
  }

  async fill(tabId, target, value) {
    const page = this.get(this.requireTabId(tabId));
    const locator = await this.resolveUnique(page, target);
    try {
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw this.mapActionError(err, 'fill');
    }
    return this.tabInfo(this.bind(page), page);
  }

  async press(tabId, key) {
    const page = this.get(this.requireTabId(tabId));
    try {
      await page.keyboard.press(key);
    } catch (err) {
      throw new ControlXError(`按键失败：${String(err.message).split('\n')[0]}`, { code: 'INTERNAL' });
    }
    return this.tabInfo(this.bind(page), page);
  }

  async scroll(tabId, direction = 'down', amount = 3) {
    const page = this.get(this.requireTabId(tabId));
    const deltaY = direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, deltaY * 400);
    return this.tabInfo(this.bind(page), page);
  }

  async read(tabId) {
    const page = this.get(this.requireTabId(tabId));
    let snapshot;
    try {
      snapshot = await page.locator('body').ariaSnapshot({ timeout: 8000 });
    } catch (err) {
      throw new ControlXError(
        `语义快照不可用：${String(err.message).split('\n')[0]}。改用 x_browser_shot 以视觉方式查看该页面。`,
        { code: 'ELEMENT_UNAVAILABLE' },
      );
    }
    const info = await this.tabInfo(this.bind(page), page);
    const truncated = snapshot.length > SNAPSHOT_MAX_CHARS;
    return {
      ...info,
      snapshot: truncated ? `${snapshot.slice(0, SNAPSHOT_MAX_CHARS)}\n…（已截断）` : snapshot,
      truncated,
    };
  }

  /** 截图：jpeg → attachments 服务持久化 → 返回附件引用。 */
  async shot(tabId, { fullPage = false, attachments } = {}) {
    const page = this.get(this.requireTabId(tabId));
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage });
    if (!attachments || typeof attachments.saveImage !== 'function') {
      throw new ControlXError(
        '当前环境未挂载 attachments 服务，无法持久化截图。请改用 x_browser_read 的语义快照。',
        { code: 'ACTION_UNAVAILABLE' },
      );
    }
    const mediaType = 'image/jpeg';
    const ref = await attachments.saveImage({
      data: buffer,
      mediaType,
      name: `x-browser-${Date.now()}.jpg`,
    });
    const info = await this.tabInfo(this.bind(page), page);
    return {
      ...info,
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType ?? mediaType,
        bytes: ref.bytes ?? buffer.byteLength,
        width: ref.width,
        height: ref.height,
        name: ref.name,
      },
    };
  }

  async wait(tabId, { url, loadState, ms } = {}) {
    const page = this.get(this.requireTabId(tabId));
    if (ms !== undefined) await page.waitForTimeout(Math.min(Math.max(ms, 0), 30000));
    if (loadState) await page.waitForLoadState({ state: loadState, timeout: ACTION_TIMEOUT_MS });
    if (url) await page.waitForURL(url, { timeout: ACTION_TIMEOUT_MS });
    return this.tabInfo(this.bind(page), page);
  }

  async close(tabId) {
    const page = this.get(this.requireTabId(tabId));
    await page.close();
    this.pages.delete(this.bind(page));
    return { closed: tabId };
  }

  mapActionError(err, action) {
    if (err instanceof ControlXError) return err;
    const msg = String(err?.message ?? err);
    if (/Timeout .*exceeded/i.test(msg)) {
      return new ControlXError(
        `${action} 超时（5s）。目标存在但不可交互（被遮挡/禁用/动画中）：重新观察后再决定，不要盲重试。`,
        { code: 'TIMEOUT' },
      );
    }
    return new ControlXError(`${action} 失败：${msg.split('\n')[0]}`, { code: 'INTERNAL' });
  }

  /** 调整页面视口（自由尺寸）：宽高为 CSS 像素，边界对齐官方 viewport 安全范围（320×240 ~ 3840×2160）。 */
  async setViewport(tabId, width, height) {
    const page = this.get(this.requireTabId(tabId));
    const w = Math.min(3840, Math.max(320, Math.round(Number(width) || 0)));
    const h = Math.min(2160, Math.max(240, Math.round(Number(height) || 0)));
    await page.setViewportSize({ width: w, height: h });
    return { id: tabId, width: w, height: h };
  }

  /**
   * 元素选择（对齐官方 elementPicker 的"选出元素"半边）：返回视口点上的元素定位信息。
   * 坐标是页面视口 CSS 像素（客户端按 screencast metadata 换算过）。
   * 选择器偏好 id，否则沿祖先构建 nth-of-type 链（≤4 层）——够 Agent 用 x_browser_click 精确回访。
   */
  async pick(tabId, x, y) {
    const page = this.get(this.requireTabId(tabId));
    const vx = Math.max(0, Math.round(Number(x) || 0));
    const vy = Math.max(0, Math.round(Number(y) || 0));
    const info = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      function selectorOf(e) {
        if (e.id) return '#' + CSS.escape(e.id);
        const parts = [];
        let cur = e;
        for (let depth = 0; cur && depth < 4; depth++) {
          if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
          let sel = cur.tagName.toLowerCase();
          const parent = cur.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
            if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          parts.unshift(sel);
          cur = parent;
        }
        return parts.join(' > ');
      }
      return {
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: typeof el.className === 'string' && el.className ? el.className.slice(0, 120) : undefined,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
      };
    }, [vx, vy]);
    if (!info || !info.selector) {
      throw new ControlXError(`视口点 (${vx}, ${vy}) 上没有可定位的元素。`, { code: 'ELEMENT_UNAVAILABLE' });
    }
    return info;
  }

  /** 元素选择模式的常驻 CDP 会话：高亮要跨多次 hover 存活，不能每次 detach。 */
  pickSessionFor(tabId) {
    if (!this.pickSessions) this.pickSessions = new Map();
    return this.pickSessions.get(tabId);
  }

  async startPickMode(tabId) {
    const page = this.get(this.requireTabId(tabId));
    if (this.pickSessionFor(tabId)) return { ok: true };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable').catch(() => undefined);
    await cdp.send('Overlay.enable').catch(() => undefined);
    if (!this.pickSessions) this.pickSessions = new Map();
    this.pickSessions.set(tabId, cdp);
    return { ok: true };
  }

  async stopPickMode(tabId) {
    const cdp = this.pickSessionFor(tabId);
    if (!cdp) return { ok: true };
    this.pickSessions.delete(tabId);
    await cdp.send('Overlay.hideHighlight').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    return { ok: true };
  }

  /** 悬停高亮（ZCode 元素选择体验）：把 hover 坐标处的元素框出来，随下一帧回到面板。
   *  注意 getNodeForLocation 返回 backendNodeId（无 nodeId），highlightNode 要用它。 */
  async highlightAt(tabId, x, y) {
    const cdp = this.pickSessionFor(tabId);
    if (!cdp) return { ok: false };
    try {
      const { backendNodeId } = await cdp.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y) });
      if (!backendNodeId) return { ok: false };
      await cdp.send('Overlay.highlightNode', {
        backendNodeId,
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 74, g: 125, b: 255, a: 0.3 },
          borderColor: { r: 74, g: 125, b: 255, a: 1 },
        },
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** 登录窗口：同一持久化 profile 临时切有头（用户在面板主动触发，符合不打扰约束 §6.7-1），登录态直接落盘。
   *  用户直接关掉这个窗口也不会丢面板：close 事件里自动回无头并还原 lastLoginUrl。 */
  async openLoginWindow(rawUrl) {
    const url = assertNavigableUrl(rawUrl);
    // 先复位再关旧实例：否则旧 headless 实例的 close 事件会误触发"登录窗口恢复"路径
    this.loginActive = false;
    await this.shutdown();
    this.loginActive = true;
    this.lastLoginUrl = url.href;
    this.hold();
    const context = await this.ensureContext({ headless: false });
    const page = await context.newPage();
    const id = this.bind(page);
    try {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (err) {
      throw this.mapNavigationError(err, url.href);
    }
    return this.tabInfo(id, page);
  }

  /** 已登录，保存：关掉有头窗口回无头（登录态已在持久化 profile 里），并回到原页面。 */
  async finishLogin(rawUrl) {
    const url = rawUrl ? assertNavigableUrl(rawUrl) : null;
    this.loginActive = false;
    this.lastLoginUrl = null;
    await this.shutdown();
    const context = await this.ensureContext();
    let tab = null;
    if (url) {
      const page = await context.newPage();
      const id = this.bind(page);
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS }).catch(() => undefined);
      tab = this.tabInfo(id, page);
    }
    return { ok: true, saved: true, tab };
  }

  async shutdown() {
    this.clearIdleTimer();
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.pages.clear();
      this.launching = null;
      this.loginActive = false;
      this.pickSessions = null;
    }
  }
}
