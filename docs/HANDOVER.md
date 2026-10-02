# dsh-control-x 交接单

> 盘点时间 **2026-10-02 12:53（Asia/Shanghai）**；同日 16 时许按本单完成一轮处理（0.5.10），更新处以「**0.5.10 交接**」标注。
> 所有结论均来自对盘上文件的直接读取与命令执行，出处以 `文件:行号` 或命令名标注；
> 无法证实的集中在 §10「未决问题」，不混进结论。

---

## 0. 一句话现状

插件 **0.5.10**（发版轮完成）：22 个工具全部注册且模型可见；
**§10.2 x_status 报错已定案修复**（根因是 cfg 漏 getter，不是 schema）；**§10.1 桌面观察
已实证突破**——DSH 带 `--force-renderer-accessibility` 启动后 UIA 树 14 → 599 个元素，
旗标已写进开始菜单与桌面快捷方式，当前 DSH 实例已带旗标运行。

---

## 0b. 0.5.10 交接轮做了什么（2026-10-02 下午）

| 项 | 结论 |
|---|---|
| §10.2 x_status「value is not lossless JSON」 | **已定案并修复**。宿主在 schema 校验之前先做无损 JSON 快照，嵌套 `undefined` 整单拒绝；真因是 `cfg` 漏写 `bannerIdleExitMs` getter → `x_status` 返回 undefined 字段。此前怀疑的「两层嵌套 schema」「未声明的 updateMirror」都不是凶手。宿主源码其实**一直抽得到**（app.asar 内 JS 未压缩，`readAsarIndex` 可按偏移读任意文件），规则全文已沉淀进 `docs/DSH-SDK-CONTRACT.md §13` |
| 插件侧契约门 | 新增 `lib/core/lossless.js`（宿主 `snapshotJsonValue` 规则镜像），`defineXTool` 在返回边界执行，坏点点名到路径——测试当场能抓这类翻车 |
| 连带修复 | ① 设置页「浮窗空闲自动退出」是死设置（cfg 漏 getter 所致），已复活；② `tool.js` 缺必填键分支抛 `ControlXError` 却没 import（真触发是 ReferenceError），已修；③ `updater.js` 文件头教人算 integrity 的段落按 0.5.8 终态改写；④ `dsh-plugin.json` version 0.3.0 → 0.5.10 |
| §10.1 桌面观察 | **假设证实**。DSH 默认不向 UIA 物化渲染器无障碍树（14 个无名 Pane）；带 `--force-renderer-accessibility` 重启后同一窗口 599 个元素（侧栏/会话树/按钮/文本全可读）。UIA 二次查询不触发动态物化。旗标已持久化进两个快捷方式（开始菜单 + 桌面），撤销 = 删掉快捷方式里的参数；代价是渲染器多一份无障碍树开销 |
| 验证 | `npm test` 79/79（新增 4 个回归测试）、`npm run verify:contract` 22/22（宿主真校验器判定） |
| 0.5.10 生产端到端验收（DSH 新会话实测） | **5/5 通过**（首测浏览器超时，按恢复路径重测通过，报告见仓库根 `验收报告-dsh-control-x-v0.5.10-2026-10-02.md`）：x_status 修复 ✅（version=0.5.10、bannerIdleExitMs=120000、updateMirror 在）、eagerRegister ✅（x_activate 幂等返回 toolCount=0）、桌面观察 ✅（108 元素、具名控件齐全）、浏览器闭环 ✅（重测，title=百度、ARIA 树约 4000 字符） |
| 0.5.11 复验（同日追加） | **3/3 通过**：版本回归门 ✅（0.5.11、lossless 修复未回归）、导航 ✅（快速路径约 6s 一次成功，read/close 干净）、桌面抽查 ✅（135 元素 / 693ms，无退化）。**证据缺口（如实）**：本次未触发 gotoWithGrace 宽限分支——该路径现有 tests/browser-idle 3 个单元测试覆盖，生产触发要等机器网络再落坏时段，未覆盖 ≠ 验收失败 |
| 浏览器超时排查（同日，两轮） | **不是插件缺陷，是本机 Chromium 网络栈间歇性波动**：curl 始终 0.23s，但浏览器侧导航在「好时段」0.4~1s 完成、在「坏时段」连 30s 都到不了 DCL；好坏时段分钟级交替，shell 与 DSH 宿主内都中招（DSH 验收两轮首测均超时、wait 后成功；shell 累计 11 测 3 失败）。系统代理与 WPAD 自动检测均关闭，无死代理、无残留锁；成因无法确证，不猜（§7.1 纪律）。**0.5.11 已内置缓解**：goto 超时后追加 10s 宽限等待（慢启动转成功），超时文案点名恢复路径（tabs 查状态 → wait/重试一次） |
| 浏览器 profile 单例锁（验收注意） | DSH 侧插件的 headless Edge 实例会长期持有默认 profile 的锁（实测 9 进程、存活数小时——面板在用就不回收，属设计内行为）。DSH 开着时从外部用默认 profile 启动会报 `Target page, context or browser has been closed`：**外部验收一律带 `DHCX_BROWSER_PROFILE` 指定独立 profile**，这不是缺陷 |

