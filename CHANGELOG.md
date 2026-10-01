# 更新日志

## 0.5.0（2026-10-01）

**视觉模型：给不支持图片输入的会话模型补一双眼睛。**

起因是实测：本会话模型 `space-bunny-free` 对 `read_image` 的拒绝原话是
「model "space-bunny-free" does not declare image input」——**注意是"没声明"，不是"不支持"**。
宿主按模型路由里声明的 `inputModalities` 决定放不放图片；截图工具能拍出真图
（实测 1280×800、9274 种颜色的真实渲染），但图片内容到不了纯文本模型。
同一个 profile 里 `mimo-v2.6-flash` / `mimo-v2.5` 的路由本就声明了 `image`。

### 新增

- **`x_vision_describe`**：把截图交给视觉模型，换回**文字**描述给 Agent 读。
  先 `x_browser_shot` 拿 `image` 引用再传进来，或直接给 `tab_id` 让它现拍一张。
- **设置页「视觉模型」下拉**：选项来自宿主**已添加且声明支持图片**的模型
  （服务端 `GET /vision-models` → `ctx.llm.listProviders()` + `listModels(provider)`，
  按 `inputModalities` 含 `image` 过滤）。默认 **「系统推荐」**（取宿主适配器偏好序的首个）
  与 **「随机」**（每次调用重新摇，避免某个模型抽风时一直卡着）；也可指定某个 `provider/model`。
  取不到模型列表时**明说不可用**，不给一个永远空着的下拉装正常——那是本次事故同款的假绿。
- `x_status` 增加 `visionModel` 字段，设置值可直接读到。

### 契约依据（全部来自宿主源码/文档，非猜测）

- `ctx.llm.listProviders()` / `listModels(provider)` → `[{provider,id,name,inputModalities?}]`
- `for await (const chunk of ctx.llm.stream({ provider, model, messages }))`，
  `messages` 收 request-only 的 `{role:'user', content:[{type:'text',...}]}`
- 图片以**持久化附件引用**进 messages（与本插件 `x_browser_shot` 的 image block 同源，
  该路径已被真机验证过：宿主收下后落盘成 `~/.dsh/attachments/v1/objects/…`）。
  这是本功能唯一带推断成分的一处，故所有宿主错误**原样上抛并点名模型**，
  不做静默降级——字段名若不符，第一次真机就会给出可直接定位的真话。

### 验证

单测 22 项新增、全量 **40/40**；宿主真校验器 **22/22**（工具名逐个点名，
并做了反向对照：删掉一个名字验收即红）；m1/m2/m3 与 selfcheck 全绿。

### 待你决定（比插件更重要）

`space-bunny-free` 的路由现在写的是 `input: [text]`。若该模型网关确实提供图片，
在 profile 的 `cordis.patch.yml` 给它加 `image`（乃至 `video`）后重启，
本会话就能**直接看图**，插件这条兜底链就不必上场。
适配器 README 的警告要一并记住：**「A modality declaration is not verified」**——
声明了但网关不提供，会在请求时被 provider 拒绝而不是本地报错。

## 0.4.0（2026-10-01）

**顶部横幅：Agent 正在操控本机桌面时，界面顶部一直可见的提示。**
此前只有物理输入路径有回报文本，语义动作（观察/写入/切换）全程无声，
用户只能靠"界面没动"猜 Agent 是不是还在干活。

### 新增

- **顶部横幅**「X-Agent 正在操控中…」：打字机效果（55ms/字）+ 闪烁光标 + 呼吸点，
  文字带出正在执行的动作名（如 `x_desktop_press`）。常驻挂载、按活动状态显示/隐藏，
  **不需要用户先打开侧边栏面板**。
- **背景框颜色随宿主主题**：background 用 `--dsw-alias-bg-elevated`、文字用
  `--dsw-alias-label-primary`，浅色/深色主题各自解析成不同值，切主题时横幅跟着变。
  刻意不用 `--dsw-alias-brand-primary`——本机它解析成白色（设置页已实测踩过）。
- **`GET /api/x-control/activity`**：横幅的数据源。独立端点，不进 `/tabs`，
  横幅轮询与面板刷新节奏解耦。
- **`lib/desktop/activity.js`**：活动跟踪 + `withActivity` 包装。宽限期 2.5s——
  一次语义动作常在 1 秒内结束，纯 in-flight 会让横幅一闪而过；
  失败路径也必须 `end`，否则一次抛错就把横幅永久钉在屏幕上。
  **只跟踪桌面半边**：无头浏览器不碰用户屏幕，不该在桌面上弹横幅。
- 轮询随状态切换：活跃 600ms / 空闲 2500ms；页面切回前台立即刷新；
  `prefers-reduced-motion: reduce` 时直接显示完整文案、不做打字动画；
  **取数失败（插件被停用/路由消失）时横幅自己隐藏**，绝不留下假的"正在操控"。

### 实现要点

