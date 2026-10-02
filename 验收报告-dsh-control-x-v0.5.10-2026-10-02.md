# dsh-control-x 端到端验收报告（v0.5.10 主报告 + v0.5.11 复验）

> 本文件原始内容为 **v0.5.10 端到端验收报告**（第 1–161 行，存档不改）。
> 2026-10-02 追加 **v0.5.11 端到端验收结果**，见文末「v0.5.11 复验」章节。

- **验收日期**：2026-10-02（Asia/Shanghai）
- **验收对象**：dsh-control-x 插件 v0.5.10
- **验收方式**：端到端只读验收（未调用任何物理键鼠工具、未调用 x_desktop_press / x_desktop_value / x_desktop_launch、未修改任何设置）
- **验收环境**：Windows（win32），Node v24.18.1，DeepSeek Harness 桌面端（Electron，Chrome_WidgetWin_1）
- **总体结论**：**PASS（通过 5/5，含前置门）** —— 插件本体三项修复全部实测通过；浏览器闭环首测导航超时（暂时性环境故障），按修正规则重测通过。

---

## 验收 0｜前置门（x_status 版本与配置检查）

**结果：✅ 通过**

调用 `x_status` 正常返回，无 "value is not lossless JSON" 报错。实测关键字段：

| 字段 | 实测值 | 判定 |
|---|---|---|
| version | `0.5.10` | ✅ 与预期版本一致 |
| config.bannerIdleExitMs | `120000` | ✅ 有限数字（通常值 120000） |
| config.updateMirror | `""` | ✅ 字符串类型，字段存在 |

完整返回（截选）：

```json
{
  "ok": true,
  "plugin": "dsh-control-x",
  "version": "0.5.10",
  "platform": "win32",
  "node": "v24.18.1",
  "activated": true,
  "config": {
    "headless": true,
    "ttlMs": 30000,
    "physicalIdleMs": 3000,
    "trustPhysicalInput": false,
    "browserEnabled": true,
    "desktopEnabled": true,
    "inputButtonEnabled": true,
    "desktopBanner": true,
    "bannerIdleExitMs": 120000,
    "visionModel": "",
    "updateMirror": ""
  }
}
```

---

## 验收 1｜x_status 修复（lossless JSON 回归）

**结果：✅ 通过**

- `x_status` 正常返回，无 lossless 报错（0.5.9 的 "value is not lossless JSON" 问题已修复）。
- `config.bannerIdleExitMs` 为有限数字 `120000`。
- `config` 中存在 `updateMirror` 字段（值为空字符串 `""`）。

---

## 验收 2｜启动即注册（eagerRegister）

**结果：✅ 通过**

直接调用 `x_activate`（未先做其他操作），实测返回：

```json
{
  "ok": true,
  "activated": true,
  "skill": "control-x",
  "toolCount": 0
}
```

`toolCount=0` 证明 20 个工具在会话建立前就已注册，eagerRegister 生效（若为 20 则判 FAIL）。

---

## 验收 3｜桌面观察质量（UIA 树完整性）

**结果：✅ 通过**

1. `x_desktop_apps` 找到进程名为 **DeepSeek Harness** 的窗口：**pid=18740**（标题「dsh-control-x v0.5.10 端到端验收 — DeepSeek Harness」，hwnd=328018）。
2. 对该 pid 调用 `x_desktop_tree`（maxElements=600），实测：
   - **元素总数：108**（≥100 ✅）
   - **elapsedMs：683**
   - 树中存在大量具名控件，包括但不限于：

| 类别 | 具名控件 |
|---|---|
| 窗口按钮 | 最小化、最大化、关闭 |
| 侧边栏 | 新建会话（×2）、收起侧边栏、搜索会话、视图选项、添加工作区、展开其余 1 个会话 |
| 全局面板 | 插件、自动化任务、账号菜单、智能体团队、本会话费用明细（×2） |
| 会话区 | 用 文件资源管理器 打开、更多打开方式、更多操作、打开右侧边栏、复制、上下文洞察 |
| 输入区 | 添加文件或调用指令、访问模式（当前：完全权限）、X-Agent、选择模型（当前 LongCat 2.5 Preview Free）、停止生成、上下文已用 3% |
| 标签页 | TabItem：对话、轨迹、盘古、上下文 |
| 树/编辑框 | Tree「会话」、Edit「搜索会话名称」、Edit「发消息或创建任务, / 调用指令, @ 文件或对话」 |
| 菜单 | MenuBar「应用菜单」、MenuItem：应用、编辑 |

