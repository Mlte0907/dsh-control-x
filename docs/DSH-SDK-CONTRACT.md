# DSH SDK 契约笔记（证据版）

> 来源：本机 `D:\Programs\DeepSeek Harness\resources\app.asar` 内提取的 `@deepseek-ai/dsh-tools@0.2.0-rc.2`（与本机 DSH CLI 0.2.0-rc.2 严格同版本）与 `@deepseek-ai/cordis-plugin-loader`。
> 提取脚本：`/tmp/asar-tool/extract5.mjs`，产物：`%TEMP%\dsh-sdk-evidence\`。
> 注意：npm 公共源上的 `@deepseek-ai/dsh-tools` 只有 0.0.1-rc.1，**不可作为契约依据**；运行时 `import '@deepseek-ai/dsh-tools'` 由宿主解析到自己 node_modules 的 0.2.0-rc.2（ego-browser README:200 同款机制描述）。

## 1. defineTool（lib/index.js:838）

```js
defineTool({
  name, description,
  parameters,            // schema DSL；property 支持 required:true + description/title/default/examples
  output: {
    schema,              // schema DSL（canonical output declaration）
    render(args, value), // 返回 content block 数组
    presentationMeta?,   // 可选
  },
  execute(args, exec),   // args 已校验；返回值必须匹配 output.schema
  timeoutMs?,            // 声明性（README:232：注册表本身不强制，需 wrapper）
  deferLoading?,         // true = 延迟加载定义
  projectContent?, finalizeContent?, presentCall?, presentResult?,
  isConcurrencySafe?,    // 只读工具可并行（PTC 模式并发依据）
})
```

- 参数校验在 execute 前自动进行，违规抛 `ToolArgsError`（index.js:863-865）。
- schema DSL 支持 `string/number/integer/boolean/null/array/object/json/oneOf`（README:60）。

## 2. exec 表面（grep lib/index.js 实测）

`exec.agent`（会话）、`exec.name`、`exec.signal`（协作取消，必须遵守）、`exec.callId`、`exec.rootCallId`、`exec.parent`、`exec.arguments`、`exec.token`、`exec.schema`、`exec.deferContext(context)`、`exec.concludeTurn`。

## 3. 图片结果的处理（lib/index.js:1384）

```js
if (!result.isError && result.content.some((block) => block.type === "image"))
  exec.deferContext(createUserMessage({...}));
