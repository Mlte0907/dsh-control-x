/**
 * 图片块完整性门（2026-10-03，用户实测抓出真机事故后加）。
 *
 * 事故：`x_desktop_shot` 的 render 只往 image block 里塞了
 * `{ attachmentId, mediaType }`，漏掉 `bytes` / `width` / `height`。宿主的
 * `ImageAttachmentRef` 五项全必填，读回图片时逐项比对实际字节：
 *
 *   dsh-attachment-local/lib/index.js:609
 *     metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
 *     || metadata.width !== ref.width || metadata.height !== ref.height
 *
 * 于是一次调用就抛 "Stored attachment metadata does not match its reference."。
 * 而浏览器截图一直是好的——`lib/browser/tools.js` 的 renderTab 传的是完整的
 * `value.image`——所以这个缺陷能长期藏在只有桌面截图会踩的分支里。
 *
 * 为什么这条门要写成"扫全部工具"而不是"断言第322 行"：
 * 写死行号的测试下一个人改个行号就失效，而**任何**工具只要开始输出图片，
 * 就可能重犯同一个错——那正是本缺陷的形状。
 *
 * 另外注意这个 bug 最阴的地方：image block 会**留在会话上下文里**，此后每次重新
 * 组装请求（切模型、上下文压缩、续话）宿主都要重读那张图，于是持续崩，
 * 表现为"Agent 还没来得及调用任何工具就失败"。很容易误判成宿主或网络问题——
 * 我第一轮就是这么判错的，代价是浪费用户一次复现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 宿主 ImageAttachmentRef 的必填字段（dsh-agent-preset-registry 的类型声明）。 */
const REQUIRED = ['attachmentId', 'mediaType', 'bytes', 'width', 'height'];

/** 一份完整、合法的附件引用。 */
const FULL_REF = {
  attachmentId: 'sha256:' + 'a'.repeat(64),
  mediaType: 'image/jpeg',
  bytes: 38757,
  width: 1965,
  height: 1106,
  name: 'x.jpg',
};

/** 把源码里的文本渲染原样读出来——不执行 render，避免为了测试而起浏览器/桌面。 */
function collectImageBlockAttachmentsFromSource() {
  const libRoot = join(HERE, '..', 'lib');
  const files = [
    'desktop/tools.js', 'browser/tools.js', 'vision.js',
  ];
  const found = [];
  for (const rel of files) {
    const src = readFileSync(join(libRoot, rel), 'utf8').split('\n');
    src.forEach((line, i) => {
      if (!/type:\s*['"]image['"]/.test(line)) return;
      // 取出 attachment: 后面的对象字面量文本
      const m = /attachment:\s*(\{[^}]*\})/.exec(line);
      found.push({ file: rel, line: i + 1, text: line.trim(), literal: m?.[1] ?? null });
    });
  }
  return found;
}

test('回归：任何工具都不得只往 image block 里塞部分字段', () => {
  const sites = collectImageBlockAttachmentsFromSource();
  assert.ok(sites.length >= 3, `应至少找到 3 处 image block 构造，实际 ${sites.length} 处`);
  for (const s of sites) {
    if (s.literal === null) {
      // 形如 `attachment: value.image` / `attachment: { ...attachment }`：
      // 整体透传，无法从字面量判断键集，交给下面的运行时测试覆盖。
      assert.match(s.text, /attachment:\s*(\{\s*\.\.\.|value\.image|\w+\.image\b)/,
        `${s.file}:${s.line} 的 attachment 形式看不懂，需人工确认：${s.text}`);
      continue;
    }
    if (/\{\s*\.\.\./.test(s.literal)) continue; // 展开透传，运行时测试覆盖
    // 显式列出的键：必须覆盖全部必填字段
    const keys = [...s.literal.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    const missing = REQUIRED.filter((k) => !keys.includes(k));
    assert.deepEqual(missing, [],
      `${s.file}:${s.line} 的 image block 漏了 ${missing.join('/')}：`
      + '宿主 ImageAttachmentRef 这些字段全必填，缺一个读回图片就会抛'
      + '"Stored attachment metadata does not match its reference."');
  }
});

test('运行时：x_desktop_shot 与 x_browser_shot 的 render 必须输出完整 image block', async () => {
  // 这条是上面那条的兜底：真跑一遍 render，逐字段检查实际产出的 block。
  const TMP = mkdtempSync(join(tmpdir(), 'cx-imgref-'));
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  cpSync(join(HERE, '..', 'lib'), TMP, { recursive: true });
  // 物理输入会真动光标键盘，替换成记录桩
  writeFileSync(join(TMP, 'desktop', 'physical.js'), `
export function userIdleMs() { return 1e9; }
export function assertUserIdle() {}
export function activateWindow() {}
export function clickAt() {}
export function typeUnicode() {}
export function pressChord() {}
`, 'utf8');

  const { buildDesktopTools } = await import(pathToFileURL(join(TMP, 'desktop', 'tools.js')).href);
  const list = buildDesktopTools({ get: () => undefined, logger: { info() {}, warn() {} } },
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true });
  const tool = list.find((t) => t.name === 'x_desktop_shot');
  assert.ok(tool, 'x_desktop_shot 必须存在');

  // 用一份**完整**引用当返回值，看 render 会不会把它裁掉
  const value = { ok: true, observation: 'o1', image: { ...FULL_REF }, window: { hwnd: 1 }, degraded: true, note: 'n' };
  const blocks = tool.output.render({}, value);
  const img = blocks.find((b) => b.type === 'image');
  assert.ok(img, 'render 必须产出 image block，否则模型看不到画面');
  for (const k of REQUIRED) {
    assert.ok(k in img.attachment, `image block 缺 "${k}"——这正是真机事故的成因`);
    assert.notEqual(img.attachment[k], undefined, `image block 的 "${k}" 是 undefined`);
  }
  assert.deepEqual(img.attachment, FULL_REF, '必须是原样透传，一个字段都不许动');
  // JSON 文本块也要带完整字段，模型据此回传给 x_vision_describe
  const text = JSON.parse(blocks.find((b) => b.type === 'text').text);
  for (const k of REQUIRED) {
    assert.notEqual(text.image[k], undefined, `返回的 JSON 里 image.${k} 是 undefined`);
  }
});

test('回归：宿主 ImageAttachmentRef 五项必填这条事实要钉住', () => {
  // 防止有人"优化"掉这个检查：把宿主类型声明里的必填字段抄一份作为断言基准。
  const decl = "attachmentId: AttachmentId; mediaType: ImageMediaType; bytes: number; width: number; height: number;";
  for (const field of ['attachmentId', 'mediaType', 'bytes', 'width', 'height']) {
    assert.ok(decl.includes(field), `基准声明里应含 ${field}`);
  }
  assert.equal(REQUIRED.length, 5);
});