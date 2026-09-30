# dsh-control-x 立项方案（证据版 v0.1）

> **执行状态（2026-09-30）**：M0-M4 全部完成。v0.0.1 发布件就绪；smoke/m1/m2/m3 四项验收全绿。
> 实施细节与平台事实沉淀在 [docs/DSH-SDK-CONTRACT.md](docs/DSH-SDK-CONTRACT.md)；
> desktop 安装步骤在 [docs/INSTALL-DESKTOP.md](docs/INSTALL-DESKTOP.md)。
> 本文档保留为立项依据与设计约束的权威来源。

> 项目：dsh-control-x —— DSH（DeepSeek Harness）插件，让 Agent 在同一插件内获得**浏览器控制 + 本机桌面控制**能力。
> 本文档所有结论均标注证据来源（文件路径 / 行号 / 本机实测命令），不做无依据推测。
> 撰写日期：2026-09-30。调研环境：Windows 10.0.26200 x64，DSH CLI 0.2.0-rc.2（本机实测）。

---

## 0. TL;DR

1. **立项理由**：调研的 5 个参照系统中，没有一个能在**本机（Windows + DSH 0.2.0-rc.2）**上同时提供浏览器与桌面控制：
   - 官方 ZCode 两个插件（browser-use / computer-use）架构最强，但它们不是 DSH 插件——客户端 SDK 依赖 ZCode 宿主注入的 bridge 符号（`browser-client.mjs:2211`、`computer-use-client.mjs:28`），离开 ZCode 宿主无法运行；
   - Fisfzy/dsh-ego-browser 是合格的 DSH 插件且支持 Windows，但**只有浏览器半边**；
   - 988hj7tczd-oss/dsh-computer-use 的桌面半边在 **Windows 官方标注 ⛔ BLOCKED（无真机验收）**，且依赖外部 `cua-driver` 二进制；
   - Anionex/dsh-computer-use 工程质量最高，但 provider **明确 macOS-only**（README「Status and limitations」）。
2. **方案**：自研 dsh-control-x，按 DSH 插件规范（`dsh-plugin.json` manifest 0.15 + cordis.patch.yml + `defineTool`/`ctx.tools.register`）实现；浏览器半边用 playwright-core 经 CDP 驱动本机 Chrome/Edge（ego-browser 已验证 CDP 路线在 Windows 可行）；桌面半边 Windows-first，UIA（UI Automation）结构化树 + SendInput 输入，候选主路线 koffi FFI（官方 computer-use 插件在 win32 就随包内置 koffi 2.15.6 + sharp，属直接证据），备选 .NET UIA 子进程；安全模型整合三家之长（观察 TTL / 白名单 / 危险词审批 / 一次性确认令牌 / actionSent 语义 / kill switch）。
3. **首个里程碑 M0 是两个 spike**：① 从本机 `app.asar` 提取 `@deepseek-ai/dsh-tools` 类型定义锁定 API 契约并让骨架插件在 desktop profile 加载成功；② 验证 koffi 调用 UIA COM / SendInput 的可行性（此项目前**无任何一方给出成品证据**，必须先验证再投入）。

---

## 1. 项目定位

**dsh-control-x** 是一个 DSH 插件：为 DSH Agent 提供统一的"控制面"，包含：

- **浏览器控制**（web）：导航、语义快照、点击/填写/按键、截图、标签页管理——语义优先、坐标兜底；
- **桌面控制**（desktop）：应用/窗口枚举、UIA 元素树观察、点击/输入/滚动/拖拽——无障碍（Accessibility）优先、坐标兜底；
- **统一安全模型**：先观察后动作、快照 TTL、应用白名单、危险操作审批、密码框保护、kill switch；
- **统一心智模型**：`观察 → 决策 → 动作 → 效果验证` 循环，浏览器 Tab 与桌面窗口统一抽象为 Target；
- **不打扰是硬约束**：用户在桌面正常工作时，agent 不弹窗、不抢焦点、不动真实鼠标——headless 浏览器默认，语义动作后台完成（详见 §6.7）。

**不做的事**（与参照系统对齐的边界）：
- 不做 OCR/视觉定位平台（参照 Anionex 的边界声明：把视觉交给宿主视觉模型或独立 vision 插件）；
- 不内嵌完整 Chromium 发行版（不做 ego-browser 那种 vendored runtime，保持轻量）；
- 不对抗宿主安全策略（审批被拒即停，不绕过——参照三个系统一致的失败关闭原则）。

---

## 2. 调研对象与证据清单