---

## 1. 坐标

| 项 | 值 | 出处 |
|---|---|---|
| 仓库 | `https://github.com/Mlte0907/dsh-control-x.git` | `git remote -v` |
| 本地 | `D:\Users\sun_w\.dsh\dsh-control-x` | 工作目录 |
| HEAD | `39f0599` = 0.5.9 | `git log --oneline -1` |
| 同步状态 | `## main...origin/main`，无 ahead/behind；**工作树干净** | `git status -sb` + `--porcelain` 输出为空 |
| 安装面 | `D:\Users\sun_w\.dsh\profiles\desktop\node_modules\dsh-control-x` | 盘上 `package.json` 的 version=0.5.9 |
| pin | `github:Mlte0907/dsh-control-x#39f0599a0fb53dbbb061b8f6c10f04292e0d0b99` | profile `package.json` |
| 宿主 | DeepSeek Harness 桌面版（Electron，`Chrome_WidgetWin_1`），PID 18908 | `x_desktop_apps` |

**git tag 停在 `v0.2.1`** —— 0.2.2 及以后全部只靠 commit 里的 `package.json` 版本号识别，没有 tag。发版若依赖 tag 会出错。

---

## 2. 这个插件做什么

给 DSH 的 Agent 一套「先观察、后动作」的统一控制面，共 **22 个工具**
（`npm run verify:contract` 实测输出 22 个名字，脚本期望值也是 22）：

| 组 | 工具 | 门控 |
|---|---|---|
| 常驻入口 | `x_status`、`x_activate` | 无 |
| 浏览器（CDP 无头） | `x_browser_tabs` `open` `read` `click` `fill` `press` `scroll` `shot` `wait` `close` | `browserEnabled` |
| 桌面语义（UIA 零注入） | `x_desktop_apps` `tree` `press` `value` `scroll` `launch` | `desktopEnabled` |
| 桌面物理（显式打扰） | `x_desktop_mouse_click` `type` `key` | `trustPhysicalInput` + 用户空闲检测 |
| 视觉 | `x_vision_describe` | 无（故意不设总开关） |

> ⚠️ 口头资料里常说的「20 个工具」是 `x_activate` 的**新增数**，不含常驻的 2 个。20 + 2 = 22。
> `README.md:101` 写的是「激活后 20 + 门控 2」，口径正确但容易被误读成 20。

---

## 3. 配置面（全部 16 项 + 默认值）

权威定义在 `lib/index.js:53-92`。
**注意：只有标了 `.volatile()` 的字段才进设置页表单并可编辑**（宿主 Config-form generation 的契约，见 `index.js:46-52` 注释）。

