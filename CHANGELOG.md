# 更新日志

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