| # | 系统 | 版本 | 来源 | 调研方式 |
|---|---|---|---|---|
| A | ZCode 官方 browser-use | 0.5.1 | 本机 `C:\Users\sun_w\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use\0.5.1` | 通读 SKILL.md×2、browser-client.mjs（2235 行）、package.json、docs |
| B | ZCode 官方 computer-use | 0.6.3 | 本机 `...\computer-use\0.6.3` | 通读 SKILL.md（306 行）、computer-use-client.mjs（1208 行）、docs/computer-use.md、node_modules 清单 |
| C | Fisfzy/dsh-ego-browser | 0.8.6 | github.com/Fisfzy/dsh-ego-browser（已克隆） | README、dsh-plugin.json、docs/ARCH.md、package.json、runtime/skills SKILL.md、lib/index.js 抽样 |
| D | 988hj7tczd-oss/dsh-computer-use | 0.3.1 | 同上（已克隆） | README（630 行）、index.js 全文、lib/cua.js、lib/guard.js、cordis.patch.yml、package.json |
| E | Anionex/dsh-computer-use | 0.3.2 | 同上（已克隆） | README、package.json、cordis.patch.yml、lib/skill.js、lib/tools.js（抽样） |
| F | DSH 本体 | 0.2.0-rc.2 | 本机 `D:\Programs\DeepSeek Harness` + `D:\Users\sun_w\.dsh` | 本机实测（见 §3.6） |

---

## 3. 参照系统逐一解析（运作方式 + 证据）

### 3.1 A · ZCode 官方 browser-use 0.5.1

**运作方式**（三层架构）：

1. **Skill 层**（`skills/control-browser/SKILL.md`，181 行）：教模型"每次 `mcp__node_repl__js` 调用都是全新内核，必须先跑 bootstrap 再重建 browser 绑定"；规定操作前先 `browser.tabs.list()` 做目标选择协议（"Never choose `[0]`, `at(-1)`, or an id remembered without validation"，SKILL.md:92）；规定 **snapshot 优先、截图仅在视觉确有必要时用**（SKILL.md:129-134）；后端类型 `iab | extension | cdp`，"Playwright is a tab API surface, not a backend"（SKILL.md:40）。
2. **客户端 SDK 层**（`scripts/browser-client.mjs`，2235 行，MIT）：
   - `setupBrowserRuntime()` 要求宿主在 globalThis 上预注入 bridge：`Symbol.for("zcode.node-repl.browser-control-bridge")`（browser-client.mjs:2211-2219），否则抛错"Browser runtime bridge is unavailable. Use Browser from a ZCode desktop or shared-host session"（:2216）。**这证明它不是独立可运行的插件，重活在 ZCode 宿主里。**
   - 客户端只做：API 门面（`agent.browsers` → Browser → Tabs → Tab）、**能力策略代理**（manifest + descriptor 决定哪些方法可见，`createBrowserApiProxy`，:518-547）、**按需文档加载器**（`docs/api.json` + `documents.json`，:679-729）、Playwright 兼容层（selector 编译为 `internal:role=...` 等，:984-1002）、CUA/dom_cua 逃生口（:1814-1881）、`BrowserCommandError` 结构化错误（:834-846）。
   - 值得抄的细节：`agent.browsers.open(url)` 内置同站复用（`tabs.reuse`，:1942-1951，注释说明动机是"模型每次都 tabs.new() 把 IAB 堆满标签页"）；viewport 安全边界 320×320 ~ 3840×2160（:5-10）。
3. **宿主层**（不在插件包内）：IAB/extension/CDP 三个后端的真实实现、录制（WebM）、tab 回收。

**能力面**：`docs/api.json`（884 行）完整声明 API；截图必须与 `nodeRepl.emitImage` 同 cell（SKILL.md:135）；文件上传在 IAB 明确不支持（SKILL.md:163）。

### 3.2 B · ZCode 官方 computer-use 0.6.3

**运作方式**（同样三层）：

1. **Skill 层**（`skills/computer-use/SKILL.md`，306 行）：**Accessibility 优先的动作阶梯**——"元素动作 > setValue > paste > 键盘 > 坐标最后兜底"（SKILL.md:40-52）；观察可在后台窗口进行（含负坐标副屏，:59-62）；"Success means the API accepted an action, not that the app acted"（:64）；diff 树语义与 `treeSeen` 记账规则（:159-169）；一栅格原则（一次结果只允许一张图，:180-186）；坐标必须来自当前栅格像素，"Element and window bounds are diagnostic global screen points and must never be copied into a coordinate"（:193-195）。
2. **客户端 SDK 层**（`scripts/computer-use-client.mjs`，1208 行）：
   - 同样要求宿主 bridge：`Symbol.for("zcode.node-repl.computer-use-bridge")`（:28），`bridge.call(methodName, args)` 走 MCP envelope（:899-928）。
   - 14 个底层工具白名单 `COMPUTER_METHOD_NAMES`（:31-46）：`list_apps / list_windows / get_app_state / left_click / scroll / left_click_drag / type / set_value / select_text / key / perform_action / paste / request_access / stop_computer_control`。
   - **错误语义是全文件核心**：`ComputerUseError` 携带 `code + actionSent + retry`（:114-131）。`actionSent=true` 时 `retry="reobserve"`——"迫使模型先观察再决定，而不是盲重试一个可能已经落地的非幂等动作"（:245-247 注释）。错误码表 + NEVER_RETRY_CODES / REOBSERVE_CODES（:98-112）。
   - 大量真机事故驱动的防御性设计（注释里带日期与会话 ID），例如：绑定即观察但**不展示**、否则 diff 基线错乱（:594-607）；本地化 app 名在观察路径宽容、键盘路径严格导致分叉，于是绑定后把 appRef 收敛为解析出的 `{pid, bundle_id}`（:1000-1028）；not-ready 冷启动信封的退避重试（:264-266, :900-928）。