| key | 默认 | 说明 |
|---|---|---|
| `headless` | `true` | 无头运行（不打扰原则） |
| `browserPath` | `''` | 空 = 自动发现 Chrome/Edge |
| `ttlMs` | `30000` | 观察快照有效期，过期后动作拒绝并要求重新观察 |
| `allowedApps` | `[]` | 桌面白名单，空 = 不限制 |
| `physicalIdleMs` | `3000` | 物理输入的用户空闲阈值 |
| **`trustPhysicalInput`** | **`false`** | 「全权操控」。**当前为 false**，物理键鼠仍逐次审批 |
| `browserEnabled` | `true` | 浏览器总开关 |
| `ignoreCertErrors` | `false` | 忽略 HTTPS 证书校验 |
| `browserIdleMs` | `300000` | 浏览器空闲回收（0 = 不回收） |
| `desktopEnabled` | `true` | 桌面总开关 |
| `inputButtonEnabled` | `true` | 输入框 X-Agent 按钮 |
| `visionModel` | `''` | `''` = 系统推荐 / `'random'` / `'provider/model'` |
| `desktopBanner` | `true` | Windows 原生置顶浮窗 |
| `bannerIdleExitMs` | `120000` | 浮窗空闲自动退出 |
| `updateMirror` | `''` | 自更新镜像前缀，只在直连全失败后用 |
| **`eagerRegister`** | **`true`** | 启动即注册全部工具（0.5.9 新增，见 §7.3） |

**取值优先级**（`lib/index.js:190-222` 的 `read` / `pick`）：
volatile 字段实时读宿主 → 否则读文件覆盖层 → 否则用代码默认值。

> **关键：运行期必须用 getter 实时读，不能在 apply 时拷贝快照。**
> 宿主的 volatile 提交是原地更新、不重挂载（`index.js:188-189` 注释）。

**用户级覆盖落盘路径**：`~/.dsh/cache/dsh-control-x/config.json`
（`lib/browser/watch.js:32` 的 `CONFIG_PATH`）。
**该文件当前不存在** → 所有设置都在跑代码默认值。

---

## 4. 代码地图

```
lib/
  index.js              入口：Config / apply / 工具注册 / 面板挂载      (368 行)
  skill.js              control-x skill 全文
  client.js             设置页 + 右侧浏览器面板 + 输入框按钮           (76 KB，最大)
  vision.js             视觉模型枚举与挑选
  banner-win.js         Windows 原生置顶浮窗进程管理
  banner-overlay.ps1    浮窗的 PowerShell 实现
  core/
    tool.js             defineXTool 工厂：参数校验 + 返回值自检
    host-schema.js      property-map DSL → raw JSON Schema 规范化
    updater.js          自更新全链路                                  (525 行)
    errors.js           ControlXError
    guard.js
  browser/
    manager.js          无头实例生命周期（9 进程 / 数百 MB 常驻）
    tools.js            10 个 x_browser_*
    watch.js            /api/x-control/* 路由 + 配置覆盖读写
    discover.js         浏览器可执行文件发现
  desktop/
    manager.js  tools.js  physical.js  activity.js
    uia-helper.ps1      UIA 树读取
tests/                  9 个 .mjs，npm test 全跑
scripts/
  host-contract-verify.mjs   抽宿主真校验器判全部工具
  m1-verify.mjs / m2 / m3    三条闭环验收（真实联网 / 真起应用）
  dsh-selfcheck.mjs
spikes/                 探测脚本（browser / koffi / uia / charmap / physical）
docs/
  INSTALL-DESKTOP.md    桌面安装细节
  DSH-SDK-CONTRACT.md   宿主 API 与平台事实
  HANDOVER.md           本文件
CHANGELOG.md            49 KB，21 个版本，最完整的历史
PROPOSAL.md             36 KB，原始提案
```

