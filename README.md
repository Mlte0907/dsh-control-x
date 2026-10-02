# dsh-control-x

DSH（DeepSeek Harness）插件：为 Agent 提供统一的"控制面"——

- **浏览器半边**：无头（headless）驱动本机 Chrome/Edge（CDP），全程零可见窗口、零焦点抢占；
- **桌面半边**：Windows UIA 无障碍树观察 + 元素级语义动作，物理输入仅作显式兜底；
- **不打扰是硬约束**：不弹窗、不抢焦点、不动真实鼠标（详见 [PROPOSAL.md](PROPOSAL.md) §6.7）。

## 安装（新手三步走）

### 第 1 步：安装插件

**桌面端用户（harness-desktop）**：

1. 到本仓库 [Releases](https://github.com/Mlte0907/dsh-control-x/releases) 下载 `dsh-control-x-x.x.x.tgz`；
2. 打开 DSH 桌面端 → 插件管理（或插件市场）→ 从本地 tarball 安装；
3. 按提示重启应用。

**CLI 用户（headless / tui / web profile）**：

```sh
# ① 安装包（若提示 allowBuilds：按提示在 <profile>/pnpm-workspace.yaml 写入
#    "allowBuilds:\n  koffi: true" 后重跑本条命令）
dsh plugin --profile <你的profile名> add https://github.com/Mlte0907/dsh-control-x.git

# ② 启动时带补丁激活（--from-default-profile 模板 profile 实测需要这一步）：
dsh --profile <你的profile名> \
  --patch "<DSH主目录>/profiles/<你的profile名>/node_modules/dsh-control-x/cordis.patch.yml" \
  "你的任务"
```

> desktop profile 被 Electron 应用独占管理，CLI 对它不生效——桌面端请走方式一。
> 两种方式都要求 Node ≥ 22（DSH 内置运行时已满足）与 Windows 10/11（本插件实测平台）。

### 第 2 步：重启并激活

安装后**重启宿主**，开一个新会话，让 Agent：

```text
调用 x_activate 激活控制面，然后调用 x_status 告诉我状态
```

### 第 3 步：加载操作手册

会话中让 Agent 加载 `control-x` skill（内含完整的观察-动作-验证循环教学），之后就能自然地下达任务，例如：

```text
用无头浏览器打开 bing.com 搜索今天的日期，截图给我
```

## 更新（不依赖插件市场）

**设置 →「X-Agent操控」→ 底部「版本与更新」**：

- 打开设置页时自动比对一次 GitHub 上的最新版本；
- 有新版才出现 `更新到 0.x.y` 按钮，点一下即换装；
- 换装会把当前版本备份到 `<profile>/.cx-backups/`，删掉该目录即回滚；
- 换装替换的是插件文件本体，**重启 DSH 后新版本才生效**。

自己做更新的原因：2026-10-02 实测插件市场在 0.5.5 上静默卡住——用户"更新并重启"之后
`profile/package.json` 的 pin 与盘上版本都还停在 0.5.5，市场日志里连一条 0.5.6 的记录都没有。

实现见 `lib/core/updater.js`。两个关键约束（改代码前请先读那里的注释）：

- **绝不原地写已安装的文件**——它们是 pnpm store 的硬链接，原地写会改坏共享 blob；
- **`pnpm-lock.yaml` 要一起改对**——否则将来任何一次 `pnpm install` 都会把插件悄悄打回旧版本。

连不上时会自动重试（直连 2 次，下载 3 次，只对超时/连接重置这类"没有答复"的失败）。
还可以在同一张卡片里填「更新镜像」前缀（默认留空），**只在直连全部失败后才走镜像**——
本机实测直连比 `gh-proxy.org` 快 1.4~3 倍，镜像解决的是"连不上"，不是"慢"。

## 卸载

- 桌面端：插件管理里移除；
- CLI：`dsh plugin --profile <名字> remove dsh-control-x`。

## 状态

**v0.5.19（2026-10-03）**：**下线「改宿主启动快捷方式加无障碍旗标」，代之以树/截图双路径。**
起因是那条功能本身站不住（三条实测证据）：`--force-renderer-accessibility` 在现代 Chromium
上**已无效**（playwright chromium-1246 实测加与不加都是同一份树）；替代方案
`SPI_SETSCREENREADER` 是**一次性闩锁**、关不掉（关后仍 159 元素，而"从未开启"时只有 13），
等于用一次就永久生效；只改 `.lnk` 也覆盖不到"开始菜单搜索 / 宿主自重启"等入口。
更重要的是那条路本身越界——**插件不该凌驾于宿主之上**，宿主能给的能力应当通过宿主拿。
现在 Electron 应用走 ZCode 式的 `strategy:auto`：树能用就用树，`x_desktop_tree` 会用
`degraded=true` 机器可读地告诉你"这棵树不能当主干"（DSH 首次观察实测 13 元素 / 4 有名字）；
不能用就 `x_desktop_shot`（`PrintWindow` 窗口级截图，不受遮挡影响）+ `x_desktop_click_at`
（纯坐标点击，走全套物理门控）。

**`x_desktop_shot` 默认关闭**，需要在设置页「X-Agent操控 → 电脑控制 → 允许窗口截图」
显式打开。理由是一处**树有而截图没有的缺口**：无障碍树只给控件结构，而 `x_desktop_value`
遇到密码框是**直接拒绝**的；截图是像素，这层保护不存在——自绘控件的密码框在树里可能
压根没标出来，截图就把明文拍下来了。绝大多数机器用不到这条（现代 Chrome/Edge 138+
默认已开原生无障碍树），建议保持关闭。

插件不再修改任何应用或宿主的启动配置。
详见 [CHANGELOG.md](CHANGELOG.md)。

**v0.5.18（2026-10-02）**：**修复面板 HTTP 接口无鉴权的高危缺陷**——`/api/x-control/*`
注册在宿主 webServer 上，而 webserver 自身不做任何鉴权（宿主 README 明写"不提供内建
TLS 或应用层鉴权"），宿主自己的 Host/Origin 栅栏只作用在它那条 `/api` 路由上。
实测同一个跨站请求：宿主接口 403、插件接口 200，而这条路上挂着 `POST /update`
（下载安装新版本）等有副作用的端点（当时还有 `POST /host-accessibility` 改宿主启动
快捷方式，已于 0.5.19 整条下线）。
现在按参照实现 `Fisfzy/dsh-ego-browser` 补了三层栅栏（Host 必须回环 / POST 的 Origin
必须同源 / POST 必须 application/json）+ 请求体上限。同期修掉两个"文档写着能用、
实际必然失败"的功能（`x_desktop_type`/`x_desktop_key` 省略可选 `element`、`x_vision_describe`
的 `tab_id` 捷径）、「全权操控」开关改了要重载才生效、自更新下载不再钉 commit sha、
以及成功换装泄漏临时目录（原 68 个 / 11.7 MB）。见 [CHANGELOG.md](CHANGELOG.md)。

**v0.3.1（2026-10-01）**：**修复 21 个工具全部注册失败且用户侧无感知的致命缺陷**
（`output.schema` 误用 property-map 方言，被宿主 `assertSupportedJsonSchema` 全数拒收，
而 `safeRegister` 吞异常只写日志）。修复走注册边界统一规范化 + 新增宿主契约测试与
`npm run verify:contract`（直接抽宿主真校验器判工具）。18/18 单测、
真宿主契约全绿、m1/m2/m3 与 selfcheck 全绿。详见 [CHANGELOG.md](CHANGELOG.md)。

**v0.3.0（2026-10-01）**：面板全面对齐 ZCode——同款 lucide 图标工具栏（后退/前进/刷新/
**自由尺寸**/**元素选择**/⋯菜单）、尺寸栏（W×H + 50%~200% 缩放）、标签 chip 关闭、
**登录窗口流程**（同 profile 临时有头登录，登录态落盘）、选元结果**加入会话输入框草稿**；
修复 skill 注册缺 `source` 导致的整轮运行失败、面板碎图、非默认视口点击偏移、
设置页开关隐形。14/14 单测全绿。

UI 面：**设置页「X-Agent操控」**（`settings.section`；无头模式 / 浏览器路径 / 快照 TTL /
桌面白名单 / 物理输入空闲阈值 / 忽略证书校验 / 浏览器空闲回收 / 三个总开关，热保存到
走宿主 `configForms` 热保存）+ **右侧栏「X-Agent浏览器」**（CDP JPEG 实时画面、
地址栏与前进后退刷新、外部打开、清除数据；点击/滚轮/按键回传到无头浏览器，不影响你的桌面）
+ 会话输入框的 **X-Agent** 按钮。

桌面安装细节见 [docs/INSTALL-DESKTOP.md](docs/INSTALL-DESKTOP.md)；
变更历史见 [CHANGELOG.md](CHANGELOG.md)；宿主 API 与平台事实见
[docs/DSH-SDK-CONTRACT.md](docs/DSH-SDK-CONTRACT.md)。

### 工具面（激活后 20 + 门控 2）

- 常驻：`x_status` / `x_activate`（门控入口，幂等）
- 浏览器：`x_browser_tabs` / `x_browser_open` / `x_browser_read` / `x_browser_click` / `x_browser_fill` / `x_browser_press` / `x_browser_scroll` / `x_browser_shot` / `x_browser_wait` / `x_browser_close`
- 桌面语义（零注入）：`x_desktop_apps` / `x_desktop_tree` / `x_desktop_press` / `x_desktop_value` / `x_desktop_scroll` / `x_desktop_launch`
- 桌面物理（显式打扰，三重门控）：`x_desktop_mouse_click` / `x_desktop_type` / `x_desktop_key`
- 桌面兜底（树不可用时）：`x_desktop_shot`（窗口级截图，**默认关闭**）/ `x_desktop_click_at`（窗口内坐标点击）
- 视觉：`x_vision_describe`（截图 → 视觉模型 → 文字描述，给不支持图片输入的会话模型补眼睛；模型在设置页选，默认「系统推荐」）

### 本地开发

```sh
npm install            # 依赖（schemastery / playwright-core / koffi）
npm test               # 宿主外冒烟测试（node --test）
npm run verify:contract # 宿主契约验收（抽 app.asar 内真校验器判 24 个工具）
npm run verify:m1      # 浏览器控制面闭环验收（真实联网）
npm run verify:m2      # 桌面语义控制闭环验收（启动 charmap 并清理）
npm run verify:m3      # 门控 + skill + 物理输入闭环验收
npm run spike:browser  # 无头浏览器驱动探测
npm run spike:koffi    # FFI 探测（只读）
npm run spike:uia      # PowerShell UIA 树探测（只读）
```

测试 profile（cx-headless）中的插件经 pnpm 软链回本目录，改代码即时生效；用
`dsh --profile cx-headless --patch ./cordis.patch.yml "任务"` 做无头验证。

插件实例正在运行时会独占 `browser-profile` 的单例锁，验收脚本另行指定独立 profile 即可并行跑：

```sh
DHCX_BROWSER_PROFILE=$(mktemp -d) npm run verify:m1
```

## 命名约定

工具前缀统一 `x_`（如 `x_status`、`x_browser_*`、`x_desktop_*`）。

## 许可

[MIT](LICENSE)
