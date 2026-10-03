/**
 * 操控活动跟踪 + /activity 路由（顶部横幅的数据源）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker, withActivity, DEFAULT_GRACE_MS } from '../lib/desktop/activity.js';
import { WatchServer } from '../lib/browser/watch.js';

test('onBegin 钩子：动作开始时触发，且触发时快照已经是"活跃"（横幅第一帧就要画得出）', () => {
  // 横幅浮窗靠这个钩子按需拉起。若在 begin() 里先调钩子、后更新状态，
  // 浮窗起来读到的第一帧会是"空闲"，用户看不到本次动作的横幅。
  let t = 0;
  const seen = [];
  let activeAtHook = null;
  const act = createActivityTracker({
    now: () => t,
    onBegin: (tool, kind) => {
      activeAtHook = act.snapshot().active;
      seen.push([tool, kind]);
    },
  });
  act.begin('x_browser_open', 'browser');
  assert.deepEqual(seen, [['x_browser_open', 'browser']], '工具名与活动种类要传给订阅者');
  assert.equal(activeAtHook, true, '钩子触发时快照必须已经是 active');
  assert.equal(act.snapshot().tool, 'x_browser_open');

  act.end('x_browser_open');
  act.begin('x_desktop_press', 'desktop');
  assert.deepEqual(seen[1], ['x_desktop_press', 'desktop']);
  assert.equal(act.snapshot().kind, 'desktop');
});

test('没有 onBegin 时行为不变（订阅是可选的）', () => {
  let t = 1000;
  const act = createActivityTracker({ now: () => t });
  act.begin('x_desktop_press', 'desktop');
  t += 10;
  act.end('x_desktop_press');
  assert.equal(act.snapshot().active, true, '仍在宽限期内');
  assert.equal(act.snapshot().kind, 'desktop');
});

test('活动跟踪：宽限期内保持 active，过期后自动撤销', () => {
  let t = 1000;
  const act = createActivityTracker({ now: () => t });
  assert.equal(act.snapshot().active, false, '从未动作时不应显示横幅');

  act.begin('x_desktop_press');
  assert.equal(act.snapshot().active, true);
  assert.equal(act.snapshot().tool, 'x_desktop_press');
  assert.equal(act.snapshot().running, true);

  act.end('x_desktop_press');
  assert.equal(act.snapshot().running, false);
  assert.equal(act.snapshot().active, true, '动作刚结束仍在宽限期内');

  t += DEFAULT_GRACE_MS + 1;
  assert.equal(act.snapshot().active, false, '超过宽限期后横幅必须撤掉');
  assert.equal(act.snapshot().tool, '');
});

test('活动跟踪：连续动作之间不闪断（后一次动作续上宽限期）', () => {
  let t = 0;
  const act = createActivityTracker({ graceMs: 100, now: () => t });
  act.begin('a'); act.end('a');
  t += 80;                        // 还在宽限期内
  act.begin('b');
  assert.equal(act.snapshot().active, true);
  assert.equal(act.snapshot().tool, 'b', '显示的是最近一次动作');
  act.end('b');
  t += 80;
  assert.equal(act.snapshot().active, true);
  t += 80;
  assert.equal(act.snapshot().active, false);
});

test('withActivity：抛错的工具也必须收尾（否则横幅永久钉在屏幕上）', async () => {
  const act = createActivityTracker();
  const boom = { name: 'x_demo', execute: async () => { throw new Error('boom'); } };
  const [wrapped] = withActivity([boom], act);
  await assert.rejects(() => wrapped.execute({}, {}), /boom/);
  assert.equal(act.snapshot().running, false, '失败后 in-flight 必须归零');
  assert.equal(act.snapshot().active, true, '失败瞬间仍在宽限期内（诚实告知刚刚动过）');
});

test('withActivity：filter 之外的工具不计入（浏览器面不该触发桌面横幅）', async () => {
  const act = createActivityTracker();
  const [kept] = withActivity([{ name: 'x_desktop_apps', execute: async () => ({ ok: true }) }], act,
    { filter: (name) => name.startsWith('x_desktop_') });
  await kept.execute({}, {});
  assert.equal(act.snapshot().tool, 'x_desktop_apps');

  const act2 = createActivityTracker();
  const [skipped] = withActivity([{ name: 'x_browser_open', execute: async () => ({ ok: true }) }], act2,
    { filter: (name) => name.startsWith('x_desktop_') });
  await skipped.execute({}, {});
  assert.equal(act2.snapshot().active, false, '浏览器动作不得触发桌面横幅');
});

test('GET /activity 返回活动快照；无 tracker 时如实报不可用而不是假装空闲', async () => {
  const { callRoute } = await import('./helpers.mjs');
  const act = createActivityTracker();
  act.begin('x_desktop_tree');
  let route = null;
  new WatchServer({ listTabs: () => [] }, act).attach({ register: (r) => { route = r; } });

  const live = (await callRoute(route, 'GET', '/activity')).json;
  assert.equal(live.ok, true);
  assert.equal(live.available, true);
  assert.equal(live.active, true);
  assert.equal(live.tool, 'x_desktop_tree');

  let route2 = null;
  new WatchServer({ listTabs: () => [] }).attach({ register: (r) => { route2 = r; } });
  const bare = (await callRoute(route2, 'GET', '/activity')).json;
  assert.equal(bare.available, false, '没有 tracker 时必须自报不可用，客户端据此隐藏横幅');
  assert.equal(bare.active, false);
});

test('POST /activity-theme：rgb() 必须折算成 #RRGGBB，解析不了就一个字节都不动', async () => {
  // 2026-10-03 用户实测「桌面横幅不随宿主主题变化」。根因在宿主样式表原文
  // （从 app.asar 抽出核实）：
  //     --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  //     --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  // 客户端 getComputedStyle 取回的就是 `rgb(15, 17, 21)`，而本路由只收 #hex →
  // **静默丢弃** → bannerTheme 永远是空串 → 浮窗停在默认深色。丢弃就是故障本身。
  const { callRoute } = await import('./helpers.mjs');
  const banner = { theme: { bg: '', fg: '' }, info: () => ({ overlay: false }) };
  let route = null;
  new WatchServer({ listTabs: () => [] }, null, null, banner)
    .attach({ register: (r) => { route = r; } });

  const ok = await callRoute(route, 'POST', '/activity-theme', {
    bg: 'rgb(15, 17, 21)', fg: 'rgb(249, 250, 251)',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(banner.theme, { bg: '#0f1115', fg: '#f9fafb' },
    '宿主 CSS 的原文写法必须被折算成 #RRGGBB，否则等于把主题色丢掉');

  const alpha = await callRoute(route, 'POST', '/activity-theme', {
    bg: '#800f1115', fg: '#ffF9FAFB',
  });
  assert.equal(alpha.status, 200);
  assert.deepEqual(banner.theme, { bg: '#0f1115', fg: '#f9fafb' },
    '不透明 #AARRGGBB 折算成 6 位；半透明浮窗画不了，保留上一次的真值而不是清成默认色');

  const junk = await callRoute(route, 'POST', '/activity-theme', {
    bg: 'light-dark(#fff, #000)', fg: 'var(--whatever)',
  });
  assert.equal(junk.status, 200);
  assert.deepEqual(banner.theme, { bg: '#0f1115', fg: '#f9fafb' },
    '解析不了的老实不动（保留上一次的真值）——静默清空正是这次的故障形态');
});