`.evidence/`（约 14 MB 截图与日志）、`*.tgz`、`.zcodeignore`、`package-lock.json`
**全部在 `.gitignore` 里**，不要当交付物。

---

## 5. 版本史（只列决策性的）

| 版本 | 改了什么 | 为什么 |
|---|---|---|
| 0.2.6 | 桌面横幅 / 浮窗 | |
| 0.3.0 | 面板对齐 ZCode（lucide 工具栏、自由视口尺寸、登录窗口流程、选元入草稿） | |
| **0.3.1** | **修 21 个工具 100% 注册失败且用户零感知** | `output.schema` 误用 property-map 方言，被宿主 `assertSupportedJsonSchema` 全数拒收，而 `safeRegister` 用 try/catch 吞异常只写日志。修法 = 注册边界统一规范化 + 新增契约门。**这是本项目最严重的历史缺陷** |
| 0.4.0 | 顶部横幅更新日志与版本号；`x_vision_describe` | |
| 0.5.2–0.5.4 | 横幅按用户口径重做；**浮窗按需拉起**（不操控就没有 powershell 进程） | |
| 0.5.5 | 全权操控开关 + 横幅改版 | |
| 0.5.6 | 去掉打字效果 + 修内容层间歇性空白（每帧无条件赋 Size/Region 导致） | |
| **0.5.7** | **插件自带版本号 + 自更新按钮**（设置页底部「版本与更新」） | 插件市场实测在 0.5.5 上静默卡住 |
| **0.5.8** | **停止自写 pnpm integrity** | 0.5.7 写的值是错的，把整个 profile 的 pnpm 打死（见 §7.1） |
| **0.5.9** | **`eagerRegister` 默认 true，启动即注册全部工具** | 20 个工具注册成功但模型工具表里永远没有（见 §7.3） |

---

## 6. 自更新机制（0.5.7 起）

设置 →「X-Agent操控」→ 底部「版本与更新」。
打开设置页时自动比对 GitHub `main` 上的 `package.json` 版本号，**有真新版才出按钮**。

**换装流程**（`lib/core/updater.js:368` `applyUpdate`）：

```
downloading → extracting → backing-up → installing → syncing
```

1. `resolveSha` 取 `main` 的 commit
2. `downloadTarball`（codeload）
3. `extractTarGz` —— **纯 Node 解 tar**（`zlib.gunzipSync` + ustar 解析）
4. 备份到 `<profile>/.cx-backups/dsh-control-x-<旧版本>-<时间戳>`
5. `renameSync(pkgRoot, backupDir)` + `cpSync(src, pkgRoot)`
6. `syncProfileSources` 改 profile 的 `package.json` 与 `pnpm-lock.yaml`

**为什么必须 rename 而不是原地写**：已安装文件是 pnpm 内容寻址 store 的**硬链接**
（`updater.js:11-16` 记录实测 `banner-overlay.ps1` 有 3 个链接，含 `.pnpm-store\v11\files\<sha512>`）。
原地覆写 = 改坏那个按 sha512 命名的共享 blob。换装后链接数回到 1。

**解 tar 的防御**（`updater.js:218` `extractTarGz`）：挡住 `../` 越界路径、GNU 长名；符号链接只报不建。

**网络策略**（`updater.js:116` `fetchAny`）：
直连重试 2 次（下载 3 次），退避 400/800ms，**只对「没有答复」的失败重试**
（超时、ECONNRESET、DNS）；HTTP 4xx/5xx 是明确答复，不重试。超时 15s（从 8s 放宽）。
镜像**只在直连全失败后**用。

**本机实测：直连比 `gh-proxy.org` 快 1.4~3 倍**（raw 中位 78ms vs 247ms；codeload 523ms vs 731ms）。
镜像解决的是「连不上」，不是「慢」。**不要挂全局代理** —— 会拖慢整台机器的其它网络。

---

## 7. 三条血泪教训

### 7.1 不要往别人维护的锁文件里写校验和（0.5.7 → 0.5.8）

