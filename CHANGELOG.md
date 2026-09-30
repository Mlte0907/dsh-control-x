# 更新日志

## 0.2.6（2026-09-30）

性能与自检修复（工具面与 UI 形状不变）：

- **浏览器空闲回收**：headless 实例是 9 个进程、数百 MB 的常驻树，此前一旦 `x_browser_open`
  就永久常驻（实测实例已连续运行数小时）。现新增配置 `browserIdleMs`（默认 300000，0 = 不回收），
  工具与面板都停用超过该时长即自动关闭实例、释放内存；面板推流期间持锁不回收，画面不会断。
  插件卸载/重载（含设置页 toggle）时也会释放实例。
- **面板不可见即停流**：面板由宿主侧栏承载，切到别的 tab 或窗口最小化时组件仍挂载，
  原先 SSE 帧流与标签页轮询照跑——无人观看仍在 screencast 编码并经 webServer 推流。
  现以 `IntersectionObserver` + `document.visibilityState` 判定可见性，不可见即断开 `EventSource`。
- **CDP 出帧节流**：`everyNthFrame` 1 → 2、quality 60 → 55。CDP 按合成帧出帧而服务端 120ms
  才取一帧（≈8fps），逐帧编码属于空烧 CPU（动画/视频页尤甚）。参数提为 `SCREENCAST_OPTIONS` 便于断言。
- **自检端口误报修复**（`scripts/dsh-selfcheck.mjs`）：DSH 桌面版是 Electron 多进程，
  原实现用正则取 tasklist 里**第一个**同名 PID，而监听端口的常是另一个进程，于是误报「未找到 DSH 监听端口」。
  现收集全部同名 PID（Harness/node/dsh）取端口并集，用插件路由本身（`/api/x-control/config` → 200）确认端口。
- **自检浏览器探测**：原实现复用插件的 `browser-profile`，插件自身的 headless 实例持锁时必然报
  "Target page, context or browser has been closed"，把可用能力误判为不可用。现改用临时 profile 探测并清理。
- 探测异常不再被裸 `catch` 静默吞掉（上述 `devNull` 拼写错误正是被吞掉才表现为"配置路由不通"）。
- 新增 `DHCX_BROWSER_PROFILE` 环境变量（验收/CI 用）：插件实例持锁时仍可跑闭环验收。
  新增单测 `tests/browser-idle.test.mjs`（5 例）锁定回收与持锁语义。

## 0.2.5（2026-09-30）

对齐 ZCode 的操控面与浏览器面板：

- 设置页配置区改名 **X-Agent操控**（`settings.section`），侧边栏 tab 改名 **X-Agent浏览器**，
  会话输入框新增 **X-Agent** 按钮。
- `browserEnabled` / `desktopEnabled` 门控 `x_browser_*` / `x_desktop_*` 工具，关闭时报错指向设置页。
- 工具与面板共用同一个 `BrowserManager`（此前两份实例，面板看不到工具开的标签页）。
- 新增面板路由：`/nav`、`/open-external`（Windows 走 `rundll32 url.dll,FileProtocolHandler`，
  经 `execFile` 不经 shell，规避 URL 中 `& % ^` 注入）、`/clear-data`。
- 配置项增至 9 个（新增 `browserPath`、`ignoreCertErrors`、`browserEnabled`、`desktopEnabled`、`inputButtonEnabled`）。

## 0.2.4（2026-09-30）

- 配置页由「插件详情页」迁到设置页通用 slot（`settings.section`，先例 dsh-pangu），
  避免与插件详情页形态冲突。
- 热重放注册容错：重复 id 视为已就位，不再产生双入口。

## 0.2.3（2026-09-30）

- 面板迁到右侧栏 tab：`sidebarRightTabs.register` + `sidebar.right.pane.tab(.title)`；
  旧宿主回退 footer/overlay 路径。

## 0.2.2（2026-09-30）

- 配置卡片打通（浏览器无头模式 / 快照 TTL / 物理输入空闲阈值 / 桌面白名单）。
- 面板显隐修复。

## 0.2.1（2026-09-30）

- **修复客户端永不激活**：`module.exports.inject` 只声明必然存在的基础服务 `["slots","locale"]`，
  可选服务改在 `apply` 内 `ctx.inject` 判空获取——否则 cordis 会一直等待缺失服务，boot 卡死。

## 0.2.0（2026-09-30）

- 按本机真插件的实测形状重写客户端挂载。

## 0.1.0（2026-09-30）

新增两块 UI（v0.0.1 工具面不变）：

- **设置页**：注册 `settings.plugins.tab` slot（id=`control-x`，与官方 `dsh-client-ui-plugin-inventory` 同形状），
  暴露 headless / ttlMs / allowedApps / physicalIdleMs 四项，热保存到 `~/.dsh/cache/dsh-control-x/config.json`。
- **原生右侧面板**：注册 `sidebar.right.pane.tab` + `.title` slot（与官方 `dsh-client-ui-sidebar-browser/lib/client.js:1614` 同形状），
  实时显示无头浏览器 CDP JPEG 帧、点击/滚轮/按键直接回传到该浏览器（不影响用户桌面），
  顶部标签条对应 `x_browser_tabs` 列表。

实现细节见 `lib/browser/watch.js`（webServer SSE/输入路由）、`lib/client.js`（客户端 bundle）、
`lib/index.js`（`webServer` 机会性注册）。

### 新增

- 单测 `tests/ui.test.mjs`：客户端 bundle 三个官方 slot 注册 + watch 路由行为。

## 0.0.1（2026-09-30）

首个里程碑版本：M0-M3 全部闭环验收通过。

### 新增

- **门控**：常驻 `x_status` / `x_activate`，激活后暴露完整 19 工具词汇表（幂等）；`control-x` skill 经 `ctx.skills.register` 机会性注册。
- **浏览器控制面**（headless CDP，零可见窗口）：`x_browser_tabs/open/read/click/fill/press/scroll/shot/wait/close`。语义快照优先、同站复用、截图经 attachments 服务返回图片块。
- **桌面语义控制面**（UIA 模式，零键鼠注入、零焦点抢占）：`x_desktop_apps/tree/press/value/scroll/launch`。编号树 + RuntimeId 跨调用定位、TTL 快照账本、白名单、密码框保护。
- **桌面物理输入**（显式打扰路径，三重门控）：`x_desktop_mouse_click/type/key`。用户空闲检测 → 审批（或 confirm_disturbance 显式自认）→ 前置窗口 → 真实光标/键盘，结果必明示打扰。
- **安全护栏**：危险词命中审批 fail-closed；结构化错误（code + actionSent + retry 语义）。
- 验收脚本：`npm run verify:m1 / m2 / m3`；冒烟测试 `npm test`。

### 平台

- Windows 10/11（DSH 0.2.0-rc.2 实测）；macOS/Linux 桌面 provider 未实现。