- 横幅挂 `document.body` 而非 slot：它是全窗口浮层（position:fixed），与宿主布局无关；
  本机 `dsh-client-ui-layout` 的 lib 是空包、席位名在应用侧声明，依赖某个 seat 等于赌宿主版本。
- 清理走 `ctx.effect`，插件停用/热重放时不会留下孤儿节点。

### 测试

新增 `tests/activity.test.mjs`（5 项）与 `tests/banner.test.mjs`（6 项），全量 **31/31**。

> 测试侧踩坑（已记）：横幅用递归 `setTimeout` 轮询，测试不卸载就会让事件循环永不结束、
> `node --test` 整轮挂死无输出——必须收好 `ctx.effect` 的 disposer 并 `t.after(dispose)`；
> 断言"打字打完"要用轮询等待，不要拍脑袋定毫秒数（文案长度一变就假红）。

## 0.3.1（2026-10-01）

**致命修复：21 个工具全部注册失败，用户侧零感知。** 插件照常挂载、面板照常打开、
`control-x` skill 照常出现在技能目录，但 `x_status` / `x_activate` / `x_browser_*` /
`x_desktop_*` 一个都没进 Agent 的工具表——插件装好了，却一个动作也发不出去。

### 根因

`ctx.tools.register()`（宿主 `@deepseek-ai/dsh-tools` 0.2.0-rc.2，
`lib/index.js:2878-2890`）第一件事就是 `assertSupportedJsonSchema(output.schema)`，
不合 raw JSON Schema 子集**直接抛错**。

本插件的 `parameters` 用的是宿主 `defineTool` 的 **property-map DSL**（property 上写
`required: true`），这个写法被顺手照搬进了 `output.schema`——后者是 **raw JSON Schema**，
`required` 必须是字符串数组、且不能挂在标量/数组节点上。于是 21 个工具 100% 被注册门拒收：

```
✘ x_status: schema.properties.config.required must be an array of strings;
             schema.required must be an array of strings
✘ x_browser_tabs: schema.properties.ok.required is not supported on type "boolean";
```

`lib/index.js` 的 `safeRegister` 用 try/catch 吞掉异常、只写一条 `logger.warn`，
桌面上没有任何提示——这就是它能长期"全绿"的原因。

### 为什么之前没发现

`verify:m1/m2/m3` 全部用 mock `ctx.tools.register`（来者不拒），`selfcheck` 只查安装面、
HTTP 路由与浏览器能力。**没有任何一环节跑过真宿主的注册门**，于是 5/5 全绿而链路是断的
（与 pangu「中间件只认 X-API-Key」同族：单元绿、集成绿、装配不通）。

### 修复

- **5 个工具的返回值不满足自己的 output.schema**（注册修好后立刻暴露的第二层缺陷）：
  `x_browser_tabs`、`x_desktop_launch`、`x_desktop_mouse_click`、`x_desktop_type`、
  `x_desktop_key` 都直接 `return { … }` 而**漏掉 `ok: true`**，但它们的 schema 把 `ok`
  列为必填。宿主会用 `output.schema` 校验工具返回值，缺一个键整个调用就被判失败
  （`missing required property "value.ok"`）——真机 E2E 第一次调 `x_browser_tabs` 就撞上。
  **这五个 bug 此前被"注册失败"整体遮住了**：工具压根注册不上，返回值从没被校验过。
  三道防线：①五处补 `ok: true`；②`defineXTool` 统一自检返回值是否满足自身 schema 的
  必填键，缺则抛点名道姓的 ControlXError（不再让宿主抛含糊错误）；③m2/m3 验收脚本对
  每个用到的工具做返回值形状对账 + 单测覆盖无副作用工具。
- **`x_status` 谎报版本**：返回值里的 `version` 写死 `'0.0.1'`，与实际安装的包永远对不上——
  「装的是哪版」这种第一手事实被谎报会把排障带偏（2026-10-01 真机验证时踩到）。
  改为真读 `package.json`（`createRequire`，不依赖打包器），并加单测断言两者必须一致
  且形如 `x.y.z`，防止再写死。
- **新增 `lib/core/host-schema.js`**：`toHostSchema()` 在注册边界把 property-map 写法
  统一改写成 raw JSON Schema（属性上的 `required: true` → 就地提升为本级 `required` 数组）；
  `checkHostSchema()` 镜像宿主会拒绝的几种形态，供自检使用。
- **新增 `tests/host-contract.test.mjs`（4 项）**：21 个工具的 `parameters` 与
  `output.schema` 全部过子集检查 + **反向对照**（旧写法必须被判红，否则绿是假绿）+
  **反向保证**（`x_browser_open` 的 `ok`/`tab` 必须真的进了根级 `required`，防规范化空转）。
- **新增 `scripts/host-contract-verify.mjs`（`npm run verify:contract`）**：从**运行中**
  `app.asar` 里递归抽出 `@deepseek-ai/dsh-tools` 包闭包，直接 `import` 宿主的
  `assertSupportedJsonSchema` 原件（未改写一行）逐个判 21 个工具；找不到 app.asar 时
  退回仓库内镜像规则并在输出里注明。这才是能抓住本次缺陷的那道门。