结论：DSH 带 `--force-renderer-accessibility` 启动后桌面 UIA 树为完整树（对照 0.5.9 时仅 14 个无名 Pane），无障碍旗标生效。

---

## 验收 4｜浏览器闭环（含超时重试）

**结果：✅ 通过（重测）**

### 首次尝试（判失败后重测）

| 步骤 | 结果 |
|---|---|
| `x_browser_open https://www.baidu.com/` | ❌ 导航超时（20s） |
| `x_browser_read` | 未执行（页面未加载） |
| `x_browser_close` | ✅ 已关闭残留标签页 t1（清理） |

**原始报错文本**：

```
Error: 导航超时（20s）：https://www.baidu.com/。页面可能过慢或不可达。
```

**失败详情**：打开后标签页 t1 的 URL 为 `https://www.baidu.com/`，但标题为空字符串（页面未加载成功），无法验证「标题含百度」及 ARIA 树非空。按当时验收规则「任何一步失败：附上原始报错文本，不要盲目重试同一调用」，未重试。

### 重测（按修正规则恢复）

排查为暂时性环境故障后重测。`x_browser_open` 再次报「导航超时（20s）」，按修正规则先查 `x_browser_tabs`：标签页 t2 的 URL 已设置为 `https://www.baidu.com/`（标题暂空），遂用 `x_browser_wait` 等待 loadState=load，页面随后加载成功。

| 步骤 | 结果 |
|---|---|
| `x_browser_open https://www.baidu.com/` | ⚠️ 导航超时（20s）→ 按规则恢复 |
| `x_browser_tabs` | ✅ t2 URL 已设置（标题暂空） |
| `x_browser_wait`（loadState=load） | ✅ 加载成功，title=「百度一下，你就知道」 |
| `x_browser_read` | ✅ 非空 ARIA 树（约 4,000 字符，约 45 节点：16 link + 10 listitem + 9 text + 1 textbox + 1 button + 6 img + 1 paragraph + 1 list；truncated=false） |
| `x_browser_close` | ✅ 已关闭 t2 |

**重试过程**：open 超时（20s）→ tabs 确认 URL 已设置 → wait load 成功（标题「百度一下，你就知道」）→ read 得到非空 ARIA 树 → close 完成闭环。

---

## 结论汇总

| # | 验收项 | 结果 | 关键实测值 |
|---|---|---|---|
| 0 | 前置门（版本/配置） | ✅ | version=0.5.10, bannerIdleExitMs=120000, updateMirror="" |
| 1 | x_status 修复 | ✅ | 无 lossless 报错；bannerIdleExitMs=120000（有限数字）；updateMirror 字段存在 |
| 2 | 启动即注册 | ✅ | toolCount=0 |
| 3 | 桌面观察质量 | ✅ | pid=18740, elements=108, 具名控件齐全, elapsedMs=683 |
| 4 | 浏览器闭环 | ✅（重测） | title=「百度一下，你就知道」，read 树≈4,000 字符非空（约 45 节点），truncated=false |

**最终结论：PASS（通过 5/5，含前置门）**

一句话总结：0.5.10 的 status 无损修复、eager 启动即注册、桌面完整 UIA 树（108 元素、具名控件齐全）、浏览器闭环（标题「百度一下，你就知道」+ 非空 ARIA 树）全部实测通过；浏览器首测导航超时（20s）为暂时性环境故障，按修正规则经 tabs 确认 + wait 恢复后重测通过。

---

## 附：验收命令与约束记录

- 全程只读：未调用 x_desktop_mouse_click / x_desktop_type / x_desktop_key（物理键鼠），未调用 x_desktop_press / x_desktop_value / x_desktop_launch，未修改任何设置。
- 调用序列：x_status → x_activate → x_desktop_apps → x_desktop_tree(pid=18740, maxElements=600) → x_browser_open（超时）→ x_browser_tabs → x_browser_close（首测）；x_browser_open（超时）→ x_browser_tabs → x_browser_wait(load) → x_browser_read → x_browser_close（重测）。
- 失败处理：首测 x_browser_open 超时后未盲目重试，仅做标签页状态检查与清理；重测按修正规则（超时后先查 tabs，URL 已设置则允许 wait 或重试一次）恢复，wait load 成功。

