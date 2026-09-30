/**
 * UI 验收：客户端 bundle 的官方 slot 注册 + 面板路由行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('client bundle 注册三个官方原生 slot', async () => {
  const handlers = new Map();
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { handlers.set(spec.id, spec.factory); },
    },
  };
  // 触发 client bundle 装载
  await import('../lib/client.js');
  const factory = handlers.get('dsh-control-x');
  assert.equal(typeof factory, 'function');
  // 模拟宿主 require：react 仅做 createElement stub，其他模块返回空对象
  const exports = factory((name) => {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
    return {};
  });
  assert.equal(exports.name, 'dsh-control-x');
  // inject 只能声明必然存在的基础服务；可选服务走 apply 内 ctx.inject（否则 cordis 永远等待）
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  const makeSlots = (into) => ({
    // 宿主接受两种形状：generator function（yield register）与箭头函数（直接返回 register）
    inject(slot, gen) {
      const out = typeof gen === 'function' ? (gen[Symbol.iterator] ? Array.from(gen()) : [gen()]) : [gen];
      for (const r of out) into.push({ slot, reg: r });
    },
    register(options, Component) { return { options, Component }; },
  });
  // configForms 缺失时必须静默跳过（不抛错），不注册任何东西
  const skipped = [];
  await exports.apply({ effect: (fn) => fn(), inject: (s, cb) => cb({}), slots: makeSlots(skipped) });
  assert.equal(skipped.length, 0, '可选服务缺失时不注册也不抛错');
  // configForms 存在 → 注册设置页配置区（settings.section，先例 dsh-pangu/agent-presets）
  const settingsRegs = [];
  const fakeForm = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { headless: true, ttlMs: 30000 } }),
    subscribe: () => () => {},
    set: async () => {},
  };
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('configForms')) {
        cb({
          configForms: { get: () => fakeForm, whileServed: (namespaces, fn) => fn() },
          effect: (fn) => fn(),
          slots: makeSlots(settingsRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.equal(settingsRegs.length, 2, 'settings.section + conversation.input.left');
  const section = settingsRegs.find((r) => r.slot === 'settings.section');
  assert.ok(section, '设置页 section 已注册');
  assert.equal(section.reg.options.id, 'control-x');
  assert.equal(section.reg.options.label(), 'X-Agent操控', '设置导航栏标题');
  assert.equal(typeof section.reg.options.inject, 'function', 'configFace 注入（配置读写）');
  assert.equal(typeof section.reg.Component, 'function');
  const face = section.reg.options.inject();
  assert.equal(typeof face.set, 'function', 'face.set 暴露写通道');
  assert.equal(typeof face.hooks.cxSettings.subscribe, 'function', 'face.hooks.cxSettings 是 store');
  // 按钮必须落在 composer 工具行左侧（input.left），不是 composer 卡内的浮层锚点（overlay）——
  // 后者是斜杠菜单/命令弹窗的地盘，行内按钮会悬在占位文字上。
  const inputBtn = settingsRegs.find((r) => r.slot === 'conversation.input.left');
  assert.ok(inputBtn, '按钮注册在 conversation.input.left');
  assert.equal(settingsRegs.some((r) => r.slot === 'conversation.input.overlay'), false,
    '不得占用 overlay 浮层槽位');
  assert.equal(inputBtn.reg.options.id, 'control-x', '输入框按钮 seat');
  assert.equal(typeof inputBtn.reg.Component, 'function', '输入框按钮组件');
  // sidebarRightTabs 存在 → 注册侧边栏入口 + 面板
  const sideRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => { if (services.includes('sidebarRightTabs')) cb({ sidebarRightTabs: {}, slots: makeSlots(sideRegs) }); },
    slots: makeSlots([]),
  });
  const slots = sideRegs.map((r) => r.slot).sort();
  assert.deepEqual(slots, ['shell.overlay', 'sidebar.footer.action']);
  const entry = sideRegs.find((r) => r.slot === 'sidebar.footer.action');
  assert.equal(entry.reg.options.id, 'control-x');
  assert.equal(typeof entry.reg.Component, 'function', '侧边栏入口组件');
  const overlay = sideRegs.find((r) => r.slot === 'shell.overlay');
  assert.equal(typeof overlay.reg.Component, 'function', '面板内容组件');
  // sidebarRightTabs 带 register → 注册右侧栏 tab（不再注册 footer/overlay）
  const rightRegs = [];
  const tabDefs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('sidebarRightTabs')) {
        cb({
          sidebarRightTabs: { register: (def) => { tabDefs.push(def); return () => {}; } },
          slots: makeSlots(rightRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.equal(tabDefs.length, 1, 'tab 类型注册一次');
  assert.equal(tabDefs[0].id, 'dsh-control-x');
  assert.equal(tabDefs[0].kind, 'dsh-control-x');
  assert.equal(typeof tabDefs[0].title, 'function', 'chip 标题是取值函数');
  assert.equal(tabDefs[0].title(), 'X-Agent浏览器', '右侧栏 chip 标题');
  assert.equal(tabDefs[0].guide.length, 1, '引导页入口一枚');
  assert.equal(tabDefs[0].guide[0].title(), 'X-Agent浏览器', '引导页入口标题');
  assert.equal(typeof tabDefs[0].guide[0].icon, 'function', '引导入口图标组件');
  const rightSlots = rightRegs.map((r) => r.slot).sort();
  assert.deepEqual(rightSlots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  const body = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab');
  assert.equal(body.reg.options.key, 'dsh-control-x', '正文 seat 按 tab id keyed');
  assert.equal(typeof body.reg.Component, 'function', 'tab 正文组件');
  assert.equal(typeof body.reg.options.inject, 'function', '正文可读设置 face（关闭横幅/按钮显隐）');
  const title = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab.title');
  assert.equal(title.reg.options.key, 'dsh-control-x');
  // register 抛错（热重放重复注册）→ 视为已就位：仍补 seat，绝不回退 footer/overlay
  const replayRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('sidebarRightTabs')) {
        cb({
          sidebarRightTabs: { register: () => { throw new Error('duplicate id'); } },
          slots: makeSlots(replayRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.deepEqual(replayRegs.map((r) => r.slot).sort(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    '重复注册时仍补 seat，不产生 footer/overlay 双入口');
  delete globalThis.window;
});

test('性能契约：面板不可见即停流 + CDP 出帧节流', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // 面板由宿主侧栏承载，不可见时组件仍挂载：不门控就会出现无人观看仍在推流的空转。
  assert.match(src, /IntersectionObserver/, '用 IntersectionObserver 判定面板可见性');
  assert.match(src, /ref: rootRef/, '可见性观察锚点挂在面板根节点');
  assert.match(src, /\[selected, live\]/, '帧流订阅随可见性重建（不可见即 close）');
  assert.match(src, /\[live\]/, '标签页轮询随可见性启停');

  const { SCREENCAST_OPTIONS } = await import('../lib/browser/watch.js');
  assert.ok(SCREENCAST_OPTIONS.everyNthFrame >= 2,
    '服务端 120ms 才取一帧，源侧不必逐帧编码 JPEG');
  assert.ok(SCREENCAST_OPTIONS.maxWidth <= 1280, '推流宽度受限');
  assert.equal(SCREENCAST_OPTIONS.format, 'jpeg');
});

test('工具栏对齐 ZCode：同款 lucide 图标 + 自由尺寸/元素选择/更多菜单', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // ZCode 浏览器面板的图标（lucide SVG 路径原文，取自其 renderer 分包）
  assert.match(src, /m15 18-6-6 6-6/, '后退 = chevron-left');
  assert.match(src, /m9 18 6-6-6-6/, '前进 = chevron-right');
  assert.match(src, /M21 12a9 9 0 0 1-9 9 9\.75 9\.75 0 0 1-6\.74-2\.74L3 16/, '刷新 = refresh-cw');
  assert.match(src, /M10 19v-3\.96 3\.15/, '自由尺寸 = monitor-smartphone');
  assert.match(src, /M9\.037 9\.69a\.498\.498 0 0 1 \.653-\.653l11 4\.5/, '元素选择 = mouse-pointer-click');
  assert.match(src, /cx: "19", cy: "12", r: "1"/, '更多 = ellipsis');
  assert.match(src, /M18 13v6a2 2 0 0 1-2 2H5/, '外部打开 = external-link（在 ⋯ 菜单内）');
  // 文案与行为
  assert.match(src, /在默认浏览器中打开/, '菜单项：在默认浏览器中打开');
  assert.doesNotMatch(src, /打开调试工具/, '按需求移除「打开调试工具」菜单项');
  assert.match(src, /更多浏览器操作/, '菜单触发器 title');
  assert.match(src, /自由尺寸/, '自由尺寸 toggle');
  assert.match(src, /选择网页元素/, '元素选择 toggle');
  // 本轮新增：登录横幅 / 标签 × / 尺寸栏（W×H+缩放）/ 元素加入聊天
  assert.match(src, /弹出登录窗口/, '登录横幅：弹出登录窗口');
  assert.match(src, /已登录，保存/, '登录横幅：已登录，保存');
  assert.match(src, /background: "#4a7dff"/, '横幅按钮用写死品牌色（主题变量在本机解析成白色，白底白字不可见）');
  assert.match(src, /\/login-window/, '登录窗口路由调用');
  assert.match(src, /\/login-done/, '保存登录路由调用');
  assert.match(src, /\/close-tab/, '标签 × 关闭路由调用');
  assert.match(src, /title: "关闭标签页"/, '标签 chip 带 × 按钮');
  assert.match(src, /M18 6 6 18/, '关闭/收起用 lucide X 图标（不用字体字符）');
  assert.doesNotMatch(src, /预设 ∨/, '尺寸栏不再有自定义 ∨ 与原生箭头重复');
  assert.match(src, /自适应窗口/, '缩放下拉：自适应窗口');
  assert.match(src, /value: "1\.5"/, '缩放档位含 150%');
  assert.match(src, /maxWidth: "none"/, '缩放后画面可超出容器宽度（滚动查看）');
  assert.match(src, /margin: "-8px -10px 0"/, '尺寸栏通栏贴条：顶边贴住地址栏');
  assert.match(src, /justifyContent: "center",\n?\s*margin: "-8px/, '尺寸栏内容居中');
  assert.match(src, /loginActive === false/, '登录窗口被手动关闭时横幅状态随轮询复位');
  assert.match(src, /appendToComposer/, '选元结果写入会话输入框（加入聊天）');
  assert.match(src, /已加入聊天/, '选元反馈：已加入聊天');
  assert.match(src, /onMouseMove/, '选元模式悬停高亮（mousemove → /hover）');
  assert.match(src, /\/hover/, '悬停高亮路由调用');
  // 按键输入行按需求移除
  assert.doesNotMatch(src, /按键，如 Enter \/ Control\+a/, '底部按键输入行已移除');
  assert.match(src, /conversation\.input\.overlay/, '注释里保留 overlay 槽位的坑位说明');
});

test('watch 路由：GET /tabs 与 GET /config', async () => {
  const { WatchServer } = await import('../lib/browser/watch.js');
  const fakeManager = {
    listTabs: () => [{ id: 't1', url: 'https://x/', title: 'X' }],
    get: () => ({ url: () => 'https://x/' }),
    requireTabId: (hint) => hint ?? 't1',
    navigate: async (tab, url) => ({ id: tab, url, title: 'N' }),
    open: async (url) => ({ id: 't1', url, title: 'O' }),
    history: async (tab, action) => ({ id: tab, url: 'https://x/', title: action }),
    clearData: async (mode) => ({ ok: true, mode, cleared: ['cache'] }),
    setViewport: async (tab, width, height) => ({ id: tab, width, height }),
    pick: async (tab, x, y) => ({ selector: '#main', tag: 'div', x, y, text: 'X' }),
    highlightAt: async () => ({ ok: true }),
    startPickMode: async () => ({ ok: true }),
    stopPickMode: async () => ({ ok: true }),
    close: async (tab) => ({ closed: tab }),
    openLoginWindow: async (url) => ({ id: 't1', url, title: 'L' }),
    finishLogin: async (url) => ({ ok: true, saved: true, tab: { id: 't1', url: url ?? 'https://x/' } }),
  };
  const ws = new WatchServer(fakeManager);
  let route = null;
  ws.attach({ register: (r) => { route = r; } });
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/api/x-control');
  function fakeRes() {
    return { headersSent: false, status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  }
  async function request(method, path, body) {
    const res = fakeRes();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: 'http://local/api/x-control' + path,
      on() {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload; },
    };
    await route.handler(req, res);
    return res;
  }
  const res1 = await request('GET', '/tabs');
  assert.deepEqual(JSON.parse(res1.body), { tabs: [{ id: 't1', url: 'https://x/', title: 'X' }], loginActive: false });
  const res2 = await request('GET', '/config');
  assert.equal(res2.status, 200);
  // 地址栏导航：有 tab 原地跳，无 tab 新开
  const nav1 = JSON.parse((await request('POST', '/navigate', { tab: 't1', url: 'https://y/' })).body);
  assert.equal(nav1.ok, true);
  assert.equal(nav1.tab.url, 'https://y/');
  const nav2 = JSON.parse((await request('POST', '/navigate', { url: 'https://z/' })).body);
  assert.equal(nav2.tab.url, 'https://z/');
  const navBad = await request('POST', '/navigate', {});
  assert.equal(navBad.status, 400, '缺 url 返回 400');
  // 工具栏历史导航
  const hist = JSON.parse((await request('POST', '/nav', { tab: 't1', action: 'back' })).body);
  assert.equal(hist.ok, true);
  assert.equal(hist.tab.title, 'back');
  // 在默认浏览器打开（stub 掉真实拉起）
  ws.spawnExternal = async (u) => u;
  const ext = JSON.parse((await request('POST', '/open-external', { tab: 't1' })).body);
  assert.equal(ext.ok, true);
  assert.equal(ext.url, 'https://x/');
  // 清除浏览器数据
  const clear = JSON.parse((await request('POST', '/clear-data', { mode: 'all' })).body);
  assert.equal(clear.ok, true);
  assert.equal(clear.mode, 'all');
  // 自由尺寸视口
  const vp = JSON.parse((await request('POST', '/viewport', { tab: 't1', width: 410, height: 256 })).body);
  assert.equal(vp.ok, true);
  assert.equal(vp.width, 410);
  assert.equal(vp.height, 256);
  // 元素选择
  const picked = JSON.parse((await request('POST', '/pick', { tab: 't1', x: 30, y: 40 })).body);
  assert.equal(picked.selector, '#main');
  assert.equal(picked.tag, 'div');
  // 悬停高亮 / 选元模式生命周期
  const hov = JSON.parse((await request('POST', '/hover', { tab: 't1', x: 1, y: 2 })).body);
  assert.equal(hov.ok, true);
  const ps = JSON.parse((await request('POST', '/pick-start', { tab: 't1' })).body);
  assert.equal(ps.ok, true);
  const px = JSON.parse((await request('POST', '/pick-stop', { tab: 't1' })).body);
  assert.equal(px.ok, true);
  // 标签 × 关闭
  const closed = JSON.parse((await request('POST', '/close-tab', { tab: 't1' })).body);
  assert.equal(closed.closed, 't1');
  // 登录流程
  const lw = JSON.parse((await request('POST', '/login-window', { url: 'https://x/login' })).body);
  assert.equal(lw.ok, true);
  assert.equal(lw.tab.url, 'https://x/login');
  const ld = JSON.parse((await request('POST', '/login-done', { url: 'https://x/' })).body);
  assert.equal(ld.ok, true);
  assert.equal(ld.saved, true);
});