0.5.7 装机约 26 分钟后，用户卸载插件市场失败：

```
[ERR_PNPM_TARBALL_INTEGRITY] .../dsh-control-x/tar.gz/8468716...
  Wanted "sha512-6aKk12KWx5zF72..."   <- 0.5.7 写进锁文件的
  Got    "sha512-ebhAMc6K2NeDaoL..."   <- pnpm 自己下载到的
```

**根因不是「哈希算错」，是「自己算出来的哈希本就不该被信任」。**
当时的论据是「pnpm 对 gitHosted tarball 的 integrity 就是 tarball 字节的 sha512-base64」——
那一条在旧 commit `a3d64ff` 上实测逐字符成立，于是被**推广**到了新 commit。
而同一 commit `8468716` 连下三次哈希完全稳定（`ebhAMc6K...`），说明装机当时拿到的字节
和 pnpm 后来拿到的不是同一份（codeload 归档可能重新生成过）。**成因未查清，也不该猜。**

**代价与收益完全不成比例**：写对了没人在意，写错一个字符就让该 profile 下**所有**
pnpm 操作（更新别的插件、装新的、卸载市场）全线卡死。
**一个插件的更新动作，能让整个 profile 失去安装能力。**

**终态**：只改 `sha`（保留，防止 `pnpm install` 把插件悄悄打回旧版本），
**绝不写 integrity**，并把本插件那行上可能存在的 integrity **删掉**，交给 pnpm 自己写。
形状对齐同 profile 里本来就正常工作的 `dsh-teams-x`。

### 7.2 `safeRegister` 的 try/catch 会把 100% 注册失败变成用户零感知

0.3.1 的教训。注册失败只写一条日志（`index.js:272-274`），
面板在、skill 在、工具一个都没有，用户看不出任何异常。
**任何「注册 N 个工具」的地方，都必须有契约门数出真实数字** —— 这就是 `npm run verify:contract` 存在的理由。

### 7.3 工具可见性是第四道关，和审批 / 总开关无关

排查时极易把三件事搅在一起：

| 关 | 表现 | 解法 |
|---|---|---|
| **工具可见性** | 模型工具表里没有该工具，**连调用都发不出** | 启动即注册（`eagerRegister`） |
| 总开关 `browserEnabled` / `desktopEnabled` | 工具在表里，执行时报「已关闭」 | 设置页打开 |
| 物理输入审批 `trustPhysicalInput` | 工具在表里，物理键鼠被逐次拦下 | 设置页打开 |

0.5.7 之前把 20 个工具藏在 `x_activate` 后面，而 `apply()` 阶段注册的 2 个一直在。
**宿主侧注册是成功的**（`x_activate` 明确返回 `{ok:true,activated:true,toolCount:20}`），
但模型工具表里始终没有它们 —— 重启 DSH、换新会话、会话中途调 `x_activate`，全都不行。
两组工具之间**唯一的差别就是注册时机**，由此推断：宿主在会话建立时发一次工具清单，
之后注册的不再补发。

0.5.9 按此加 `eagerRegister`（默认 true），**新会话实测证实推断成立**。

代价是 20 份工具 schema 常驻上下文。`eagerRegister=false` 可退回旧行为，
但那条路现在看走不到模型面前，所以默认不关。

---

## 8. 本机环境事实（踩过坑才知道的）

1. **没有可执行的 pnpm**。PATH 上只有 corepack shim，首次用要联网下载。
   所以锁文件必须手写改 —— 改 sha 这件事可行且必要。
2. **不能用外部 `tar`**。实测 `execFile('tar', …)` → `spawn EPERM`。
   换装要发生在 DSH 宿主进程里，多一个外部二进制就多一份「这台机器上有没有、能不能跑」的变量。
3. **受限沙箱里 Playwright 拉不起浏览器**：`npm run verify:m1/m2/m3` 会
   `launchPersistentContext: spawn EPERM`。**这不是缺陷，是沙箱边界**，别替它们宣称通过。
   （插件自己跑的 `x_browser_*` 走插件的无头实例，不受影响。）
