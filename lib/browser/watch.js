/**
 * 面板服务端：webServer 路由（kind:"prefix"，ego lib/index.js:2032 同款形状）。
 *
 * 路由（前缀 /api/x-control/）：
 *   GET  /tabs    当前标签页 JSON
 *   GET  /stream?tab=<id>   SSE：CDP Page.startScreencast JPEG 帧 + 心跳；
 *                           帧带设备宽高，客户端据此做点击坐标缩放。
 *   POST /input   {tab,type:'click'|'scroll'|'key',...} 输入回传（playwright 鼠标/键盘）
 *   POST /navigate {tab?,url} 面板地址栏导航：有 tab 原地跳，无 tab 新开
 *   POST /nav     {tab,action:'back'|'forward'|'reload'} 工具栏历史导航
 *   POST /open-external {tab} 在系统默认浏览器打开当前页
 *   POST /clear-data {mode:'cache'|'all'} 设置页「浏览器数据」清除
 *   GET/POST /config  用户级配置覆盖（~/.dsh/cache/dsh-control-x/config.json）
 *
 * 推流生命周期：SSE 订阅计数归零即停 screencast（对齐 ego 的 watcher lease 思路）。
 */
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PREFIX = '/api/x-control';
const CONFIG_PATH = join(homedir(), '.dsh', 'cache', 'dsh-control-x', 'config.json');

export function readConfigOverrides() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfigOverrides(patch) {
  const next = { ...readConfigOverrides(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
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

export class WatchServer {
  constructor(manager, applyConfig) {
    this.manager = manager;
    this.applyConfig = applyConfig ?? (() => {});
    this.frameSources = new Map(); // tabId -> source
    this.watchers = 0;
    /** 外部打开实现（测试可替换，避免真实拉起系统浏览器）。 */
    this.spawnExternal = defaultOpenExternal;
  }

  /** 输入回传：面板所见坐标按帧设备宽高换算为视口坐标。 */
  async relayInput(tabId, input) {
    const page = this.manager.get(tabId);
    const source = this.frameSources.get(tabId);
    const scale = source?.latest ? source.latest.w / 1280 : 1; // maxWidth 1280
    if (input.type === 'click') {
      await page.mouse.click(input.x / scale, input.y / scale, { button: input.button ?? 'left' });
    } else if (input.type === 'scroll') {
      await page.mouse.move(input.x / scale, input.y / scale);
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
        const url = new URL(req.url, 'http://local');
        const route = url.pathname.slice(PREFIX.length);
        try {
          if (req.method === 'GET' && route === '/tabs') {
            return writeJson(res, 200, { tabs: this.manager.listTabs() });
          }
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
          if (req.method === 'GET' && route === '/config') {
            return writeJson(res, 200, readConfigOverrides());
          }
          if (req.method === 'POST' && route === '/config') {
            let body = '';
            for await (const chunk of req) body += chunk;
            const next = writeConfigOverrides(JSON.parse(body));
            this.applyConfig(next);
            return writeJson(res, 200, next);
          }
          writeJson(res, 404, { error: 'not found' });
        } catch (err) {
          if (!res.headersSent) writeJson(res, 500, { error: String(err?.message ?? err).slice(0, 300) });
        }
      },
    });
  }
}