- **`lib/core/tool.js`**：契约注释订正——`parameters` 与 `output.schema` 是两套方言，
  混用会被宿主拒收。
- **`docs/DSH-SDK-CONTRACT.md` 新增 §1b**：三种方言的对照表与 raw 子集硬规则，
  并注明 `parameters` 宿主**不校验**（原样投影给模型）、`output.schema` 强制校验。
- `package.json`：`test` 纳入新测试文件，新增 `verify:contract`。

### 验证（修复后实测）

| 项 | 结果 |
|---|---|
| `npm test` | **18/18**（原 14 + 新增 4） |
| `npm run verify:contract`（宿主**真校验器**） | **21/21 通过**，0 拒绝 |
| `verify:m1` 浏览器面 | 14 步全绿（真无头 Chrome + cn.bing.com 搜索 + 68KB 截图落盘） |
| `verify:m2` 桌面语义面 | 全绿（charmap UIA 树 499 元素、ValuePattern 写入 `"X"` 复核、Toggle Off→On） |
| `verify:m3` 门控 + 物理面 | 全绿（物理点击 ToggleState Off→On，审批/危险词护栏全对） |
| `selfcheck` | 全绿（`/api/x-control/config` 与 `/tabs` 均 200） |

修复前同一套真宿主校验的读数是「通过 0 / 拒绝 21」，作为前后对照。

### 尚未验证（需要重启宿主）

本仓库的改动**不会**自动进入正在运行的 DSH：desktop profile 的插件是从
`github:Mlte0907/dsh-control-x#b0d5ceb` 安装的独立副本（不是软链回本目录，
只有 `cx-headless` 测试 profile 是软链）。提交并重新安装（或改用软链）后重启宿主、
新开会话，`x_status` 才会出现在工具表里。**在此之前请以 `npm run verify:contract` 的读数为准。**

## 0.3.0（2026-10-01）

面板对齐 ZCode（图标、交互均取自其 renderer 实现原文）+ 修复 skill 注册缺陷。

### 新增

- **工具栏 ZCode 化**：后退/前进/刷新换用同款 lucide 图标（chevron-left/right、refresh-cw，
  刷新加载时旋转）；新增**自由尺寸**（monitor-smartphone）与**元素选择**（mouse-pointer-click）；
  ⋯ 菜单（ellipsis）内含「在默认浏览器中打开」（external-link）。按钮改 ghost 图标样式。
- **自由尺寸**：视口宽度贴合面板并随面板缩放跟随（ResizeObserver 防抖）；尺寸栏为 ZCode 同款
  通栏贴条（全宽、居中、无边框），W×H 可精确输入，缩放 50%~200%（只改显示倍率，坐标映射不变）。
- **元素选择（加入聊天）**：进入模式后悬停即 CDP Overlay 高亮，点击把元素定位信息
  （标签 + CSS 选择器 + 文本）**追加进会话输入框草稿**（借 conversation.input.left 的
  inputActions/useInput），剪贴板兜底——对齐 ZCode"选择网页元素加入聊天"。
- **登录窗口流程**（先例 ego-browser「已登录，保存」）：面板横幅一键弹出**同一持久化 profile**
  的有头窗口完成登录，点「已登录，保存」回无头，登录态落盘保留；用户直接关掉窗口时
  服务端自动回无头并还原页面，横幅状态经 /tabs 的 loginActive 复位。
- **标签页关闭**：面板标签 chip 带 ×（lucide X），`POST /close-tab` 真正关闭单个标签页。

### 修复

- **面板碎图**：首帧到达时 img 未挂载导致 src 丢失，静态页此后无新帧，碎图永久停留。
  帧改存 frameRef，挂载时由 ref 回调补 src；切换标签页丢弃上一页旧画面。
- **skill 加载崩溃**：注册对象缺 `source` 字段，会话加载 skill 时宿主
  validateDefinition 抛 "source must be a string"，整轮运行失败。补 `source: 'runtime'`
  并加契约测试锁定宿主校验规则。
- **设置页开关隐形**：选中态用主题变量 `--dsw-alias-brand-primary`（本机解析为白色），
  白轨道+白滑块不可见；品牌色全部写死 #4a7dff，滑块加投影。
- **输入坐标换算**：原按 1280 宽写死比例，非默认视口点击偏移；改为「视口宽 ÷ 帧宽」。
- 输入框按钮槽位从 `conversation.input.overlay`（浮层锚点，斜杠菜单专用）迁到
  `conversation.input.left`（工具行左侧紧凑控件），不再悬在占位文字上；按钮改纯图标。
- 移除「打开调试工具」菜单项与底部按键输入行（键盘走 Agent 的 x_browser_press），
  提示行置顶单行省略。

### 服务端路由

`/viewport` `/pick` `/hover` `/pick-start` `/pick-stop` `/close-tab` `/login-window` `/login-done`；
`/tabs` 附带 `loginActive`。单测 14/14。

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