4. **Windows 上强制杀掉命令会以 exit code 1 收场**（无信号标记），别当成命令失败。
5. **`git show > file` 会把 LF 转成 CRLF**，三份 hash 因此全不一样。
   **比对文件内容前先归一化换行。**
6. 宿主 checkout 路径 `D:\Programs\DeepSeek Harness\resources\app.asar\dsh\` **在本机不存在**；
   但 `verify:contract` 能从运行中的 app.asar 里抽到 `@deepseek-ai/dsh-tools` 的**真校验器**
   （判定依据就打印在脚本输出里）。
7. 宿主把工具清单接口全挡在鉴权后面
   （`/api/tools`、`/api/agent/tools`、`/api/session/tools`、`/api/plugins` 全 401）。
8. 用户级插件配置目录 `~/.dsh/cache/dsh-control-x/` 当前不存在配置文件。

---

## 9. 怎么验证（命令 + 本轮实测结果）

```sh
npm test                 # → tests 79 / pass 79 / fail 0        ✅ 0.5.10 交接轮实测
npm run verify:contract  # → 22 个工具全过，缺席 0 个            ✅ 本轮实测
npm run verify:m1        # 浏览器闭环（需真联网 + 起进程）
npm run verify:m2        # 桌面语义闭环（起 charmap 并清理）
npm run verify:m3        # 门控 + skill + 物理输入闭环
npm run selfcheck        # 插件自检
```

运行时自查（需鉴权，插件路由挂在 `/api/x-control/*`）：

```
GET  /api/x-control/update    → {current, latest, updateAvailable, status, checkedAt, error}
GET  /api/x-control/activity  → {overlay, active, running, graceMs}
```

**本轮已验证的功能验收**（新会话内实测，非推断）：

| 检查 | 结果 |
|---|---|
| 工具表可见性 | 22 个全在 ✅ |
| `x_desktop_apps` | 列出 1 个前台窗口（PID 18908）✅ |
| `x_desktop_tree` | 成功，`elapsedMs: 288` ✅（但内容浅，见 §10.1） |
| `x_browser_open` baidu | 标题「百度一下，你就知道」✅ |
| `x_browser_read` | **完整 ARIA 树，`truncated:false`** ✅ |
| 盘上版本 / pin | 0.5.9 / `39f0599a` ✅ |
| 锁文件形状 | `specifier` + `version`，**无 integrity** ✅ |

---

## 10. 未决问题（带已排除项，不要重走）

### 10.1 桌面观察质量差 —— ✅ 0.5.10 交接已定案（宿主侧问题，非插件缺陷）

`x_desktop_tree` 对 Electron 应用（DSH 本体）只返回 13 个无名 Pane，根因**已证实**：
Chromium 渲染器无障碍树未物化。DSH 带 `--force-renderer-accessibility` 重启后同一窗口
14 → 599 个元素。旗标已写进开始菜单与桌面两个快捷方式；DSH 关窗是隐藏到托盘，
重启要用任务管理器结束进程或 `taskkill /F /IM "DeepSeek Harness.exe"`。
原生 Win32 应用不受影响。详情见 `docs/DSH-SDK-CONTRACT.md §11` 末行。

- ~~未证实：推测是 Chromium 渲染进程未启用 accessibility 树~~ → 已证实并持久化。
- 已排除：不是权限问题；不是总开关；**UIA 客户端二次查询不会触发动态物化**（实测）；
  DSH 的 19387 端口是内部 API 不是 CDP，无法免重启启用。

### 10.2 `x_status` 返回 `value is not lossless JSON` —— ✅ 0.5.10 交接已定案修复

真因：宿主在 schema 校验**之前**先做无损 JSON 快照（嵌套 `undefined` 整单拒绝，
报错不点名），而 `cfg` 漏写了 `bannerIdleExitMs` getter → `x_status` 返回 undefined
字段。交接单原先的两个线索（两层嵌套 schema、未声明的 updateMirror）都不是凶手。
修复与规则全文见 §0b 与 `docs/DSH-SDK-CONTRACT.md §13`。

### 10.3 两处文档不一致 —— ✅ 0.5.10 交接已修

1. `updater.js` 文件头已按「不写 integrity」终态改写（含事故原因）。
2. `dsh-plugin.json` version 已追平 package.json（现均为 0.5.10）。

### 10.4 其它

- ~~git tag 停在 `v0.2.1`~~ → 0.5.10 交接轮已按 commit message 里的版本号补齐 tag。
- 插件市场（`dshmarket = github:dsh-market/dsh-market`）当前**又装回来了**，
  在 `dependencies` 和 `bundles`（13 项）里都在。← 未处理，留待用户定夺。
- ~~设置页「版本与更新」卡片的渲染至今没人亲眼看过~~ → 用户已亲验并确认有问题，
  0.5.12 整体重做（手动检查无反馈 / 重启提醒被例行检查冲掉 / 文案挤行 / 检查与更新
  按钮不分），快照→视图映射抽成纯函数 `resolveUpdateView` 全分支单测。
  **待用户对 0.5.12 的卡片做最终目检**。

---

## 11. 操作手册

### 升级（推荐路径，不依赖市场）

1. 改 `package.json` 的 `version`（以及 §10.3-2 提到的 `dsh-plugin.json`），推 `main`。
2. 用户在设置页点「更新到 0.x.y」→ 等完成 → **重启 DSH**。
   换装替换的是文件本体，新代码要重启才加载；返回值 `restartRequired` 会如实提示，不假装热更新。

### 手动回滚

```
ren  profiles\desktop\node_modules\dsh-control-x  →  .cx-backups\dsh-control-x-<版本>-<时间戳>\
ren  profiles\desktop\package.json.cx-bak-<时间戳>      →  package.json
ren  profiles\desktop\pnpm-lock.yaml.cx-bak-<时间戳>     →  pnpm-lock.yaml
```

**必须三样一起回滚** —— 只回文件不回锁文件，下次 `pnpm install` 会把插件打回旧版本。

### 当前盘上的回滚点（都已确认无用，可删）

```
profiles\desktop\.cx-backups\
  dsh-control-x-0.5.5-2026-10-01T18-22-21
  dsh-control-x-0.5.7-2026-10-01T18-56-00
  dsh-control-x-0.5.8-2026-10-01T20-30-01     ← 最新，可回滚到 0.5.8
profiles\desktop\   package.json.cx-bak-×3   pnpm-lock.yaml.cx-bak-×4
profiles\desktop\.bak-cx-0.5.2-20261001-220429    （0.5.2 时代遗留）
```

---

## 12. 发版检查清单

- [ ] `package.json` 的 `version` 改了
- [ ] `dsh-plugin.json` 的 `version` **同步改了**（§10.3-2）
- [ ] `CHANGELOG.md` 加了条目，**写清「为什么」而不只是「改了什么」**（这个文件的价值全在这）
- [ ] `npm test` 全绿、`npm run verify:contract` 输出 22/22
- [ ] `lib/core/updater.js` 文件头注释与 `syncProfileSources` 的结论一致（§10.3-1）
- [ ] 确认没有任何地方往 `pnpm-lock.yaml` 写 integrity（§7.1）
- [ ] 推 `main`
- [ ] 告诉用户需要**重启 + 开新会话**（工具表在会话建立时就定死了，当前会话不会变）

---

## 附：一句话记忆

**往别人维护的文件里写「校验和」这种字段，代价和收益完全不成比例。**
写对了没人在意，写错一个字符就让整条工具链停摆。
以后只改语义明确、格式唯一的字段（版本号、commit sha），校验和交给它的主人自己算。