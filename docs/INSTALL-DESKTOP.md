# 在 desktop profile 正式安装 dsh-control-x

> 关键约束（实测证据，docs/DSH-SDK-CONTRACT.md §10）：**desktop profile 被 Electron 应用独占管理**，
> CLI 对它的一切操作被拒（`profile "desktop" is managed exclusively by the Electron application`），
> 也不能手工往它的 node_modules 塞链接。安装必须在**应用关闭状态下**进行，或走应用内插件管理。

## 方式 A（推荐）：应用内插件管理

1. 打包：项目根目录 `npm pack`，得到 `dsh-control-x-0.0.1.tgz`。
2. 打开 DSH 桌面端 → 插件管理（或 dshmarket）→ 从本地 tarball 安装。
3. 按提示重启应用。

## 方式 B：手动双改 profile（应用关闭后执行）

依据 ego-browser 在 Desktop 2.0.5+ 的兼容记录：profile 依赖名必须与包实际 name 一致，
且 **`package.json` 的依赖键和 `dsh.profile.bundles` 条目两处都要加**。

1. 完全退出 DSH 桌面端（托盘图标也要退出）。
2. 打包：`npm pack` → 得到 tarball 的绝对路径，例如 `D:\Users\sun_w\.dsh\dsh-control-x\dsh-control-x-0.0.1.tgz`。
3. 编辑 `~\.dsh\profiles\desktop\package.json`：
   - `dependencies` 增加：`"dsh-control-x": "file:<tarball 绝对路径>"`
   - `dsh.profile.bundles` 数组增加：`"dsh-control-x"`
4. 重启桌面端。首次会话中调用 `x_activate` 激活完整工具面（加载 `control-x` skill 查看操作手册）。

## 验证安装

应用重启后新开会话，让 Agent 调用 `x_status`：应返回 `activated` 字段与配置摘要；
再调用 `x_activate` 后即获得全部 19 个 `x_browser_*` / `x_desktop_*` 工具。

## 卸载

应用内插件管理移除；或反向执行方式 B 的两处编辑后重启。
