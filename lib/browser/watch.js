/**
 * 面板服务端：webServer 路由（kind:"prefix"，ego lib/index.js:2032 同款形状）。
 *
 * 路由（前缀 /api/x-control/）：
 *   GET  /tabs    当前标签页 JSON
 *   GET  /stream?tab=<id>   SSE：CDP Page.startScreencast JPEG 帧 + 心跳；
 *                           帧带设备宽高，客户端据此做点击坐标缩放。
 *   POST /input   {tab,type:'click'|'scroll'|'key',...} 输入回传（playwright 鼠标/键盘）
 *   GET/POST /config  用户级配置覆盖（~/.dsh/cache/dsh-control-x/config.json）
 *
 * 推流生命周期：SSE 订阅计数归零即停 screencast（对齐 ego 的 watcher lease 思路）。
 */
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 1 });
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
            let body = '';
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            return writeJson(res, 200, await this.relayInput(input.tab, input));
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
