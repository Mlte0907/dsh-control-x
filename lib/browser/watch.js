/**
 * 面板服务端：webServer 路由（kind:"prefix"，ego lib/index.js:2032 同款形状）。
 *
 * 路由（前缀 /api/x-control/）：
 *   GET  /tabs    当前标签页 JSON
 *   GET  /stream?tab=<id>   SSE：CDP Page.startScreencast JPEG 帧 + 心跳；
 *                           帧带设备宽高，客户端据此做点击坐标缩放。
 *   POST /input   {tab,type:'click'|'scroll'|'key',...} 输入回传（playwright 鼠标/键盘）
 *   POST /viewport {tab?,width,height} 视口调整（自由尺寸，宽高 CSS 像素）
 *   POST /pick    {tab,x,y} 元素选择：返回点击点元素的定位信息（对齐官方 elementPicker）
 *   POST /hover   {tab,x,y} 元素选择悬停高亮（CDP Overlay，随帧回到面板）
 *   POST /pick-start|/pick-stop {tab} 进入/退出元素选择模式（高亮 CDP 会话生命周期）
 *   POST /close-tab {tab} 关闭标签页（面板标签 chip 的 × ）
 *   POST /login-window {url} 弹出登录窗口（同 profile 临时切有头）
 *   POST /login-done  {url?} 已登录，保存：关掉有头回无头，登录态留在持久化 profile
 *   POST /navigate {tab?,url} 面板地址栏导航：有 tab 原地跳，无 tab 新开
 *   POST /nav     {tab,action:'back'|'forward'|'reload'} 工具栏历史导航
 *   POST /open-external {tab} 在系统默认浏览器打开当前页
 *   POST /clear-data {mode:'cache'|'all'} 设置页「浏览器数据」清除
 *
 * 2026-10-03 下线的路由：GET/POST /host-accessibility（写宿主快捷方式的无障碍旗标）
 * 与 GET/POST /config（文件覆盖层）—— 理由见 handler 里各自的注释。
 *
 * 推流生命周期：SSE 订阅计数归零即停 screencast（对齐 ego 的 watcher lease 思路）。
 */
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PREFIX = '/api/x-control';

/** 请求体上限（字节）。这一层的入参最大是「让 Agent 现拍一张」的 tab_id 或一段文本，
 *  64KB 有三个数量级的余量；不设上限则任意本地页面都能把宿主内存吃光。 */
export const MAX_BODY_BYTES = 64 * 1024;

function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/**
 * ── 浏览器信任栅栏（2026-10-02 补，勿删）────────────────────────────
 *
 * 背景（实测证据）：`dsh-host-webserver` 的分发是纯 `match(pathname) → route.handler`
 * （app.asar 内 lib/index.js:229-245），**webserver 层没有任何全局栅栏**；宿主自己的
 * Host/Origin 三重校验 + 浏览器会话认证只作用在 `dsh-client-connection` 自己那条 `/api`
 * 路由上（同包 requestRejection()）。插件用 `webServer.register({kind:'prefix'})` 注册的
 * 是**第二条独立路由**，因此原本落在那道栅栏之外。
 *
 * 后果实测（对运行中的宿主打的同一个请求）：
 *     GET /api                     → 403   ← 宿主拒绝
 *     GET /api/x-control/config    → 200   ← 插件放行
 * 而这条无鉴权的路上挂着有副作用的端点：POST /update（下载安装新版本）、
 * POST /host-accessibility（改宿主启动快捷方式）、POST /clear-data（清 Cookie）、
 * POST /input（点击打字）、POST /login-window（拉起有头浏览器）、POST /config。
 *
 * 参照实现：`Fisfzy/dsh-ego-browser` 是同代、同宿主、同架构（浏览器+面板+推流）里唯一
 * 也注册 webServer 路由的，它做了四件事（lib/index.js:2040-2061 与 :1149）：
 * POST only、Origin 必须等于 Host、Content-Type 必须 application/json、body 限长。
 * 本文件照抄其中与本插件形态匹配的三条，并补一条 Host 必须回环（见下）。
 *
 * 三条各自的作用，彼此冗余、故意冗余：
 *   1. Host 必须回环 —— 杀 DNS rebinding。webserver 只绑 127.0.0.1（宿主启动时
 *      `--host 0.0.0.0` 被直接拒绝，理由是会「把 RCE 暴露到网络上」），但 rebinding
 *      请求的 Host 头是攻击者域名，所以这条一票否决。合法客户端连的就是 127.0.0.1，不会误伤。
 *   2. POST 的 Origin（若存在）必须等于 Host —— 杀跨站。按 Fetch 规范，浏览器对
 *      GET/HEAD 之外的请求**一定**带 Origin，所以跨站 POST 一定在这里被拒。
 *      缺席 Origin 时不拒（那是 curl / 验收脚本 / 单测这类非浏览器客户端），
 *      但此时仍要过第 1、3 条。
 *   3. POST 的 Content-Type 必须是 application/json —— 兜底。它不是 CORS 安全列表里的
 *      类型，跨域使用会触发预检；本插件不返回任何 CORS 响应头，预检必然失败，
 *      请求**根本发不出去**（这正是 `text/plain` + `mode:'no-cors'` 那条绕过路径的封堵）。
 *
 * 刻意**不**校验宿主会话 cookie（`dsh-auth-*`，见 ego-browser 的 guardHandler）：
 * cookie 由宿主的 browserAuth 在 index 请求时才种下，桌面端是否已种取决于宿主启动路径，
 * 拿它当硬门有可能在某些部署下直接把面板锁死；而上面三条对「远程网页」这个真实威胁模型
 * 已经闭合。签名密钥在宿主 ctx.credentials 里，插件本就拿不到，本插件只查存在性、
 * 不当作认证依据。同一台机器上的恶意进程能伪造任何东西——它也能直接进内存调插件，
 * 不在这个威胁模型内。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 取出 Host/Origin 头里的主机名（小写、去端口、IPv6 去方括号），解析不了返回 null。 */
function hostnameOfAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return null;
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** Host 头是否指向回环地址。 */
export function isLoopbackHostHeader(authority) {
  const host = hostnameOfAuthority(authority);
  return host !== null && LOOPBACK_HOSTNAMES.has(host);
}

/**
 * 栅栏判定。返回 null = 放行；否则返回要写回客户端的 {status, error}。
 * 纯函数、导出让单测直接覆盖每一条分支。
 */
export function requestGuardReason(req) {
  const headers = req?.headers ?? {};
  // 1. Host 必须回环（杀 rebinding）
  if (!isLoopbackHostHeader(headers.host)) {
    return {
      status: 403,
      error: 'host-not-loopback',
      message: '只接受来自本机回环地址的请求（Host 必须是 127.0.0.1/localhost/::1）。',
    };
  }
  // 2. POST 的 Origin（若存在）必须与 Host 同源（杀跨站）
  const origin = headers.origin;
  if (origin !== undefined && origin !== '') {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { status: 400, error: 'invalid-origin', message: 'Origin 头无法解析。' };
    }
    if (originHost !== headers.host) {
      return {
        status: 403,
        error: 'origin-not-allowed',
        message: '跨源请求一律拒绝：本插件的接口只接受与 Host 同源的调用。',
      };
    }
  }
  // 3. POST 必须是 application/json（触发预检，让跨域请求发不出去）
  if (req.method === 'POST') {
    const contentType = String(headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(contentType)) {
      return {
        status: 415,
        error: 'content-type-not-supported',
        message: 'Content-Type 必须是 application/json。',
      };
    }
  }
  return null;
}

/** 读请求体：带硬上限。超限直接抛错，由 handler 统一转 500（如实告诉调用方"太大"）。 */
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new Error(`请求体超过上限 ${maxBytes} 字节（已读到 ${bytes}），已拒绝`);
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

/**
 * 用系统默认浏览器打开 URL。
 * Windows 走 rundll32 url.dll,FileProtocolHandler（execFile 不经 shell，
 * 规避 `cmd /c start` 对 URL 中 & % ^ 等字符的二次解析注入）。
 */
async function defaultOpenExternal(target) {
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`只允许打开 http/https 地址，收到 ${JSON.stringify(target)}`);
  }
  if (process.platform === 'win32') {
    await execFileP('rundll32', ['url.dll,FileProtocolHandler', target], { windowsHide: true });
  } else if (process.platform === 'darwin') {
    await execFileP('open', [target]);
  } else {
    await execFileP('xdg-open', [target]);
  }
  return target;
}

/**
 * CDP 推流参数。everyNthFrame=2 是刻意的：CDP 按合成帧出帧，而服务端 120ms 才取一次
 * （≈8fps），取 1 会让浏览器把每个合成帧都编码成 JPEG 再丢弃大半——动画/视频页上纯属空烧 CPU。
 */
