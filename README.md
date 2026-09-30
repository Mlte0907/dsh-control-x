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

## 卸载

- 桌面端：插件管理里移除；
- CLI：`dsh plugin --profile <名字> remove dsh-control-x`。

## 状态

**v0.3.1（2026-10-01）**：**修复 21 个工具全部注册失败且用户侧无感知的致命缺陷**
（`output.schema` 误用 property-map 方言，被宿主 `assertSupportedJsonSchema` 全数拒收，
而 `safeRegister` 吞异常只写日志）。修复走注册边界统一规范化 + 新增宿主契约测试与
`npm run verify:contract`（直接抽宿主真校验器判 21 个工具）。18/18 单测、
21/21 真宿主契约、m1/m2/m3 与 selfcheck 全绿。详见 [CHANGELOG.md](CHANGELOG.md)。

**v0.3.0（2026-10-01）**：面板全面对齐 ZCode——同款 lucide 图标工具栏（后退/前进/刷新/
**自由尺寸**/**元素选择**/⋯菜单）、尺寸栏（W×H + 50%~200% 缩放）、标签 chip 关闭、
**登录窗口流程**（同 profile 临时有头登录，登录态落盘）、选元结果**加入会话输入框草稿**；
修复 skill 注册缺 `source` 导致的整轮运行失败、面板碎图、非默认视口点击偏移、
设置页开关隐形。14/14 单测全绿。

UI 面：**设置页「X-Agent操控」**（`settings.section`；无头模式 / 浏览器路径 / 快照 TTL /
桌面白名单 / 物理输入空闲阈值 / 忽略证书校验 / 浏览器空闲回收 / 三个总开关，热保存到
`~/.dsh/cache/dsh-control-x/config.json`）+ **右侧栏「X-Agent浏览器」**（CDP JPEG 实时画面、
地址栏与前进后退刷新、外部打开、清除数据；点击/滚轮/按键回传到无头浏览器，不影响你的桌面）
+ 会话输入框的 **X-Agent** 按钮。

桌面安装细节见 [docs/INSTALL-DESKTOP.md](docs/INSTALL-DESKTOP.md)；
变更历史见 [CHANGELOG.md](CHANGELOG.md)；宿主 API 与平台事实见
[docs/DSH-SDK-CONTRACT.md](docs/DSH-SDK-CONTRACT.md)。

### 工具面（激活后 19 + 门控 2）

- 常驻：`x_status` / `x_activate`（门控入口，幂等）
- 浏览器：`x_browser_tabs` / `x_browser_open` / `x_browser_read` / `x_browser_click` / `x_browser_fill` / `x_browser_press` / `x_browser_scroll` / `x_browser_shot` / `x_browser_wait` / `x_browser_close`
- 桌面语义（零注入）：`x_desktop_apps` / `x_desktop_tree` / `x_desktop_press` / `x_desktop_value` / `x_desktop_scroll` / `x_desktop_launch`
- 桌面物理（显式打扰，三重门控）：`x_desktop_mouse_click` / `x_desktop_type` / `x_desktop_key`

### 本地开发

```sh
npm install            # 依赖（schemastery / playwright-core / koffi）
npm test               # 宿主外冒烟测试（node --test）
npm run verify:contract # 宿主契约验收（抽 app.asar 内真校验器判 21 个工具）
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