3. **宿主层**（不在包内，代号 zcode-cua）：各平台原生 producer（macOS AX / Windows UIA / Linux），租约（CONTROLLER_BUSY=另一会话占用输入，SKILL.md:252-254）、kill switch、帧权威（frame_id 精确栅格）。

**Windows 相关直接证据**：插件在 win32_x64 随包内置 `koffi 2.15.6`（FFI）与 `sharp 12.3.0`（图像处理）的 node_modules（本机文件清单：`node_modules/koffi/build/koffi/win32_x64/koffi.node`、`node_modules/@img/sharp-win32-x64/`）。**这说明官方 Windows 路线 = koffi FFI 调用原生 API + sharp 做图像编解码**——这是 dsh-control-x 桌面半边选型最有力的参照。注意：官方 producer 源码不在插件包内，其 UIA 具体实现方式不可见，**不做猜测**，列入 M0 spike。

### 3.3 C · Fisfzy/dsh-ego-browser 0.8.6

**定位**：把 ego-lite（CitroLabs 出品的 Agent 友好 Chromium）接入 DSH，32 个 `ego_*` 结构化工具 + 实时观察窗。

**运作方式**（证据：README「工作原理」+ docs/ARCH.md）：

- **工具层**：每个工具把参数拼成 JS 脚本，经 `ctx.subprocess` 用 `ego-browser nodejs` 喂 stdin 运行，宿主经 CDP 驱动共享 Chromium；结果用 `@@DSH_RESULT@@` 哨兵行解析（README:185）。所有工具经进程内互斥锁 `withEgoLock` 串行化（ARCH.md §2）。
- **观察窗**：`lib/client.js`（受 DSH 注入机制限制必须单文件，ARCH.md §3）+ `bin/ego-cast-worker.mjs`（独立 Node 进程）+ 双画面后端（CDP JPEG SSE / FFmpeg H.264 fMP4）；Windows FFmpeg 走 `gfxcapture(HWND)`，"禁止恢复 gdigrab desktop fallback：它会在 Chrome 被遮挡时串流用户前台应用"（ARCH.md §4）。
- **DSH 集成形态**（对 dsh-control-x 最有价值的部分，全部有文件证据）：
  - `dsh-plugin.json`：`manifestVersion 0.15`、`facets.host.entry = lib/index.js`、`facets.host.apiVersion = v1alpha1`、`requires.contracts`（OpenExternal/Notification，optional + fallback）、`contributes.x-dsh-tui`（Scene + SettingsSection，含设置字段 schema）、`permissions: []`、`compat.hosts: ["dsh-tui"]`；
  - `package.json`：`dsh.engines.dsh >= 0.1.2-rc.1`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client.inject`（web 前端注入宿主模块）、peerDependencies 全部 `@deepseek-ai/dsh-*`（optional）；
  - 安装：`dshx install ego-browser <tgz|git URL>`；**DSH Desktop 2.0.5+ 校验 profile 依赖名 == 包实际 name**（README:124-134），否则进恢复模式；
  - host API 实际使用清单（grep 自 lib/index.js + lib/client.js）：`ctx.tools.register(defineTool(...))`、`ctx.subprocess.spawn`、`ctx.get("webServer").register({...})`、`ctx.inject(["webServer"], cb)`、`ctx.settings.register`、`ctx.logger`、`ctx.on`、`ctx.fiber`、`ctx.slots.register/inject`、`ctx.locale.register`。

**本机适用性**：Windows 有专门适配（v0.4.0 起），CDP 后端无需 FFmpeg 即可用工具面。**但只有浏览器半边**。

### 3.4 D · 988hj7tczd-oss/dsh-computer-use 0.3.1

**定位**：DSH 的跨平台 Computer Use 插件，12 个模型工具，底层引擎是外部二进制 **cua-driver**（trycua/cua 项目）。

**运作方式**（证据：index.js 全文 + lib/cua.js + lib/guard.js）：

- cordis 插件形态：`export const inject = ['tools', 'approval']`（index.js:41）；`Config` 用 schemastery（:44-59）；`apply(ctx, config)` 里 `ctx.tools.register(defineTool({...}))` 注册 12 个工具（:155-348）。
- 引擎调用：`spawn(CUA_BIN, ['call', tool, JSON.stringify(args)])`，固定 argv 非 shell（lib/cua.js:83-111）；二进制定位链 `CUA_DRIVER_BIN → PATH → ~/.cua-driver/packages/current → 常见路径`（:26-47）；会话失效自愈（:70-80）。
- 图片返回：`renderWithImage` 把截图作为 **attachment 图片块**随工具结果返回给多模态主模型（index.js:92-108，"native 直读，零外部 API"）。
- vision 模式：`ctx.llm` 调 DeepSeek 视觉观察者，GLM 兜底（README:216-243）。
- **安全护栏**（lib/guard.js 全文）：①无快照拒绝动作；②快照 TTL（默认 30s）；③`allowedApps` 白名单；④危险词（删除/支付/转账/退出登录…）命中即 `ctx.approval.request({agent, toolName, reason})` 征询用户；⑤密码框（AXSecureTextField）拒绝自动输入。注释明确边界："坐标模式无法预知目标语义，主要依赖快照 TTL 兜底"、"computer_key 不会阻止 cmd+q 等系统快捷键"（README:295-301）。
- **平台状态（关键）**：README 平台表——macOS ✅ 已验证；**Windows ⛔ BLOCKED（"当前无 Windows 10/11 真机；路径和按键逻辑已测试，真实 GUI 未验收"）**；Linux ⛔ 未验证。

### 3.5 E · Anionex/dsh-computer-use 0.3.2

**定位**：Accessibility-first 的 macOS 原生方案，五者中工程质量最高。

**运作方式**（证据：README + lib/skill.js + lib/tools.js + cordis.patch.yml）：

- **Skill 门控工具暴露**："The Bundle initially contributes only `computer_use_activate`. Loading the Skill exposes the focused execution vocabulary"（README:180）——共 11 个执行工具（computer_list_apps / observe / click / set_value / type_text / press_key / scroll / drag / perform_action / wait / confirm）。
- **原生 helper**：ad-hoc 签名的 universal Swift 二进制，`native/macos/manifest.json` 钉 SHA-256；`pnpm run check:native` 静态拒绝"系统光标移动或全局指针注入"符号（README:226）。
- **不打扰用户的输入路由**：点击/滚动/拖拽走 **pid/window 定向的 SkyLight 路由而非全局 HID 事件流**；独立 Agent 光标（点击穿透、不激活、仅目标应用前台时可见）；"No blind replay: every action is tied to an exact, unexpired observation"（README:21-27）。
- **租约与确认**：read/control 两类按 bundle id 的租约（Session 级 / turn 级）；高影响操作必须先 `computer_confirm` 拿**一次性令牌**（绑定 app+observation+targetHandle+action）；重绑定使令牌失效（README:214-218）。
- **效果验证**：动作成功后 settle 并返回新观察 + `effect.observedStateChanged`（窗口元数据 + AX 树对比），并诚实声明它"不能证明因果"（README:172-174）。
- **安装方式**：`dsh plugin --profile web add @anionex/dsh-computer-use`（README:87-88）——证明 DSH CLI 有官方插件子命令。
- **兼容矩阵**：package.json `dsh.compatibility` 枚举了 10 个 DSH rc/alpha 版本的兼容结论——证明 DSH 插件 API 在 rc 期变动频繁，版本适配是真实成本。
- **平台状态（关键）**："The current provider is **macOS-only**. Windows UI Automation and Linux providers are not implemented."（README:265）

### 3.6 F · DSH 本体（本机实测证据）

| 事实 | 证据 |
|---|---|
| DSH CLI 版本 0.2.0-rc.2 | `dsh.cmd --version` 实测输出 `0.2.0-rc.2` |
| DSH 桌面版入口 | `D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` → Electron `ELECTRON_RUN_AS_NODE` 运行 `app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js` |
| 内置运行时 | `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`：node **24.21.0**、python 3.12.14、pnpm 11.7.0（node.exe 实际路径 `dependencies/node/bin/node.exe`） |
| 插件部署位置 | `~/.dsh/profiles/desktop/package.json`（依赖列表 + `dsh.profile.bundles`）+ `cordis.patch.yml`（patch 层，"applied after every bundle layer"） |
| 已装社区插件先例 | `dsh-better-sidebar 0.22.0`、`dsh-context 0.57.0`、`dsh-cost-meter 1.7.40`、`dshmarket`（插件市场）等 |
| 命名空间 | 包名 `dsh-*`（C、D 两家）；或 scoped `@anionex/dsh-computer-use`（E） |

---

## 4. 横向对比矩阵

| 维度 | A 官方 browser-use | B 官方 computer-use | C ego-browser | D 988 cua | E Anionex cua |
|---|---|---|---|---|---|
| 宿主/形态 | ZCode 插件（node_repl bridge） | ZCode 插件（node_repl bridge） | **DSH 插件** | **DSH 插件** | **DSH 插件** |
| 浏览器控制 | ✅ 强（iab/extension/cdp + Playwright 面） | ❌（刻意不融合，client 头注释 :21-22） | ✅ 强（CDP + 32 工具） | ❌ | ❌（README 明确 browser 用浏览器自动化） |
| 桌面控制 | ❌ | ✅ 强（三平台 producer 在宿主） | ❌ | ⚠️ 经 cua-driver | ✅ 强（原生 helper） |
| Windows 桌面 | 宿主有 koffi 证据 | 宿主有 koffi 证据 | 不适用 | **⛔ BLOCKED** | **❌ 未实现** |
| 工具面 | JS API 门面（非工具列表） | 14 工具 + JS 门面 | 32 结构化工具 | 12 结构化工具 | activate + Skill 门控 11 工具 |
| 观察手段 | DOM snapshot（AI/ARIA 树） | AX 树 + diff + 截图 | CDP DOMSnapshot 语义树 | AX/UIA 树 + native/vision 图片 | AX 树 full/diff + 截图 Artifact |
| 动作通道 | Playwright 定位器 / CUA 坐标 / dom_cua | 元素索引 / 栅格坐标 | ego helpers（heredoc JS） | cua-driver 虚拟光标 | AX 语义 / pid 定向指针 |
| 安全模型 | 页面内容视为不可信；3000ms 预算 | actionSent/retry、lease、kill switch、CONTROLLER_BUSY | withEgoLock 互斥；观察窗接管协议 | 无快照拒绝/TTL/白名单/危险词审批/密码保护 | 租约、一次性确认令牌、重绑定失效、fail-closed |
| 可视化 | IAB 内建 | — | ✅ 观察窗（SSE/FFmpeg + 人工接管） | ❌ | Agent 光标可视化 |
| 运行时依赖 | 宿主 bridge | 宿主 bridge | vendored ego-lite + 可选 FFmpeg | **外部 cua-driver** | 内置原生 helper（SHA-256 钉版） |
| 本机可用性（Win + DSH 0.2.0-rc.2） | ❌ 非 DSH 插件 | ❌ 非 DSH 插件 | ⚠️ 浏览器半边可用 | ⚠️ 官方自认未验收 | ❌ macOS-only |

---

## 5. 差距分析 → 立项理由

1. **Windows 桌面控制是空白**：D 未验收、E 未实现、A/B 绑定 ZCode。而 DSH 插件生态（C 证明）在 Windows 上做 CDP/子进程/FFmpeg 都是可行的。→ dsh-control-x 的桌面半边有明确生态位。
2. **没有"浏览器 + 桌面"统一控制面**：C 只有浏览器，D/E 只有桌面，A/B 二分但绑定 ZCode。统一插件意味着统一的安全模型、统一的观察-动作循环教学（一份 SKILL）、统一的配置与审批。
3. **安全模型可以整合三家之长**，每项都有成品证据可依：
   - 观察优先 + TTL（D 的 guard.js）；
   - 白名单 + 危险词审批 via `ctx.approval`（D，本机 DSH 有 approval 服务——D 的 inject 声明即证据）；
   - 一次性确认令牌 + 重绑定失效（E）；
   - `actionSent`/`retry` 错误语义（B）——防止模型盲重试非幂等动作；
   - kill switch（B 的 `stop_computer_control`）；
   - 单实例互斥（C 的 withEgoLock）。
4. **轻量**：不 vendored Chromium（C 的 runtime/ 很重）、不强制外部二进制（D 依赖 cua-driver）。目标依赖仅：playwright-core（npm）+ koffi/sharp（与官方插件同款）或零原生依赖的备选路线。

---

## 6. 技术方案

### 6.1 总体架构

```
DSH Agent
  │ defineTool 结构化工具（browser_* / desktop_* / control_x_activate）
  ▼