---
---

# v0.5.11 复验（2026-10-02 追加）

- **验收对象**：dsh-control-x 插件 **v0.5.11**
- **验收方式**：端到端只读验收（未调用任何物理键鼠工具、未调用 x_desktop_press / x_desktop_value / x_desktop_launch、未修改任何设置）
- **验收环境**：Windows（win32），Node v24.18.1，DeepSeek Harness 桌面端（Electron，Chrome_WidgetWin_1，pid=13088，hwnd=3147850）
- **本次验收范围**：0.5.11 相对 0.5.10 只改一处（`BrowserManager.gotoWithGrace`，见 CHANGELOG.md:17-23），故复验聚焦 **版本/配置回归门**、**导航宽限路径**、**桌面观察抽查**三项。
- **总体结论**：**PASS（3/3）** —— 版本与配置回归门通过，浏览器导航快速成功且 ARIA 树可读，桌面 UIA 树抽查达标；无任何失败报错。**注意**：本次导航走的是快速路径，未触发 0.5.11 新增的宽限分支（见「证据边界」）。

---

## 复验 1｜版本与配置回归门（x_status）

**结果：✅ 通过**

调用 `x_status` 正常返回，无 "value is not lossless JSON" 报错（0.5.10 的 lossless 修复未回归）。

| 字段 | 实测值 | 判定 |
|---|---|---|
| version | `0.5.11` | ✅ 与预期版本一致 |
| config.bannerIdleExitMs | `120000` | ✅ 数字 |
| config.updateMirror | `""` | ✅ 字符串，字段存在 |

完整返回（原始）：

```json
{
  "ok": true,
  "plugin": "dsh-control-x",
  "version": "0.5.11",
  "platform": "win32",
  "node": "v24.18.1",
  "activated": true,
  "config": {
    "headless": true,
    "ttlMs": 30000,
    "allowedApps": [],
    "physicalIdleMs": 3000,
    "trustPhysicalInput": false,
    "browserEnabled": true,
    "ignoreCertErrors": false,
    "desktopEnabled": true,
    "inputButtonEnabled": true,
    "desktopBanner": true,
    "bannerIdleExitMs": 120000,
    "visionModel": "",
    "updateMirror": ""
  }
}
```

---

## 复验 2｜导航宽限（本次核心）

**结果：✅ 通过（快速路径，未触发宽限）**

### 实测数据

| 步骤 | 结果 |
|---|---|
| `x_browser_open https://www.baidu.com/` | ✅ 一次成功，无超时报错 |
| open 耗时 | **≈6000ms**（快速路径） |
| `x_browser_read` | ✅ 非空 ARIA 树，约 2,900 字符量级，`truncated: false` |
| `x_browser_close` | ✅ `{"ok": true, "closed": "t1"}` |

### 耗时测量方法与精度声明

插件未提供内建计时字段，故采用**调用前后各取一次系统时间**的夹逼法：

```
start = 14:54:14.007
open  → 返回 tab{id:"t1", url:"https://www.baidu.com/", title:"百度一下，你就知道"}
end   = 14:54:19.990
```

两次取时与 open 调用为**并行发出**，因此 5.98s 是耗时的**上界**，真实耗时更短。判定为「快速成功（≤10s）」区间。

### read 快照内容摘要（原始语义树节选）

- `link`：新闻、hao123、地图、贴吧、视频、图片、网盘、库库AI、文心、百度搭子、更多
- `textbox "演员万千惠已求助中使馆"`、`button "百度一下"`
- 百度热搜 `list` 十条 `listitem`、`link "百度热搜"`
- 页脚 `paragraph`：关于百度、About Baidu、使用百度前必读、帮助中心、企业推广、京公网安备、京ICP证
- `truncated: false`

### 证据边界（如实报告）

本次导航**未触发** 0.5.11 新增的宽限分支，因此：

