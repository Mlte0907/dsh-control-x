# dsh-control-x v0.5.10 端到端验收报告

- **验收日期**：2026-10-02（Asia/Shanghai）
- **验收对象**：dsh-control-x 插件 v0.5.10
- **验收方式**：端到端只读验收（未调用任何物理键鼠工具、未调用 x_desktop_press / x_desktop_value / x_desktop_launch、未修改任何设置）
- **验收环境**：Windows（win32），Node v24.18.1，DeepSeek Harness 桌面端（Electron，Chrome_WidgetWin_1）
- **总体结论**：**FAIL（通过 4/5，含前置门）** —— 插件本体三项修复全部实测通过；浏览器闭环因导航超时未完成。

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

## 验收 4｜浏览器闭环

**结果：❌ 失败**

| 步骤 | 结果 |
|---|---|
| `x_browser_open https://www.baidu.com/` | ❌ 导航超时（20s） |
| `x_browser_read` | 未执行（页面未加载） |
| `x_browser_close` | ✅ 已关闭残留标签页 t1（清理） |

**原始报错文本**：

```
Error: 导航超时（20s）：https://www.baidu.com/。页面可能过慢或不可达。
```

**失败详情**：打开后标签页 t1 的 URL 为 `https://www.baidu.com/`，但标题为空字符串（页面未加载成功），无法验证「标题含百度」及 ARIA 树非空。按验收规则「任何一步失败：附上原始报错文本，不要盲目重试同一调用」，未重试。

**可能原因**：本机无头浏览器到外网（百度）不可达或过慢，需排查网络连通性后重跑本项（或更换验收目标站点）。

---

## 结论汇总

| # | 验收项 | 结果 | 关键实测值 |
|---|---|---|---|
| 0 | 前置门（版本/配置） | ✅ | version=0.5.10, bannerIdleExitMs=120000, updateMirror="" |
| 1 | x_status 修复 | ✅ | 无 lossless 报错；bannerIdleExitMs=120000（有限数字）；updateMirror 字段存在 |
| 2 | 启动即注册 | ✅ | toolCount=0 |
| 3 | 桌面观察质量 | ✅ | pid=18740, elements=108, 具名控件齐全, elapsedMs=683 |
| 4 | 浏览器闭环 | ❌ | 导航超时 20s，title 未获取，read 树未执行 |

**最终结论：FAIL（通过 4/5，含前置门）**

一句话总结：0.5.10 的 status 无损修复、eager 启动即注册、桌面完整 UIA 树（108 元素、具名控件齐全）三项实测通过，但无头浏览器打开百度导航超时（20s）导致浏览器闭环未完成，需排查本机无头浏览器外网连通性后重跑第 4 项。

---

## 附：验收命令与约束记录

- 全程只读：未调用 x_desktop_mouse_click / x_desktop_type / x_desktop_key（物理键鼠），未调用 x_desktop_press / x_desktop_value / x_desktop_launch，未修改任何设置。
- 调用序列：x_status → x_activate → x_desktop_apps → x_desktop_tree(pid=18740, maxElements=600) → x_browser_open → x_browser_tabs → x_browser_close。
- 失败处理：x_browser_open 超时后未盲目重试，仅做标签页状态检查与清理。