┌────────────────────── dsh-control-x (cordis 插件) ──────────────────────┐
│  plugin 入口 lib/index.js   inject: ['tools','approval','subprocess']   │
│  ├─ core/   Target 抽象 · 观察缓存(TTL/diff) · Guard · 错误码 · 效果验证 │
│  ├─ browser/  Chrome/Edge 发现与启动 → playwright-core(CDP)             │
│  │            snapshot(ARIA树) · locator 动作 · 截图(sharp) · tabs       │
│  ├─ desktop/ provider: win32(UIA 树 + SendInput 输入) [darwin/linux 预留]│
│  ├─ skill/  SKILL 内容（观察→动作→验证循环教学，Skill 门控）             │
│  └─ watch/  (P2, 可选) ctx.webServer 观察窗（参照 C 的 SSE 路线）        │
└──────────────────────────────────────────────────────────────────────┘
        │                                  │
        ▼                                  ▼
  本机 Chrome/Edge (CDP)            桌面应用 (UIA/SendInput)
```

### 6.2 DSH 集成与插件形态（全部有 C/D/E 三家先例）

- `dsh-plugin.json`（manifestVersion 0.15，仿 C：facets.host.entry / requires.contracts / contributes 设置节 / compat.hosts）；
- `package.json`：`dsh.engines.dsh >= 0.1.2-rc.1`（地板参考 C/D；本机 0.2.0-rc.2 需 M0 实测），`dsh.bundle.patch: ./cordis.patch.yml`（三家通用）；
- 工具注册：`ctx.tools.register(defineTool({name, description, parameters, output, execute, render}))`（C:1、D:index.js:30、E:lib/tools.js:2 三处一致）；
- 图片返回：attachment 图片块随 `render` 输出（D:index.js:92-108 先例）；
- 审批：`ctx.approval.request({agent, toolName, reason})`（D:guard.js:98 先例）；
- 配置：schemastery `Config`（D:44 先例）；
- 安装：优先支持 `dsh plugin --profile desktop add <pkg>`（E 先例）+ 本机 profile 依赖名==包名约束（C README:124 先例）；发布渠道可挂 dshmarket（本机 profile 已装该市场）。

### 6.3 浏览器控制面

- **驱动**：playwright-core **默认以 headless 启动托管的 Chrome/Edge 实例**（独立 agent profile，磁盘持久化登录态——对齐 C 的"登录态落盘"能力），**全程零可见窗口、零焦点抢占**（官方 B 的 `cdp` 后端与 C 的 ego-browser 均为 headless 默认，属已验证路线）。**不 attach 用户日常使用的浏览器**——那会激活用户的标签页、干扰其正在进行的操作。有头窗口只能由用户在观察窗主动点击"弹出"触发（C README:38 的"一键替换为有头窗口"先例），agent 永远不主动弹窗。
- **观察**：`domSnapshot`（AI/ARIA 语义树）为主、截图为辅（对齐 A 的 SKILL 纪律：截图仅三种情形，A:SKILL.md:133）。
- **动作**：语义定位优先（role/name/text），坐标 CUA 兜底（canvas/非 DOM 场景，对齐 A 的 `tab.cua.*`）。
- **Tab 管理**：`open(url)` 同站复用（A:1942 先例）、操作前 `tabs.list()` 目标选择协议（A:SKILL.md:87-95）。
- 逃生口：`browser_evaluate`、原始 CDP（对齐 C 的 `ego_js`/`ego_cdp`）。

### 6.4 桌面控制面（Windows 优先）

**观察（UIA 树）候选路线**（M0 spike 决胜，当前无任何一方给出 Windows 成品实现可抄）：

| 路线 | 依据 | 风险 |
|---|---|---|
| ① koffi FFI → UIAutomationCore COM + user32 SendInput | 官方 B 在 win32 随包 koffi 2.15.6 + sharp（§3.2 证据）；零外部进程、时延低 | koffi 调 COM 需手工 vtable/封送，工作量大，**可行性未证实 → spike** |
| ② .NET `System.Windows.Automation` helper 子进程（固定 argv，JSON over stdio） | UIA 在 .NET 是一等公民；D 的"固定 argv 非 shell"安全模式可直接复用；DSH 内置 node 可 spawn PowerShell/dotnet | 每次调用进程开销（可常驻单 helper 化解） |
| ③ 外部 cua-driver（D 的路线） | D 已有完整封装代码可参考 | D 官方自认 Windows 未验收；引入外部二进制依赖 |

推荐：**① 为主、② 为备**，spike 失败即切 ②。输入侧（SendInput）两条路线都简单可靠；鼠标位置注入与"虚拟光标可视化"（E 的 Agent 光标、D 的虚拟光标）列为 P2。

**工具面草案**（与 B/D/E 命名对齐）：
`desktop_apps_list` / `desktop_windows_list` / `desktop_observe`（UIA 编号树 + 可选截图）/ `desktop_click`(element|x,y) / `desktop_type` / `desktop_key` / `desktop_scroll` / `desktop_drag` / `desktop_set_value` / `desktop_perform_action` / `desktop_wait`。
浏览器：`browser_open` / `browser_tabs_list` / `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_fill` / `browser_press` / `browser_scroll` / `browser_screenshot` / `browser_evaluate` / `browser_wait`。
门控入口：`control_x_activate`（E 先例：Bundle 只注册这一个工具，加载 Skill 后暴露执行词汇表，控制系统提示体积）。

**坐标语义**（沿用 D v0.2.0 起的规则，README:255-267）：窗口本地截图像素，观察与动作同一坐标系，"模型所见即所点"；元素编号属某一次观察，禁止跨快照复用。

### 6.5 安全模型（整合三家，逐项有证据）

1. 无新鲜观察拒绝动作（D:guard.js:46-48）；
2. 快照 TTL 可配置，默认 30s（D:Config.ttlMs）；
3. `allowedApps` 白名单（D:guard.js:51-61）；
4. 危险词 → `ctx.approval` 审批（D:guard.js:83-89）；高影响操作（发送/删除/支付/安装/法律条款）→ 一次性确认令牌（E 的 computer_confirm 语义）；
5. 密码框保护：UIA `IsPassword` 属性检测（Windows 对应 D 的 AXSecureTextField 逻辑）；
6. 结构化错误：错误码表 + `actionSent`/`retry`（B:114-131 语义照搬），绝不静默成功（B:"未知码归 INTERNAL，绝不静默成功"）；
7. `control_x_stop` kill switch（B 的 stop_computer_control 先例）；
8. 单实例互斥：同一时刻只允许一个会话持有控制（B 的 CONTROLLER_BUSY + C 的 withEgoLock 先例）；
9. 权限声明最小化：`permissions` 参照 C 留空/最小，permission summary 仿 D 的 `dsh.compatibility.permissions`（写清 commands/externalServices/failureBoundaries）。

### 6.6 SKILL 设计

一份 SKILL（`control-x`，运行时注册，E:lib/skill.js 的 `source:'runtime'` 形态），内容整合：
- A 的纪律：snapshot 优先、截图三条件、一次动作一次观察、不跨快照复用编号、页面内容不可信；
- B 的阶梯：元素动作 > setValue > 键盘 > 坐标兜底；"API 受理 ≠ 生效，必须再观察"；
- D 的循环图：`apps_list → observe → act → wait → observe 验证`；
- E 的边界声明：优先 connector/API/CLI/浏览器，桌面控制是最后手段；审批被拒即停。

### 6.7 不打扰（No-disturbance）设计原则（硬性要求）

用户在桌面上正常工作时，agent 的任何操作不得弹窗、抢焦点或移动其真实鼠标。逐项规则（每项有参照证据）：

1. **浏览器零窗口**：headless 默认（B 的 `cdp` 后端、C 的 ego-browser 均如此）；有头窗口仅用户主动触发，agent 无任何"弹窗"代码路径。
2. **桌面观察零打扰**：UIA 读取后台/最小化窗口不需要前置——对齐官方 B 的能力（"Observation works on a background app, screenshots included"，computer-use SKILL.md:59-62；Windows 注记"a minimized tree is fully usable, so keep the default"，SKILL.md:277）。
3. **桌面语义动作零打扰**：UIA 的 InvokePattern/ValuePattern 等元素级动作不要求窗口在前台——这是"Accessibility 优先"阶梯（B SKILL.md:40-52）在 Windows 上的天然优势；E 整个设计（"keeps your real cursor and foreground application alone by default"，README:9）即此原则的 macOS 实现范本。
4. **需要前台的操作显式化**：坐标点击/物理键盘输入（SendInput）在 Windows 上作用于前台焦点窗口，不可避免要前置目标窗口。这类操作列为"显式打扰"路径：默认不使用，触发前须经审批或在结果中明示"已前置窗口 X"；后台窗口消息（PostMessage）路线兼容性参差，只作实验性选项。
5. **不碰用户的东西**：绝不 attach 用户日常浏览器；`app_launch` 默认后台启动不抢焦点（D index.js:327 先例："后台启动，不抢焦点；可选 bring_to_front"）；虚拟光标可视化（P2）不抢占真实鼠标（D README 先例）。
6. **观察窗嵌在 DSH UI 内**：渲染为 DSH 自身界面的一部分（浮动球/侧边栏 Tab），不是独立桌面窗口。
7. **鼠键争用最小化**：Windows 全局只有一条输入流（唯一光标 + 唯一键盘焦点），物理输入（SendInput）天然与用户共用——这是平台事实，988 的"不抢占真实鼠标"指不劫持锁定，不是不经过系统输入流；真正绕开全局输入流的只有 E 的 macOS pid 定向路由（Windows 无等价机制）。因此：① a11y/UIA 语义动作不注入任何输入事件（COM 调用直达应用），覆盖绝大多数操作；② 物理输入执行前检测用户活跃度（GetLastInputInfo 空闲阈值），用户正在操作时等待或请求确认；③ 物理输入授权按 turn 收敛、用完即收（对齐 E 的 control lease）；④ 批处理动作压缩争用时窗；⑤ `control_x_stop` 随时可停。会话级隔离（Windows Sandbox/VM 内跑 agent 桌面）是唯一零争用解，但操作不了用户本机的真实应用，仅作远期选项（参照系统均无此先例，暂不纳入范围）。



### 6.8 观察窗（P2，可选）

复用 C 已验证的路线：`ctx.get("webServer").register()` 路由 + CDP `Page.startScreencast` JPEG/SSE（C README:174-176；FFmpeg/gfxcapture 后端及其禁忌——禁止 gdigrab 桌面回退——照抄 C ARCH.md §4 的结论）。浏览器半边先做，桌面半边观察窗后评估。

---

## 7. 关键决策点（附证据的取舍）

| 决策 | 选择 | 依据 |
|---|---|---|
| 桌面后端 | koffi+UIA 主线，.NET helper 备选 | B 的 koffi/sharp 随包证据；D 的固定 argv 安全模式可复用给备选；cua-driver 在 Windows 无验收证据 |
| 浏览器后端 | playwright-core + CDP，本机 Chrome/Edge | C 证明 CDP 路线 Windows 可行；A 证明 Playwright 语义面好用（且 A 的 devDeps 即 playwright-core 1.59.1）；不 vendored Chromium（C 的 runtime/ 体积教训） |
| 工具暴露 | Skill 门控（先注册 activate） | E 先例；控制系统提示体积；加载后才暴露 20+ 工具 |
| 错误语义 | 错误码 + actionSent + retry | B 真机事故驱动的设计（注释带会话证据），防止非幂等动作盲重试 |
| 命名 | 包名 `dsh-control-x`，工具前缀 `browser_`/`desktop_` | C README:124 的包名一致性校验约束；前缀与 D（computer_*）/C（ego_*）风格一致 |
| 视觉兜底 | native 直读（attachment 图片块）优先，ctx.llm vision 备选 | D 的两条路线均有实现；零额外 key 的 native 模式成本最低 |

---

## 8. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 契约与 spike**（2-3 天） | ① 从本机 `app.asar` 提取 `@deepseek-ai/dsh-tools` 等类型定义，锁定 defineTool/ctx API 契约；② 骨架插件（dsh-plugin.json + cordis.patch.yml + hello 工具）装入 desktop profile；③ spike：koffi→UIA 枚举记事本控件树；koffi→SendInput 点击；spike 失败则验证 .NET helper 路线 | desktop profile 重启无错、会话中可见工具；spike 产出可运行的 POC 与路线结论 |
| **M1 浏览器半边** | Chrome/Edge 发现+启动、snapshot/click/fill/press/screenshot/tabs、open 同站复用 | 真实任务闭环：搜索→点结果→填表单→提交→截图验证；**全程零可见窗口、用户桌面无任何焦点变化** |
| **M2 桌面半边（Win）** | apps/windows list、UIA observe 编号树、click/type/key/scroll/set_value | 记事本+计算器任务闭环：观察→点击→输入→再观察验证；**后台窗口观察与语义动作零焦点抢占**（需前台的操作单独标注并审批） |
| **M3 安全与技能** | Guard 全套（TTL/白名单/审批/令牌/密码框）、错误码+actionSent、SKILL 文案、activate 门控 | 危险词触发审批；密码框拒绝；过期快照拒绝并提示重观察 |
| **M4 打磨发布** | vision 兜底、观察窗（P2）、CI（node --check + 单测）、打包与安装文档、（可选）dshmarket 上架 | 从零安装到完成演示任务 ≤ 10 分钟 |

## 9. 风险与缓解

| 风险 | 证据 | 缓解 |
|---|---|---|
| DSH rc 期 API 变动 | E 的 10 项兼容矩阵；C 的全版本适配说明 | `engines.dsh` 地板 + 兼容矩阵随版本维护；M0 用本机 0.2.0-rc.2 实测锁定 |
| koffi 调 UIA COM 复杂度 | 无任何参照系统给出 Windows UIA 成品（B 的 producer 不在插件包内） | M0 spike 前置；.NET helper 备选已设计；两者都保留 JSON 契约层隔离 |
| UAC/提权窗口不可操作 | D:README:354（"目标窗口权限级别更高"） | 文档明示边界，检测提权窗口并明确报错 |
| 锁屏/RDP 断开时 SendInput 失效 | Windows 会话机制（公开常识，列入测试清单） | M2 验收含锁屏行为的明确错误路径 |
| 杀软误报（输入注入） | D 的 PERMISSIONS.md 专门章节先例 | 固定 argv 非 shell、无混淆、权限声明透明 |
| 浏览器半边与 ego-browser 同质竞争 | C 已是成熟实现 | 差异化=统一控制面+桌面半边+无 vendored runtime；不做与 C 的功能对表竞赛 |

## 10. 附录：本方案引用的关键证据索引

- A1 `browser-use/0.5.1/scripts/browser-client.mjs:2211-2232`（宿主 bridge 依赖）；A2 `:1942-1951`（open 同站复用）；A3 `skills/control-browser/SKILL.md:87-95,129-135,163`（协议纪律）
- B1 `computer-use/0.6.3/scripts/computer-use-client.mjs:28,31-46,114-131`（bridge/工具表/错误语义）；B2 `:594-628,1000-1043`（真机事故驱动设计）；B3 `node_modules/koffi/…/win32_x64/koffi.node` + `@img/sharp-win32-x64/`（Windows 技术栈证据，koffi 2.15.6）；B4 `skills/computer-use/SKILL.md:40-64`（a11y 阶梯）
- C1 `dsh-ego-browser/dsh-plugin.json`（manifest 0.15 全文）；C2 `package.json:22-36`（dsh.engines/bundle.patch/client.inject）；C3 `README.md:124-134,183-186`（安装约束/工作原理）；C4 `docs/ARCH.md`（分层与禁忌）
- D1 `index.js:41,44-59,155-348`（inject/Config/12 工具）；D2 `lib/guard.js:12-31,42-102`（护栏全集）；D3 `lib/cua.js:26-47,83-111`（引擎调用）；D4 `README.md:331-338`（平台状态：Windows ⛔）
- E1 `README.md:15-27,180,214-218,265`（路由/门控/租约确认/macOS-only）；E2 `lib/skill.js:124-130`（Skill 注册形态）；E3 `package.json:89-106`（兼容矩阵）；E4 `cordis.patch.yml`（interaction policy）
- F1 本机 `dsh --version` → 0.2.0-rc.2；F2 `~/.dsh/dsh-runtimes/.../runtime.json`（node 24.21.0）；F3 `~/.dsh/profiles/desktop/{package.json,cordis.patch.yml}`（部署形态）