export const SCREENCAST_OPTIONS = { format: 'jpeg', quality: 55, maxWidth: 1280, everyNthFrame: 2 };

/** CDP screencast 会话：绑定一个 tab，产出最新 JPEG 帧（带 ACK 与设备尺寸）。 */
async function createFrameSource(manager, tabId) {
  const page = manager.get(tabId);
  const cdp = await page.context().newCDPSession(page);
  let latest = null;
  let dirty = false;
  cdp.on('Page.screencastFrame', (p) => {
    latest = {
      data: p.data,
      w: p.metadata.deviceWidth,
      h: p.metadata.deviceHeight,
      t: Date.now(),
    };
    dirty = true;
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', SCREENCAST_OPTIONS);
  return {
    tabId,
    page,
    poll() {
      if (!dirty) return null;
      dirty = false;
      return latest;
    },
    async close() {
      try { await cdp.send('Page.stopScreencast'); } catch {}
      try { await cdp.detach(); } catch {}
    },
  };
}

/** 客户端帧坐标 → 页面视口坐标的比例：viewport 宽 / screencast 帧宽（DIP）。 */
function viewportScale(page, source) {
  const frameW = source?.latest?.w;
  if (!frameW) return 1;
  const vp = page.viewportSize?.();
  return vp && vp.width ? vp.width / frameW : 1;
}

export class WatchServer {
  constructor(manager, activity, listVisionModels, banner, updater) {
    this.manager = manager;
    /** 桌面操控活动跟踪（lib/desktop/activity.js）；缺省时横幅端点如实报告"不可用"。 */
    this.activity = activity ?? null;
    /** 列出宿主已添加且支持视觉的模型（注入的函数，避免本模块依赖 vision.js）。 */
    this.listVisionModels = listVisionModels ?? null;
    /**
     * 自更新控制器（lib/core/updater.js 的 createUpdateController）。
     * 注入而非直接 import，是为了让本模块的测试不必真的联网或换装插件。
     */
    this.updater = updater ?? null;
    /**
     * 桌面横幅控制器：{ info: () => ({overlay, theme}), theme: {bg,fg} }。
     * overlay=false 时客户端改挂网页内横幅（原生浮窗起不来的唯一合法回退）；
     * theme 是客户端 POST 回来的宿主主题色，原生浮窗要靠它跟随深/浅色。
     */
    this.banner = banner ?? null;
    this.frameSources = new Map(); // tabId -> source
    this.watchers = 0;
    /** 外部打开实现（测试可替换，避免真实拉起系统浏览器）。 */
    this.spawnExternal = defaultOpenExternal;
  }

  /** 输入回传：客户端坐标是帧设备空间（screencast metadata 的 DIP 宽高），
   *  按视口宽换算回页面坐标。默认 1280 视口下是恒等；自由尺寸（viewport 变宽变窄）后不再恒等。 */
  async relayInput(tabId, input) {
    const page = this.manager.get(tabId);
    const scale = viewportScale(page, this.frameSources.get(tabId));
    if (input.type === 'click') {
      await page.mouse.click(input.x * scale, input.y * scale, { button: input.button ?? 'left' });
    } else if (input.type === 'scroll') {
      await page.mouse.move(input.x * scale, input.y * scale);
      await page.mouse.wheel(0, (input.deltaY ?? 400));
    } else if (input.type === 'key') {
      await page.keyboard.press(input.key ?? 'Enter');
    } else {
      throw new Error(`未知输入类型 ${input.type}`);
    }
    return { ok: true };
  }

  attach(webServer) {
    return webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        // 浏览器信任栅栏：先过这道，再谈路由。见 requestGuardReason 的注释。
        const denied = requestGuardReason(req);
        if (denied) {
          writeJson(res, denied.status, { ok: false, error: denied.error, message: denied.message });
          return;
        }
        const url = new URL(req.url, 'http://local');
        const route = url.pathname.slice(PREFIX.length);
        try {
          if (req.method === 'GET' && route === '/tabs') {
            // loginActive 随队返回：登录窗口被手动关闭时客户端把横幅状态复位
            return writeJson(res, 200, { tabs: this.manager.listTabs(), loginActive: !!this.manager.loginActive });
          }
          if (req.method === 'GET' && route === '/activity') {
            // 顶部横幅的数据源：Agent 正在操控本机桌面时 active=true。
            // 独立端点（不进 /tabs）：横幅要常驻轮询，不能和面板的刷新节奏绑在一起。
            const info = this.banner?.info?.() ?? {};
            return writeJson(res, 200, {
              ok: true,
              available: this.activity !== null,
              overlay: info.overlay === true,
              theme: this.banner?.theme ?? { bg: '', fg: '' },
              ...(this.activity?.snapshot() ?? { active: false, running: false, tool: '', kind: '', since: 0, idleMs: null, graceMs: 0 }),
            });
          }
          if (req.method === 'POST' && route === '/activity-theme') {
            // 客户端把解析好的宿主主题色送上来，供原生置顶浮窗使用。
            // 只接受 #RGB/#RRGGBB/#AARRGGBB，其余一律丢弃——非法值会让浮窗崩掉，
            // 而崩掉的浮窗等于"以为在提示、其实没提示"，比颜色不准严重得多。
            const body = await readBody(req);
            const pick = (v) => (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim()) ? v.trim() : '');
            const target = this.banner?.theme;
            if (target !== null && target !== undefined) {
              target.bg = pick(body?.bg);
              target.fg = pick(body?.fg);
              return writeJson(res, 200, { ok: true, theme: { ...target } });
            }
            return writeJson(res, 200, { ok: false, error: '桌面横幅不可用：主题色无处落地' });
          }
          if (req.method === 'GET' && route === '/vision-models') {
            // 设置页「视觉模型」下拉的选项来源：宿主已添加且声明吃图片的模型。
            // 宿主没有 llm 服务时如实报不可用，不给用户一个永远空着的下拉还假装正常。
            const models = this.listVisionModels === null ? null : await this.listVisionModels();
            return writeJson(res, 200, { ok: true, available: models !== null, models: models ?? [] });
          }
          if (req.method === 'GET' && route === '/update') {
            // 设置页「版本与更新」卡片的轮询端点：更新是长作业（下载+解包+换装），
            // 客户端在这里轮询阶段。控制器缺省时如实报不可用，不假装"已是最新"。
            if (this.updater === null) {
              return writeJson(res, 200, { ok: false, available: false, error: '自更新控制器未就绪' });
            }
            return writeJson(res, 200, { ok: true, available: true, ...this.updater.snapshot() });
          }
          if (req.method === 'POST' && route === '/update') {
            const body = await readBody(req);
            if (this.updater === null) {
              return writeJson(res, 200, { ok: false, available: false, error: '自更新控制器未就绪' });
            }
            // check await 到结束（~1s，一次请求拿结论）；apply 立即返回、由客户端轮询 GET /update。
            if (body?.action === 'apply') {
              return writeJson(res, 200, { ok: true, available: true, ...this.updater.startApply() });
            }
            if (body?.action === 'check') {
              return writeJson(res, 200, { ok: true, available: true, ...(await this.updater.check({ force: body?.force === true })) });
            }
            return writeJson(res, 400, { error: 'action 必须是 check 或 apply' });
          }
          // 原先这里有 GET/POST /host-accessibility 两条路由（写宿主快捷方式的无障碍旗标）。
          // 2026-10-03 整条功能下线：插件**不修改任何应用或宿主的启动配置**。实测三条理由：
          //   1. 旗标在现代 Chromium 上已无效——playwright chromium 实测 102 vs 103 元素（噪声）；
          //   2. SPI_SETSCREENREADER 那条替代路是**一次性闩锁**，关不掉（关后仍 159 元素，
          //      而"从未开启"时只有 13），等于用完就永久生效，反而违背"按需"；
          //   3. 覆盖不全且会留残留：只改 .lnk 覆盖不到"开始菜单搜索/宿主自重启"等入口，
          //      安装器若新建快捷方式就会出现两个。
          // Electron 应用改走 x_desktop_tree 的 degraded 标记 + x_desktop_shot /
          // x_desktop_click_at 兜底（PrintWindow 窗口级截图，不受遮挡影响）。
          if (req.method === 'GET' && route === '/stream') {
            const tabId = url.searchParams.get('tab');
            const source = this.frameSources.get(tabId) ?? (await createFrameSource(this.manager, tabId));
            this.frameSources.set(tabId, source);
            this.watchers += 1;
            // 面板在看着：持有期间禁止空闲回收，否则画面会在用户眼前断掉。
            this.manager.hold?.();
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            const timer = setInterval(() => {
              const frame = source.poll();
              if (frame) res.write(`data: ${JSON.stringify(frame)}\n\n`);
              else res.write(': ping\n\n');
            }, 120);
            req.on('close', () => {
              clearInterval(timer);
              this.watchers -= 1;
              this.manager.release?.();
              if (this.watchers <= 0) {
                for (const [id, s] of this.frameSources) {
                  s.close();
                  this.frameSources.delete(id);
                }
                this.watchers = 0;
              }
            });
            return;
          }
          if (req.method === 'POST' && route === '/input') {
            const input = await readBody(req);
            return writeJson(res, 200, await this.relayInput(input.tab, input));
          }
          if (req.method === 'POST' && route === '/viewport') {
            const body = await readBody(req);
            const size = await this.manager.setViewport(body.tab, body.width, body.height);
            return writeJson(res, 200, { ok: true, ...size });
          }
          if (req.method === 'POST' && route === '/pick') {
            const body = await readBody(req);
            const page = this.manager.get(this.manager.requireTabId(body.tab));
            const scale = viewportScale(page, this.frameSources.get(body.tab));
            const picked = await this.manager.pick(body.tab, body.x * scale, body.y * scale);
            return writeJson(res, 200, picked);
          }
          if (req.method === 'POST' && route === '/hover') {
            const body = await readBody(req);
            const page = this.manager.get(this.manager.requireTabId(body.tab));
            const scale = viewportScale(page, this.frameSources.get(body.tab));
            return writeJson(res, 200, await this.manager.highlightAt(body.tab, body.x * scale, body.y * scale));
          }
          if (req.method === 'POST' && route === '/pick-start') {
            const body = await readBody(req);
            return writeJson(res, 200, await this.manager.startPickMode(this.manager.requireTabId(body.tab)));
          }
          if (req.method === 'POST' && route === '/pick-stop') {
            const body = await readBody(req);
            return writeJson(res, 200, await this.manager.stopPickMode(this.manager.requireTabId(body.tab)));
          }
          if (req.method === 'POST' && route === '/close-tab') {
            const body = await readBody(req);
            return writeJson(res, 200, await this.manager.close(this.manager.requireTabId(body.tab)));
          }
          if (req.method === 'POST' && route === '/login-window') {
            const body = await readBody(req);
            const tab = await this.manager.openLoginWindow(body.url);
            return writeJson(res, 200, { ok: true, tab });
          }
          if (req.method === 'POST' && route === '/login-done') {
            const body = await readBody(req);
            return writeJson(res, 200, await this.manager.finishLogin(body.url));
          }
          if (req.method === 'POST' && route === '/navigate') {
            const body = await readBody(req);
            if (typeof body.url !== 'string' || !body.url) {
              return writeJson(res, 400, { error: '缺少 url' });
            }
            const tab = body.tab
              ? await this.manager.navigate(body.tab, body.url)
              : await this.manager.open(body.url);
            return writeJson(res, 200, { ok: true, tab });
          }
          if (req.method === 'POST' && route === '/nav') {
            const body = await readBody(req);
            const tab = await this.manager.history(body.tab, body.action);
            return writeJson(res, 200, { ok: true, tab });
          }
          if (req.method === 'POST' && route === '/open-external') {
            const body = await readBody(req);
            const page = this.manager.get(this.manager.requireTabId(body.tab));
            const opened = await this.spawnExternal(page.url());
            return writeJson(res, 200, { ok: true, url: opened });
          }
          if (req.method === 'POST' && route === '/clear-data') {
            const body = await readBody(req);
            return writeJson(res, 200, await this.manager.clearData(body.mode === 'all' ? 'all' : 'cache'));
          }
          // 原先这里有 GET/POST /config 两条路由（写 ~/.dsh/cache/dsh-control-x/config.json）。
          // 2026-10-02 删除：它们是**死代码**——设置页走宿主 configForms（lib/client.js 末尾
          // ctx.inject(['configForms'])），从来不发这两个请求；而 apply() 里的 pick() 因为
          // cordis resolveConfig 会把每个声明字段都填成 volatile Ref，fileOverrides 分支
          // 永远不可达（实测见 CHANGELOG 0.5.18）。留着等于一个无鉴权、可写任意键的
          // 任意内容写入口（POST 那条还自己读 body、不受上限约束），删掉零代价。
          writeJson(res, 404, { error: 'not found' });
        } catch (err) {
          if (!res.headersSent) writeJson(res, 500, { error: String(err?.message ?? err).slice(0, 300) });
        }
      },
    });
  }
}