```
→ render 返回的 content 数组**支持 `{type:'image'}` block**，管线会把它转为延迟附加上下文给多模态模型。截图工具按此返回。

## 4. 工具注册与管线

- `ctx.tools.register(defineTool(...))` 即可让 schema 自动进入系统提示装配（README:28）。
- 管线：`tools/pre-execute`（allow/deny/ask）→ `ctx.tools.guard()`（单调守卫）→ `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`（README:85, 105）。
- 失败不结束回合：未知/抛错工具成为结构化错误（`UNKNOWN_TOOL`）（README:123）。
- `ctx.tools.restrict(filter)` 可做 Skill 门控的收窄机制（README:81）——M3 门控实现的候选 API（需再验证其按 agent 生效的确切用法）。

## 5. 插件装载（cordis-plugin-loader）

- Entry 选项：`{ id, name(模块说明符), config, group?, disabled?, inject? }`（src/config/entry.ts:10-23）。
- cordis.patch.yml 的 `insert:` 列表即创建 Entry（988 的 cordis.patch.yml 是活例：`- insert: [- id: dsh-computer-use, name: dsh-computer-use, config: {...}]`）。
- `name` 由 loader 从 baseUrl（profile node_modules）解析——所以插件包必须出现在 profile 的 node_modules 里（链接或安装）。
- 插件模块形态（三个参考项一致 + cordis 协议）：ESM 导出 `name` / `inject` / `Config`(schemastery) / `apply(ctx, config)`（或 default 对象）。

## 6. 宿主服务（三个参考项实际注入过的）

`tools`（必需）、`approval`（D:guard.js:98 `ctx.approval.request({agent, toolName, reason})`）、`subprocess`（C: `ctx.subprocess.spawn`）、`webServer`（C: `ctx.get('webServer').register`，可选注入 `ctx.inject(['webServer'], cb)`）、`settings`、`logger`、`llm`（D 的 vision 模式）。
→ dsh-control-x M0 只依赖 `tools`；M3 加 `approval`；观察窗阶段加 `webServer`。

## 7. 对骨架的直接影响

1. 纯 ESM JS、无构建步骤即可装载（988 同形态，`"type":"module"` + `main`）。
2. Config 用 `@deepseek-ai/schemastery`（公共 npm 有 3.18.x）。
3. 工具前缀 `x_`（用户要求），与所有参考项前缀（ego_/screen_/computer_/app_）无重叠。

## 8. register() 接受原生 JSON Schema 普通对象（lib/index.js:2878-2887）

```js
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function")
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  // timeoutMs 校验；"run_code" 为保留名；无任何品牌/模块身份检查
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), ...);
}
```
→ 注册面是**普通对象 + 原生 JSON Schema**（README:60 "A raw JSON Schema (JsonSchemaNode) is the wire-level counterpart"）。
defineTool 只是"DSL→JSON Schema + 参数校验包装"的糖。本插件因此完全自研工具工厂（lib/core/tool.js），
自带参数校验，零宿主包依赖。注意：注册时不校验 parameters schema，校验责任在工具自身（宿主只在
execute 外有包装的前提是用了 defineTool）。

## 9. 依赖解析决策：不 import 任何 @deepseek-ai/dsh-*

证据链：
- profile 的 node_modules 只有 `@deepseek-ai/cosmokit` 与 `@deepseek-ai/schemastery`（实查），无 dsh-tools；
- 宿主的 dsh-tools 在 app.asar 内部，普通 node 解析不可达；
- npm 公共源的 dsh-tools 是 0.0.1-rc.1，与宿主 0.2.0-rc.2 版本漂移（988 打包 0.1.2-rc.1 与其宿主严格配对）；
- vendor 整包会级联拉进 cordis/dsh-scope/dsh-llm 等一串宿主包。
结论：像 §8 那样直接构造注册对象，宿主包依赖归零。schemastery 保留（profile 与本地均有，纯配置用途）。

## 10. 插件部署契约（M0-6 实测，2026-09-30）

| 事实 | 证据 |
|---|---|
| **desktop profile 被 Electron 应用独占**，CLI 一切操作被拒 | `dsh --profile desktop --dump-config` → `error: profile "desktop" is managed exclusively by the Electron application` |
| 官方安装命令 | `dsh plugin --profile <name> add <包名\|tgz>`（CLI help 实文）；底层 pnpm |
| 本地 tarball 安装后，pnpm 把包**软链回项目目录** | `profiles/cx-headless/node_modules/dsh-control-x -> D:\Users\sun_w\.dsh\dsh-control-x`（改代码无需重装） |
| pnpm 默认拦截 koffi 的 install 脚本（`ERR_PNPM_IGNORED_BUILDS`），但 koffi 自带 win32 预编译产物，功能不受影响 | 本地 npm 安装同样跳过脚本，`spikes/koffi-probe.mjs` 实测通过 |
| CLI 临时 profile 可用 `--patch` 注入插件（免改 profile 文件） | `dsh --profile cx-headless --patch .../cordis.patch.yml` → dump-config 组合树含本插件 |
| 插件激活验证 | 首跑报 `dsh-control-x: failed to import`（模块不在测试 profile）；官方安装后重跑，该警告消失 → 导入与激活成功（app-boot/lib/index.js:3910：`fiber === undefined` 才报此错） |
| headless 一次性模式 | `dsh --profile <name> "任务"`（CLI help）；LLM 凭据缺失会挡住 agent 循环（`MISSING_CREDENTIAL`），但发生在插件激活**之后** |
| **desktop profile 的正式安装路径**（M1 待办） | 只能走应用内插件管理（dshmarket / 插件 UI）或按 ego-browser README:124 的 profile package.json 双改法 + 重启应用；**不要**手工往被管理的 node_modules 塞 junction（已实测创建后移除） |

遗留：端到端"模型调用 x_status"需要 LLM 凭据（cx-headless 无凭据被 `MISSING_CREDENTIAL` 挡住）；
desktop 应用自带凭据，M1 在其中做首次真实调用验证。

## 11. 桌面半边平台事实（M2 实测，2026-09-30）

| 事实 | 证据与影响 |
|---|---|
| Win11 打包应用（记事本）的 `Start-Process -PassThru` pid 与窗口进程**不对应**（返回的进程无顶层窗口），且可能复用既有进程——**按 pid 杀进程会误伤用户窗口** | 实测 Notepad.exe 两个 pid：11284（用户实例，持 2 个窗口）与 22888（我们启动的，无窗口）。→ M2 验收改用经典 Win32 进程 charmap；`x_desktop_launch` 的 pid 标注为 best-effort；kill 类清理必须只针对"自己启动的经典进程" |
| PowerShell 5.1 重定向 stdio 默认用控制台代码页（GBK）——含中文的 .ps1 与 JSON 输出全部乱码 | `.ps1` 必须 UTF-8 带 BOM；helper 首行强制 `[Console]::{In,Output}Encoding = UTF8`。实测修正后 "字符映射表" 等中文标题/名称完好 |
| PS 5.1 的 `,@()` 包装 + `@()` 重收 + ConvertTo-Json 组合会产生**嵌套数组**（实测 `patterns=[["Invoke"]]`），且 `??` 运算符不可用 | helper 内一律用逐元素 `+=` 重建数组；已修（这正是 M2 首轮验收"找不到可写元素"的根因） |
| charmap 字符网格是自绘控件，UIA 不可见（roles census：Pane1/Text4/Edit1/Button2/CheckBox1/ComboBox1/List1/ListItem188） | 语义动作验证改用：ValuePattern 写入"复制字符"Edit + Toggle"高级查看(V)"复选框（ToggleState Off→On 直接证据） |
| 观察树有 maxElements 上限（默认 200，可调 500）——元素计数类断言会被 cap 掩盖 | 效果验证应使用**状态字段**（value/toggleState）而非元素计数 |
| 观察性能：499 元素全量 ~850ms（含 PowerShell 进程启动 ~1s 另计） | 每工具调用 spawn 一次 helper 可接受；常驻 helper 为后续优化项 |
| x_desktop_value 写入"复制字符"Edit、Toggle 高级查看，全程未抢焦点（charmap 窗口 focused=false） | §6.7-3 在 Windows 上成立的直接证据 |
