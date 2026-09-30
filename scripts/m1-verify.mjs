/**
 * M1 闭环验收：模拟模型的工具调用序列，验证 x_browser_* 全链路。
 *
 * 场景：打开必应 → 语义快照定位搜索框 → 填入关键词 → 回车提交 → 等待结果页 →
 * 读取结果快照 → 截图（stub 附件服务落盘取证）。
 * 验收：全部步骤走工具 execute（与宿主内完全一致的代码路径）、零可见窗口（headless）。
 */
import { writeFileSync, statSync } from 'node:fs';
import { apply } from '../lib/index.js';
import { shutdownBrowser } from '../lib/browser/tools.js';

/** 附件服务 stub：把图片写到固定路径，返回与宿主 attachments.saveImage 相同形状的 ref。 */
const SHOT_PATH = new URL('./m1-shot.jpg', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const stubAttachments = {
  imageLimits: { maxImageBytes: 5 * 1024 * 1024 },
  async saveImage({ data, mediaType, name }) {
    writeFileSync(SHOT_PATH, data);
    return { attachmentId: 'stub-1', mediaType, bytes: data.byteLength, name };
  },
};

// 走真实注册路径（apply），确保验证的就是宿主将注册的工具集
const registered = new Map();
const mockCtx = {
  tools: { register: (t) => registered.set(t.name, t) },
  get: (name) => (name === 'attachments' ? stubAttachments : undefined),
  logger: { info() {}, warn() {} },
};
apply(mockCtx, { headless: true });
const tools = registered;

let step = 0;
async function call(name, args) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  const started = Date.now();
  const value = await tool.execute(args ?? {}, { signal: AbortSignal.timeout(60000) });
  console.log(`[${++step}] ${name} (${Date.now() - started}ms)`);
  return value;
}

function assert(cond, message) {
  if (!cond) throw new Error(`验收失败: ${message}`);
  console.log(`  ✔ ${message}`);
}

// ── 闭环 ──
await call('x_activate');
const status = await call('x_status');
assert(status.activated === true, 'x_status 报告已激活');

const tabs0 = await call('x_browser_tabs');
assert(tabs0.tabs.length === 0, '懒启动：未调用 open 前没有标签页');

const opened = await call('x_browser_open', { url: 'https://www.bing.com' });
console.log('  open 结果:', JSON.stringify(opened.tab));
assert(/bing\.com$/.test(new URL(opened.tab.url).hostname), `打开必应（实际落到 ${new URL(opened.tab.url).hostname}，中国区会重定向 cn.bing.com）`);
const tabId = opened.tab.id;

// 同站复用：以观察到的实际 URL（重定向后的 cn.bing.com）再 open 必须返回同一 id
const reopened = await call('x_browser_open', { url: `${opened.tab.url}?to=about` });
assert(reopened.tab.id === tabId, `同站复用（${reopened.tab.id} === ${tabId}）`);

const page = await call('x_browser_read', { tab_id: tabId });
assert(page.snapshot.length > 100, `语义快照可读（${page.snapshot.length} 字符）`);

// 从快照事实中提取搜索框的角色与可访问名称（快照 → 定位，符合工具教学）
const boxMatch = page.snapshot.match(/- (textbox|searchbox) "([^"]+)"/);
assert(boxMatch, '快照中找到搜索框（textbox/searchbox 角色）');
const boxRole = boxMatch[1];
const boxName = boxMatch[2];
console.log(`  搜索框: role=${boxRole} name=${JSON.stringify(boxName)}`);

await call('x_browser_fill', { tab_id: tabId, role: boxRole, name: boxName, exact: true, value: 'DeepSeek Harness' });
await call('x_browser_press', { tab_id: tabId, key: 'Enter' });
const results = await call('x_browser_wait', { tab_id: tabId, url: '**/search**', ms: 1500 });
assert(/\/search/.test(results.tab.url), `提交后进入结果页（${results.tab.url}）`);

const resultPage = await call('x_browser_read', { tab_id: tabId });
assert(resultPage.snapshot.toLowerCase().includes('deepseek'), '结果页快照包含关键词内容');

const shot = await call('x_browser_shot', { tab_id: tabId });
assert(shot.image && shot.image.bytes > 8000, `截图并持久化（${shot.image.bytes} bytes）`);
const shotSize = statSync(SHOT_PATH).size;
assert(shotSize === shot.image.bytes, '落盘字节数与附件一致');

const tabs1 = await call('x_browser_tabs');
assert(tabs1.tabs.length === 1, `全程只有 1 个标签页（同站复用生效，未堆积）`);

await call('x_browser_close', { tab_id: tabId });
const tabs2 = await call('x_browser_tabs');
assert(tabs2.tabs.length === 0, '关闭后标签页账本清空');

await shutdownBrowser();
console.log(`\nM1 闭环验收通过：${step} 步全绿；截图：${SHOT_PATH}`);