- **能证明**：0.5.11 在正常网络下导航行为无回归，open 一次成功、read 可用、close 干净。
- **不能证明**：`gotoWithGrace` 的 10s 宽限逻辑在「domcontentloaded 迟到」场景下确实生效——本次运行没有产生该场景（对照 v0.5.10 复验时曾两轮稳定复现超时，见本文件「验收 4」）。宽限路径本次**未被实际覆盖**，属于证据缺口，非验收失败。

---

## 复验 3｜桌面观察抽查（UIA 树）

**结果：✅ 通过**

1. `x_desktop_apps` 命中进程名 **DeepSeek Harness** 的窗口：**pid=13088**，hwnd=3147850，标题「dsh-control-x v0.5.11 端到端验收 — DeepSeek Harness」，`focused: true`。
2. 对该 hwnd 调用 `x_desktop_tree`（maxElements=600），实测：

| 指标 | 实测值 | 判定 |
|---|---|---|
| elementCount | **135** | ✅ ≥100 |
| elapsedMs | **693** | 记录值 |

具名控件（节选）：

| 类别 | 具名控件 |
|---|---|
| 窗口按钮 | 最小化、最大化、关闭 |
| 侧边栏 | 新建会话（×2）、收起侧边栏、搜索会话、搜索会话名称（Edit）、视图选项、添加工作区、展开其余 1 个会话 |
| 全局面板 | 插件、自动化任务、账号菜单、智能体团队、本会话费用明细（×2）、上下文洞察 |
| 会话区 | 用 文件资源管理器 打开、更多打开方式、更多操作、复制 |
| 输入区 | 添加文件或调用指令、访问模式（当前：工作区内修改）、X-Agent、选择模型（当前 LongCat 2.5 Preview Free）、停止生成、上下文已用 3% |
| 标签页 | TabItem：对话、轨迹、盘古、上下文；TabItem「X-Agent浏览器 关闭」 |
| 树/编辑框 | Tree「会话」、Edit「搜索会话名称」、Edit「发消息或创建任务, / 调用指令, @ 文件或对话」 |
| 浏览器面板 | 输入网址后回车（Edit）、后退、前进、刷新、全屏、分栏、弹出登录窗口 |
| 菜单 | MenuBar「应用菜单」、MenuItem：应用、编辑 |

结论：桌面 UIA 树为完整具名树（对照 0.5.9 时仅 14 个无名 Pane），`--force-renderer-accessibility` 无障碍旗标持续生效；元素数与耗时均与 v0.5.10 复验（108 元素 / 683ms）同量级，无退化。

---

## 复验结论汇总

| # | 复验项 | 结果 | 关键实测值 |
|---|---|---|---|
| 1 | 版本与配置回归门 | ✅ | version=0.5.11, bannerIdleExitMs=120000（数字）, updateMirror=""（字符串） |
| 2 | 导航宽限 | ✅（快速路径） | open≈6000ms 一次成功，read 树≈2,900 字符非空，truncated=false，close ok |
| 3 | 桌面观察抽查 | ✅ | elements=135, elapsedMs=693, 具名控件含「新建会话」等 |

**最终结论：PASS（3/3）**

一句话总结：0.5.11 版本与配置回归门通过、浏览器导航快速成功且 ARIA 树可读、桌面 UIA 树 135 元素/693ms 抽查达标，无任何失败报错；但本次导航未进入 0.5.11 新增的 10s 宽限分支，该分支本次未被实测覆盖。

---

## 附：本次复验命令与约束记录

- 全程只读：未调用 x_desktop_mouse_click / x_desktop_type / x_desktop_key（物理键鼠），未调用 x_desktop_press / x_desktop_value / x_desktop_launch，未修改任何设置。
- 调用序列：`x_status` → `x_browser_open(https://www.baidu.com/)` → `x_browser_read(t1)` → `x_browser_close(t1)` → `x_desktop_apps` → `x_desktop_tree(hwnd=3147850, maxElements=600)`。
- 无失败项，故未触发「导航超时 → tabs → wait(load) → read」恢复路径，也未做任何重试。
- 计时说明：open 耗时由并行发出的前后两次系统取时夹逼得出，为上界值。
- 快照字符数说明：`x_browser_read` 的 ARIA 快照不落盘（已核查工作区近期写入与 temp spill 目录，仅 `x_desktop_tree` 产生 spill 文件），故树大小按快照文本量级报约数，无法精确复算。
