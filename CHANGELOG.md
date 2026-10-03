# 更新日志

## 0.5.29（2026-10-03）

**skill 撤掉最后一条「排序型死规则」，并修掉一句与真机相反的物化断言。**

用户原则（2026-10-03 定）：**不写死规则，判断留给 Agent。**0.5.26 撤掉的是
**主题型**死规则（「先桌面后网页」「遇人机识别换桌面端」），但**排序型**的还在——
本轮就是它在起作用。

### 真机 A/B：同模型、同类任务，差别只在手册

| 会话 | 手册状态 | MiniMax-M3 的第一步 |
|---|---|---|
| `949b10c8`（0.5.25） | 有「先桌面后网页」 | 「我先按手册的**先桌面后网页原则**检查桌面端」→ `x_desktop_apps` |
| `17abb0ca`（0.5.28） | 该处方已撤，**阶梯还在** | 「启动浏览器操作」→ `x_browser_open(https://www.doubao.com)`，**桌面一次没查** |

撞登录墙后用户在会话里当场质问：**「桌面有豆包，为什么你会第一时间去打开网页？」**

根因在 `lib/skill.js` 的旧标题：

> `## 优先级阶梯（逐级下沉，高级别可用时禁止用低级别）`
> `2. 浏览器工具；3. 桌面语义动作；`

浏览器排在桌面前，还写明「禁止用低级别」——**这就是一条替 Agent 选路的处方**。
撤掉主题规则后，行为自然回落到它。

### 改法：拆成两节，一节给事实、一节保安全

1. **`## 走哪条路：浏览器与桌面是并列的，没有先后`**——只给事实，不给顺序：
   `x_desktop_apps` 只列有窗口的应用、浏览器是无头的、**本机客户端与网页端常常是两套
   登录态**、两条都能走时选能观察到结果的那条、**路选错了不是事故**（如实说再换）。
2. **`## 动作方式的打扰等级`（这条保留先后）**——因为打扰程度真的不同：
   connector → 语义/无头动作（`x_browser_*` 全部 + `x_desktop_press/value`）→ 物理键鼠
   （本轮顺带把 `x_desktop_click_at` 补进物理清单：它**确实**移动真实光标、走全套门控，
   之前漏列）。3→4 的先后是**安全约束**（防打扰），不是路线选择，必须留。

### 修掉与真机相反的物化断言

原文：「…这种场景重试观察是有意义的（**与 Electron 的永不物化不同**）」。

2026-10-03 三次真机会话实测，**被这么断言的那个应用就是 Electron**
（`Chrome_WidgetWin_1`），而且每次都物化：

| 会话 | degraded=true | 翻成 false |
|---|---|---|
| `ce9c69d3` | 14 元素 | 打字+回车后 40 秒 → 117 元素 |
| `32c83987` | 14 元素 | 窗口有内容后 → 115 元素 |
| `17abb0ca` | 14 元素 | 打字回车后 → 119 元素（窗口内容变化时又退回 19） |

现在改成陈述事实：**物化取决于窗口状态**（在不在前台、有没有真实内容），不是内核类型；
「从不物化」和「还没物化」**返回结果一模一样、当场分不出来**，可依据的只有状态变没变。
`degraded` 段落里那句「**重试观察无用**——这不是时序问题」也一并改成按状态判断（原话太绝对，
与上表相反）。

### 两道门（先红后绿验证过会响）

- `degraded-fallback`：skill 不得出现「优先级阶梯」排序、必须并列声明，且**排序撤了事实
  不能一起删**（`x_desktop_apps 只列` / `无头` / `两套登录态` / 物理键鼠仍过空闲门控 四条全查）；
- `degraded-fallback`：不得出现「永不物化」，必须把依据写成窗口状态、并说明两种情况分不出来。

### 本轮**决定不动**的两件（留档，避免下次又翻案）

- **提示词被模型改写**（同任务实测字数：deepseek-flash 19 字、longcat 14 字、M3 **255 字**）——
  是模型风格，skill/插件没有任何相关文案。要在会话提示词里约束，不改插件。
- **空闲门把自己注入的输入当成"用户在操作"**：19:05:56 打字 → 19:05:59 回车被挡
  （2422ms < 3000ms），`ce9c69d3` 14:02:03 同款（2891ms）。每次「打字→回车」必被卡 3 秒。
  属插件逻辑，待办。

## 0.5.28（2026-10-03）

**修 `x_vision_describe` 的 attachment 路径——装着 0.5.27 也照样崩。**

这是 0.5.27 没盖住的另一半：0.5.27 修的是 `llm.stream` 少一层 `await`，而
attachment 这条路**根本走不到那里**，它在参数校验那一步就炸了。

### 两个真机会话的实证（都是**字段齐全**的 image 引用）

| 会话 | 装的版本 | 时间 | 结果 |
|---|---|---|---|
| `session-949b10c8` | 0.5.25 | 13:50:44 | `Error: boolean true is not iterable` |
| `session-32c83987` | 0.5.27 | 14:08:59 | 同一句；14:09:03 改传数组 → 「需要 object 类型，**实际是 object**」 |

同一会话里走 `tab_id` 的两次调用（14:15:36 / 14:21:04）**都成功**——坏的只有
attachment 分支，也就是 degraded 桌面窗口唯一的那条图源。

### 根因：`required: true` 被两套方言各解释一次

- `core/host-schema.js` 认为它是「**我对父级**必填」→ 提升成宿主收到的 `required` 数组；
- `core/tool.js` 认为它是「**我自己的**必填键列表」→ 拿去 `for...of` → 遍历布尔值 →
  `TypeError: boolean true is not iterable`。

触发条件只有一个：某参数节点**同时**有 `properties` 和 `required: true`，且模型真传了对象。
全量扫描 22 个工具，命中点**有且只有** `x_vision_describe.parameters.attachment`。

### 三处改动

1. `core/tool.js`：`required` 只认字符串数组——布尔值在子级无从自查，父级已由
   `toHostSchema` 负责。不改变任何既有校验语义，只消掉整个崩溃类别。
2. `vision/tools.js`：删掉 attachment 的 `required: true`。它把宿主看到的
   `parameters.required` 变成了 `["attachment"]`，对模型宣布"必填"——可 `tab_id`
   捷径和工具自拍（execute 里的 shot 兜底）都是合法替代，**真机只传 tab_id 成功过两次**。
   "必填"恰好把模型每次都推向那条会崩的路。
3. `core/tool.js`：类型不符时点名 `array`。`typeof [] === 'object'`，旧文案会说
   「需要 object 类型，实际是 object」——模型照着改只会越改越错。

### 为什么 136/136 全绿照样翻车（这次把门补在真正会响的地方）

既有测试全部**直接调 `describeImage()`**，绕过了 `wrappedExecute` 的参数校验；
0.5.25 加的那道门也只查「不得是裸 `{type:'object'}`」——补上 `properties` 就过，
而这恰恰是让布尔 `required` 进入 `for...of` 的前提。新增四道门（先红后绿验证过会响）：

- `smoke`：布尔 `required` 不得炸校验器（改前：TypeError 真抛）；
- `smoke`：数组冒充 object 必须报 `array`（改前：报 `object`）；
- `p1-fixes`：**用真工具、真参数**走 attachment 路径（改前：崩在 `core/tool.js:77`）；
- `release-hygiene`：宿主看到的 `parameters.required` 不得含 `attachment`（改前：`["attachment"]`）。

## 0.5.27（2026-10-03）

**修复 0.5.24 亲手引入的致命 bug——视觉通道从那次改动起就完全不通了。**

这就是用户说的「越修越不行」的直接原因。

### 根因：`for await` 循环体里加 `break`，V8 就不再解包 Promise

宿主 `llm.stream()` 的真实形态是 **`async` 函数返回 generator**（即
`Promise<AsyncGenerator>`）。原写法：

```js
for await (const chunk of llm.stream({...})) {
  // 没有 break —— 能跑，for-await 会自动解包 Promise
}
```

0.5.24 为检测宿主错误 chunk，在循环体里加了 **`break`**。**加了 break 之后 V8 不再解包
那个 Promise**，直接把 `Promise` 当迭代器用，于是**每一次真实调用都抛**：

```
llm.stream(...) is not a function or its return value is not async iterable
```

**修法**：先 `const stream = await llm.stream(...)` 显式解包，再 `for await (const chunk of stream)`。
解包之后 break 就没问题了。

### 我走的两个弯路（都记下来）

**① 顺着报错字面意思查了两轮。** 那句 `boolean true is not iterable` 让我以为「宿主返回了
布尔值」，于是一路追查宿主哪个函数会返回 `true`。**实际上根本没人返回过布尔值**——
是我自己的代码把 Promise 用废了。报错字面意思完全指错了方向。

**② 找到抛出点就当成根因。** 我搜到宿主 `client.excel.js` 里有
`typeof iterable + " is not iterable"` 这句，就下结论「是宿主 Excel 预览的错，跟视觉
链路无关」。**找到抛出点不等于找到调用点**——那句拼出来的报错文本只是长得像，实际
来源是另一回事。我在没有任何证据的情况下否定了自己的嫌疑。

**代价**：用户在 0.5.25 / 0.5.26 两次真实压测里看到的视觉失败，一直是这一个 bug，
而我却在同期又加了别的改动，让「越改越不行」的感觉雪上加霜。

### 新增测试

- `回归：宿主 stream 是「async 函数返回 generator」，循环体带 break 也不能废`
  ——直接用宿主真实形态（async 函数返回 generator）做桩，同时验证
  「正常文本能读到」与「失败 chunk 能被识别并抛出」两条路径。
- **门的有效性已实测**：去掉显式 `await` 退回旧写法后，该测试立刻失败并报出
  `llm.stream(...) is not a function or its return value is not async iterable`，
  与真机报错一字不差。

验证：`npm test` **157/157**（156 + 1）、`npm run verify:contract` **24/24**。

## 0.5.26（2026-10-03）

**撤掉我此前加进 skill 的处方式死规则。只陈述工具事实，不给「遇 X 做 Y」的处方。**

### 用户定的原则

> **不要写死规则，Agent 有自己的判断力。**

这条批评直接命中我这几天做错的事：我一直在往 skill 里堆「你撞到 X 就该做 Y」，
看似在帮它，实则**在剥夺它的判断空间**。

### 删掉了什么

| 删掉的死规则 | 为什么有害（真实事故，不是理论） |
|---|---|
| 「浏览器路径是无头的，需要登录/扫码/**人机识别**/验证码/双重验证/风控的网站**必然失败**，遇到这类拦截**立刻换桌面端**，不要继续重试」 | 真实事故：用户看到的现象是「报错失败」，而**人机识别是在他自己手动登录、提示词发出去的那一刻才弹出来的**——Agent 全程没看见，**它的视角里根本没有「人机识别」这个东西**。我把这些词写进 skill，它就去现实里找，找不到 → 困惑 → 更乱 |
| 「先桌面后网页：① x_desktop_apps 查窗口 ② x_desktop_launch 去开始菜单找 ③ 找到且已登录就用桌面端 ④ 只有用户明说用网页、或桌面端根本没有才走浏览器」 | 把「桌面优先」当铁律，但它经常是错的（用户明说用网页、或桌面没装）。更糟的是**逼着 Agent 在没找全时就下结论**——两次实测它开场都说「桌面没有豆包」，都是靠用户喊一声才回头重找 |

### 改成了什么

只保留**工具事实**，判断交给 Agent：

```
## 桌面与浏览器：两条路的事实（不给处方）

- x_desktop_apps 只列「当前有窗口的应用」。应用装了但没启动时，窗口列表里就没有它
  ——查不到不代表没装。要启动用 x_desktop_launch（应用名或路径）。
- 浏览器路径是无头的，页面是否可用取决于该站对无头环境的态度（登录态、验证、风控等）。
  具体会遇到什么，只有真的走到那一步才知道。

通用原则：工具报错或结果异常时，先如实描述你实际观察到的现象（错误原文、界面现状），
再决定或询问用户。不要根据预设模式猜测原因——你的视角可能看不到真实原因
（用户可能在某个时点完成了一个你没看见的操作，随后才触发你看到的现象）。
看不懂就如实说看不懂，别硬试、别静默换路。
```

关键那句是「**你的视角可能看不到真实原因**」——这才是本次事故的通用教训，
比任何针对具体应用的规则都管用。

### 顺手清掉的过度引导

- skill 正文里所有**具体应用名/网站名**（豆包、doubao.com、肯德基、Gucci 等）——
  写进去就成了给单个测试 case 的菜谱，换个应用就不适用。**现在 content 里 0 处**。
- 上一条提交里给死规则写的两条「防回退」测试，也一并重写成反向门。

### 新增的门（防止我又滑回去）

`degraded-fallback.test.mjs` 里一条测试断言：

1. **skill 正文不得出现任何具体应用/网站名**（`豆包|doubao|肯德基|麦辣|Gucci`）；
2. **不得出现处方式措辞**（`遇到<拦截类型>…立刻/必须…换/切/改`）；
3. 但**必须保留**「如实描述你实际观察到的现象」与「不要根据预设模式猜测原因」——
   这两条是诚实要求，不是操作处方。

**门的有效性已实测**：把两类违规注入回 skill 后 `pass 18 / fail 1`，明确点名「豆包」；
移除后全绿。

### 保留的「处方类」文案（这些不是死规则，理由充分）

- 危险目标（删除/支付/注销）要审批 —— 这是**安全底线**，不是操作技巧
- 密码框拒绝自动写入 —— 隐私边界
- 物理输入会抢真实光标、能走语义就别用物理 —— 这是**工具的客观性质**，不是预设模式
- 「你的视角可能看不到真实原因」—— 本次事故的通用教训

验证：`npm test` **156/156**、`npm run verify:contract` **24/24**。

### 尚未定位（如实记录）

会话 `PVuU8r6yf8ih`（12:21）里 `x_vision_describe` 报 `boolean true is not iterable`，
**根因仍未定位**：Node 24 的报错文本与这句逐字对不上（`for await` 遍历非可迭代值报的是
`... is not a function or its return value is not async iterable`），且会话记录里只存了
Agent 的转述、没存真实 error 对象。需要拿到宿主返回的**原始 message** 才能分清是插件侧
还是宿主侧。**本条提交不含这个修复。**

## 0.5.25（2026-10-03）

**修复 `x_vision_describe` 的 `attachment` 参数声明——模型传引用会被校验拒绝。**

### 起因：一次纯文本模型压测（会话 `DzjC8UU32GL7`）

用户继续用只吃文本的模型（`aiio/MiniMax-M3`）压测。**这一轮任务完成了**：Agent 走
degraded 路径 → 坐标点击 + 物理键盘 → 在豆包桌面端生成 3 张 Gucci 香水产品图 → 下载到
`C:\Users\sun_w\Downloads` → 关闭窗口。视觉模型这次**真的返回了描述**（Agent 据此拿到
输入框与发送按钮的坐标并成功点击）。

但过程里 Agent 反复撞一条参数错误，它自己下了判断：

> seq 256「schema 报错，不传 attachment 也报错。**这是工具的 bug**。我换个调用方式」
> seq 311「我之前通过不传 attachment 让它自己拍 tab_id 拍过一次，那次没报错。
> 这回传 attachment 对象里某些字段不让传」

**它判对了。**

### 根因：裸 `{type:'object'}` 没声明 properties

```js
attachment: { type: 'object', required: true, description: '…' }
```

严格模式的函数调用校验下，「没声明 `properties`」等于「**没有字段被定义**」，于是模型
按 schema 生成的调用里传进来的引用被拒。而 schema 是模型**唯一**的参数依据——没写清楚，
模型就不可能传对。

**为什么此前没有任何测试抓到**：宿主契约门（`scripts/host-contract-verify.mjs` 的
`hostGate`）只校验 `output.schema`，**`parameters` 从来没被校验过**。而
`verify:contract` 24/24 全绿——它验证的是"输出能过宿主校验器"，与"输入能不能被模型
正确生成"是两件事。

### 顺带修的第二个缺陷：描述漏了桌面截图

原 description 只写「`x_browser_shot` 返回的 image 引用」，**根本没提 `x_desktop_shot`**。
而这次压测、以及整个 degraded 兜底路径，**桌面截图才是唯一的图片来源**。这条描述在把
模型往错方向带——它得先猜"哦桌面截图也能传"，或者干脆绕道 `tab_id`。

现在 description 与 `tab_id` 都写明：`tab_id` 只对**浏览器标签页**有效，桌面窗口必须用
`attachment`。

### 修法

- `attachment` 显式列出宿��� `ImageAttachmentRef` 的五个字段（`attachmentId` / `mediaType` /
  `bytes` / `width` / `height`，`name` 可选），并写明「**原样整个传进来，一个字段都别删**」。
- description 补上 `x_desktop_shot`，并强调这是 degraded 场景下唯一的图片来源。

### 新增两道门（这次缺的是"输入侧"的校验）

- **参数 schema 不得出现裸 `{type:'object'}`**：遍历全部工具的参数树，出现"某节点
  `type:'object'` 但既无 `properties` 也无 `additionalProperties`"即失败。
- **`x_vision_describe` 必须同时提到两个截图来源**，且 `attachment` 必须声明那五个字段、
  description 必须含"原样/整个传"。

**两道门的有效性已实测**：把 `attachment` 的 `properties` 删掉退回裸声明后，
`pass 6 / fail 2` 当场抓出；恢复后全绿。

验证：`npm test` **156/156**（154 + 2）、`npm run verify:contract` **24/24**。

### 本轮观察，如实记录

- **豆包窗口第二次观察时不再 `degraded`**：Agent 报「75 个元素，99 个有名字」并看到了
  `#239「图像生成」按钮（有 Invoke）`——与首轮的 14 个空壳形成对比。**原因未查证**
  （可能是 Electron 渲染器在窗口获得焦点后物化了，也可能是同一进程内的状态变化）。
  这提示 `degraded` 判定是**按次观察**的，同一个窗口不同次观察结果可能不同。
- Agent 用「不传 attachment、让工具自己拍 `tab_id`」绕过了参数问题（seq 392），
  说明**绕过路径是存在的**——所以这次任务能完成，尽管主路径有缺陷。

## 0.5.24（2026-10-03）

**修复 `x_vision_describe` 把「请求失败」误报成「模型返回空」。**

### 起因：一次有意的压测暴露了它

用户**故意**用只吃文本的模型（`aiio/MiniMax-M3`，未配置视觉）来测「Agent 会不会去调
视觉模型辅助」。实测 Agent 调了 `x_vision_describe`（会话 `8otitHr2hTPM` seq 133），
但**三个候选全部表现为「返回空」**，于是它说「所有视觉模型都不可用…我自己又看不到
这张图」，任务卡死。

### 根因（对照宿主源码确认，非推测）

**宿主不会为适配器失败抛异常。** `dsh-llm/lib/index.js`：

```js
} catch (error) {
  yield adapterFailureChunk(error, options.signal);
  return;
}
```

`adapterFailureChunk`（同文件 `:2376`）把失败包成一个**终止 chunk**：

```js
{ type: 'finish', reason: { kind: 'error', failure: { message, code, status? } } }
```

而 `describeImage` 的 `collectText` 只认 `chunk.type === 'text-delta'`，**完全无视
finish chunk**。于是一次硬失败（鉴权 / 模型路由 / 请求被拒）被报成「模型返回 0 个字」：

- 真实错误整个丢掉，调用方无从得知**请求压根没发出去**；
- `classifyVisionError` 看不到它（没有任何东西抛出来），`attempts` 里记成
  `reason=empty` 而不是 `call-failed` ——把「请求失败」说成「这个模型看不了图」；
- 三个候选同时这样报，看起来就像「没有模型能看图」，**排查方向被完全带偏**。

这也解释了 0.5.20 那次为什么始终定位不了：**当时「返回空」这个症状本身就是错的。**

### 修法

- `describeImage` 识别 `finish` 且 `reason.kind` 为 `error` / `aborted` 的 chunk，
  **抛出去**而不是退化成空文本。错误 message 带宿主原文，HTTP status 一并带出，
  `failure.code` 保留到异常的 `code` 上供 `classifyVisionError` 分类。
- `reason.kind='stop'` 是正常结束，绝不能当成失败（否则正常调用会被误报）。
- 有部分文本又带 error finish 时也按失败处理——`finish.kind=error` 意味着这次调用失败了。

新增 4 条回归测试，全部针对宿主的真实行为：失败 chunk 必须抛异常且保留 code 与 status；
`attempts` 必须记为 `call-failed` 而非 `empty`；正常 `finish(stop)` 不得被当成失败；
`aborted` 要被 `classifyVisionError` 认成 `aborted`。

### 顺带补上发布卫生门的盲区

`tests/release-hygiene.test.mjs` 原有 5 条查的都是**文件之间是否自洽**（两个 json 一致、
CHANGELOG 对得上）。但真正咬过人的第三种形态是：**代码改了、CHANGELOG 也写了、唯独
版本号没动**——此时文件之间**依然自洽**，所以全绿；而自更新 `REF='main'` 读到的还是旧
版本号，`compareVersions` 返回 0，面板显示「已是最新」，新代码永远送不到用户手上。

**本项目已被这个形态咬过三次**：0.5.5 插件市场静默卡住、0.5.20、以及本次的
`b2c6477` / `7268e77`（我又漏了）。

新增第 6 条：用 git 历史判定「最后一次改动 `lib/` 的提交，必须被最后一次改动版本号的提交
包含进去」。实测有效——加上这条门后它当场报 `pass 5 / fail 1`，把当前这个漏抓了出来。

### 尚未定位（如实记录）

修完之后才知道三个候选**真正**的失败原因是什么——那才是「视觉到底能不能用」的答案。
目前只知道：不是「模型返回空」，而是宿主报了某种终止失败。下一轮实测让 Agent 把
`attempts` 原文贴出来即可定位。

**另一处宿主行为差异，本轮发现但未改**：宿主自己的 `read_image` 在读图**之前**先调
`assertImageCapableRoute`（`dsh-tool-fs/lib/index.js:1006`），先确认「接收这张图的模型
真的吃图」，不行就直接拒。`x_vision_describe` 没有这个前置检查，目前靠失败反馈兜底。
等拿到真实失败码之后再决定要不要补——现在补属于猜。

验证：`npm test` **153/153**（149 + 4）、`npm run verify:contract` **24/24**。

## 0.5.22（2026-10-03）

### ⚠️ 撤回一条 0.5.20 的错误结论

0.5.20 的条目写着「本机 `opencode-go/space-bunny-free` 对图片返回空」，并据此把
「视觉静默失效」归因到该模型。**这条是错的，撤回。**

2026-10-03 用户更新并重启后，同一台机器、**同一个模型**（`opencode-go/space-bunny-free`）
在一个**零工具调用**的会话里正确识别出一张金毛寻回犬照片并描述了画面内容
（会话记录 `Ie_D53GPoJG7`）。**即该模型原生就能看图，不需要本插件任何工具。**

所以「视觉静默失效」的真实原因**至今未确定**。当时可解释的候选（0.5.19 截断引用的连带损伤、
偶发路由问题）**都没有证据，不作结论**。连带后果：`describeImageWithFallback` 的自动回退
**至今未在真机验证过**——用户那次成功的识别走的是宿主原生通路，根本没调
`x_vision_describe`。

保留 0.5.20 那批代码的理由：它在逻辑上仍然正确（宿主声称支持 image 的模型里可能有实际
不能用的；失败原因需要可分辨），且不依赖上述那条已被撤回的结论。

### 修复真机事故：`x_desktop_shot` 往 image block 里只塞了两个字段，导致截图此后一直读不回来

### 是什么

`lib/desktop/tools.js` 的 render 里，图片块被写成：

```js
blocks.push({ type: 'image', attachment: { attachmentId: v.image.attachmentId, mediaType: v.image.mediaType } });
```

而宿主 `ImageAttachmentRef` 的**五个字段全是必填**（`attachmentId` / `mediaType` / `bytes` /
`width` / `height`，见 `dsh-agent-preset-registry` 的类型声明）。读回图片时宿主逐项比对实际字节：

```js
// dsh-attachment-local/lib/index.js:609
metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
  || metadata.width !== ref.width || metadata.height !== ref.height
```

缺字段就是 `undefined !== 738203`，于是抛
`Stored attachment metadata does not match its reference.`（用户用 sharp 对着磁盘上的对象
逐项比对验证过：残缺引用必然触发这条错误，补全引用即通过）。

浏览器截图一直没这个毛病——`lib/browser/tools.js` 的 `renderTab` 传的是完整的
`value.image`。**所以这个缺陷能长期藏在只有桌面截图才会踩的分支里。**

### 为什么后果比"这次调用失败"严重

那个 image block 会**留在会话上下文里**。此后每次重新组装请求（切模型、上下文压缩、续话）
宿主都要重读这张图，于是一直崩——表现为「Agent 还没调用任何工具就失败」。
豆包那次任务里 `x_desktop_shot` 被调了 5 次，之后两次切模型时就撞上了。

### 我犯的两个错，都记下来

**① 同一个错犯了两次。** 我先按「字节损坏」方向查（SHA256 其实与存放路径完全一致，
是我第一次 PowerShell 比对写错了、node 复算才确认），又按「宿主把图片缩放后写错 ref」
方向查（`verifyNormalizedImage` 有兜底，且写入的 `detectImage` 与读回的 `probeImage`
调同一个 `imageMetadata`，必然一致）。**根因就在我自己的代码里，我绕着它查了两轮。**

**② 我用"失败时没有工具被调用"这个证据下了错结论。** 那条证据本身是对的（失败确实发生在
请求组装阶段），但我从中推出「所以不是我们插件的问题」——**我证了"何时失败"，没证"坏引用
从哪来"**。这两件事之间隔着一个我没去查的环节。代价是让用户多做一次复现。

### 修法

- `attachment: { ...v.image }` —— **原样透传整个 image**，一个字段都不动。
- 新增 `tests/image-ref-integrity.test.mjs`（3 条），做成**扫全部工具**而不是钉行号：
  - 源码扫描：任何 `type: 'image'` 的 `attachment` 若显式列字段，必须覆盖全部五项；
  - 运行时：真跑 `x_desktop_shot` 的 `render`，逐字段检查实际产出的 block，
    并断言 JSON 文本块里同样完整（模型要据此回传给 `x_vision_describe`）。
  写死行号的测试下一个人改个行号就失效，而**任何**工具只要开始输出图片都可能重犯——
  那正是这个缺陷的形状。
- **门的有效性已实测**：把事故那行注入回去，源码扫描与运行时两条都失败，且明确点名
  `漏了 bytes/width/height`。恢复后全绿。

### 顺带更正 0.5.21 的错误结论

0.5.21 的条目把这个报错写成「宿主问题、插件只是路过」，并推测了「客户端缩放」「EXIF 方向」
等方向。**那些推测全部作废**：坏引用是本插件自己造的，与缩放、方向、宿主读图路径都无关。

另：0.5.21 里那批「附件错误分类」代码（`classifyVisionError` / `attachment-invalid` /
提前中止）本身没错、也没走错分支，但**对这个事故完全没用**——事故发生在宿主重读我们
早先留在上下文里的坏引用上，`x_vision_describe` 压根没被调用。它只是防御性代码。

验证：`npm test` **147/147**（144 + 3）、`npm run verify:contract` **24/24**。

## 0.5.21（2026-10-03）

**发布流程本身的静默失败：写完 CHANGELOG 却忘了改版本号。**（用户发现的）

0.5.20b 那次提交只改了代码与 CHANGELOG，`package.json` 与 `dsh-plugin.json` 都还写着
`0.5.20`。而自更新的 `REF = 'main'`，直接读 main 上的 `package.json`，
`compareVersions('0.5.20', '0.5.20')` 返回 0 → 面板显示**「已是最新」** →
**附件那个修复永远送不到用户手上，且没有任何报错**。这与 0.5.5 插件市场静默卡住同一类，
是本项目第二次栽在「发布状态不自洽」上。

我用的 `0.5.20b` 这个写法还更糟：`compareVersions` 按 `-` 切分预发布后缀，
`"0.5.20b"` 的 `core` 是 `"0.5.20b"`，`parseInt("20b")` 得 **20**，
**字母后缀在这套版本比较里等于隐形**，照样和 0.5.20 相等。

**修法**：正常递增到 0.5.21（不使用字母后缀），并加 `tests/release-hygiene.test.mjs`
把这类疏漏变成测试失败：

- `package.json` 与 `dsh-plugin.json` 版本必须一致；
- CHANGELOG 最新一节标题必须等于 `package.json` 的版本；
- 所有版本号必须是**纯数字点分**（`/^\d+(\.\d+)*$/`）——字母后缀一律拒绝，
  因为它会在 `compareVersions` 里塌成同一个数字；
- CHANGELOG 的版本序列必须**唯一且严格递减**（新版本在最前）。

### 起因：0.5.20 真机复验撞上「Stored attachment metadata does not match its reference.」

0.5.20 真机复验（用户把图片发进对话问「能识别到这张图么」，连试三次并在三种模型间切换）
失败于宿主附件层。取证结论：

- **不是 0.5.20 造成的**：`git show --stat HEAD` 证明该提交只碰 `lib/vision.js`、
  `lib/vision/tools.js`、测试与文档，**没有任何附件代码**。
- **不是字节损坏**：附件库 `objects/5b/5b9e…`（738203 字节、PNG、540×867）的 SHA256 与
  它的内容寻址路径完全一致（`Get-FileHash` 与 node `crypto` 双向复算）。
  抛出点 `readImageFile` 的**上一行**才是 digest 校验，digest 已过才会走到元数据比对。
- 因此失败在 `dsh-attachment-local/lib/index.js:609`：
  `metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes ||
  metadata.width !== ref.width || metadata.height !== ref.height`。
  即**图片本身完好，但 ref 里记录的元数据与实际字节对不上**。
- 观察到的相关性（**未证实**，仅记录）：两张失败图片的尺寸 540×867 / 542×877 **不是 10
  的倍数**，而附件库里此前所有成功图片（1600×230、620×110、2560×150、1296×1007…）
  **全是 10 的倍数**；失败的两张也缺少成功图片都有的 `sRGB`/`gAMA`/`pHYs` 块。
  像是客户端缩放后才上传的图。**这只是相关性，不当作根因。**

**证据缺口（如实）**：没能拿到那份 ref——它只存在于会话消息里，投影缓存与附件库都不存
ref 明细，全盘搜 `5b9e7db1`/`6118eed0` 无命中。所以**究竟是哪一项（mediaType / bytes /
width / height）对不上，目前无法断言**。

### 顺带修掉 0.5.20 自己引入的一个缺陷

新的回退逻辑原先对所有异常一律重试下一个候选。但附件级错误**与选哪个模型完全无关**——
换模型、重试全部候选都只会再抛一次同样的错。那次真机复验会白花三次调用，还会让用户
误以为「多换几个模型说不定能行」。

- 新增 `classifyVisionError()`：把错误分成 `attachment` / `aborted` / `model`。
- `describeImageWithFallback` 遇 `attachment` / `aborted` **立刻停**，不再试后续候选。
  `model` 类（限流、鉴权等）仍然继续试——那些换模型也许真能成。
- 报告新增 `attachmentClaim`：把插件这边持有的
  `attachmentId / mediaType / bytes / width / height` **原样摊开**。
  宿主那句错误只说「对不上」，不说**哪一项**对不上；没有 claim 就无法定位。
- `attempts[].reason` 新增 `attachment-invalid`，其说明明确写了
  「**图片本身坏了，与选哪个模型无关**」——防止用户被引去换模型。

验证：`npm test` **139/139**（新增 3 条：错误分类、附件坏只试一次且摊开 claim、
模型类错误仍继续回退）、`npm run verify:contract` **24/24**。

## 0.5.20（2026-10-03）

### 修复 `x_vision_describe` 在真实环境静默失效

### 怎么发现的

用户让 DSH 用桌面工具驱动豆包桌面端发消息、收回图、关窗口——任务完成了，但报告里写
「由于视觉模型返回空，无法肉眼看懂豆包」，于是改用手工验证（读豆包 Chromium 缓存目录的
baseline 时间戳 + PNG 魔数 + IHDR 宽段）。**那次运行同时成了 0.5.19 兜底路径的首次生产验证**：
豆包是 Electron 内核、14 个元素 → `degraded=true` 命中，Agent 走坐标点击 + 物理键盘完成，
关闭时仍优先用树里能找到的 `#8 Button "关闭"`（`revalidated=true`）。

### 两个真缺陷

**① 「系统推荐」是假的。** `pickModel` 在设置为空时返回 `models[0]`——**列表第一个**，
不是任何意义上的推荐。而它上方的注释写着「宁可多花 token 也优先选便宜快的模型；
本次偏好日韩/二次元」，**那段选型逻辑在代码里根本不存在**。注释在撒谎，而后果不是
"选得不够优"，是"选中的那个可能根本不能看图，然后整条功能静默死掉"。

**② 只试一个模型，且失败不可分辨。** 宿主声称支持 `image` 的模型里可能有实际不能用的。
更要命的是宿主对
「只吃文本的模型」会**静默**把图片块替换成一段文字（`dsh-llm/lib/types/content.js`
的 `textOnlyImageText`）：

```
[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]
```

插件侧原本无从区分「模型没话说」和「图片压根没送到」，用户看到的只是一句
「没有返回任何文字」。旧实现试一个就返回，**一个坏条目就永久废掉整条功能**。

### 改法

- `candidateModels()`：按设置排出**候选序列**（系统推荐 = 宿主原顺序，不重排——插件没有
  依据去排序；random = 打乱；指定 = 只有它）。
- `describeImageWithFallback()`：依次尝试，第一个真能看图的胜出，**成功即停**（不多花调用）。
- **能分辨两种失败**并分别报出：`image-not-delivered`（宿主把图片换了文字，即该模型实际
  不吃图）/ `empty` / `call-failed`（宿主错误原文带出，不吞）。
- 输出新增 `attempts` 字段，逐个候选列出谁成功、谁被跳过及原因。
- 删掉那句撒谎的注释，并**加了一条测试守着它**：注释里出现「优先/偏好/最便宜」而代码里
  没有 `sort`/`score`/`shuffle`/`cost` 痕迹时测试失败（标明是历史记录的注释行豁免）。

### 一个被测试当场抓出来的实现 bug

占位符检查一开始放在 `if (r.text !== '') return` **之后**，永远走不到——而宿主替换图片后
模型会把那段占位符当正文回出来，那是**非空**的，会被当成「看图成功」。单测
「宿主把图片替换成文字要单独报」当场把这个抓了出来，已改成先判占位符再判成功。

### 附带澄清一处**不是**缺陷

排查中一度怀疑 `x_vision_describe` 的 `model` 参数（它在 outputSchema 里 `required: true`）
被声明却不生效。核对源码后确认那是**输出** schema 不是入参，execute 里也从未读取
`args.model`，不存在"声明必填却被忽略"的问题。不算缺陷，记录在此以免下一个人重复怀疑。

### 验证

- `npm test` **136/136**（新增 6 条：注释防撒谎、候选顺序、回退成功、回退分辨占位符、
  回退容错、全失败不谎报）
- `npm run verify:contract` **24/24**（`x_vision_describe` 的 output schema 新增
  `attempts` 数组，宿主真校验器通过）

**证据缺口（如实）**：改完**尚未在真机复验**——需要用户重启 DSH 后跑一次看图任务，
`attempts` 字段会直接告出哪个模型真能看图、哪个被跳过。这既是验收也是诊断：
若三个候选全被跳过，说明不是选型问题而是图片链路整体不通，届时按 `attempts` 的
`reason` 字段继续定位。

## 0.5.19（2026-10-03）

**下线「改宿主启动快捷方式加无障碍旗标」，代之以树/截图双路径。**

起因是一条 0.5.13 加进来的功能现在站不住了。三条理由都是**实测**，不是推理：

1. **旗标已无效**。`probe-flag-playwright.mjs` 在 playwright chromium-1246 上对比加与不加
   `--force-renderer-accessibility`：**同一份树**，102 vs 103 元素，纯噪声。交叉印证：本机
   Edge 152（Chromium 138+）默认就吐出 499 元素，现代 Chromium 早已默认开原生 UIA。
2. **替代方案是闩锁，关不掉**。`SPI_SETSCREENREADER` 是本以为的"正规开关"，
   `probe-spi-timing.mjs` 实测：开启后 13 → 187 元素，**关掉后仍 159**（而"从未开启"时只有 13）。
   树一旦物化就常驻至进程退出——**用一次就永久生效**，与"按需开关"的语义正好相反，而且有副作用。
3. **覆盖不全且留残留**。只改 `.lnk` 覆盖不到"开始菜单搜索 / 宿主自重启"等入口，安装器若新建
   快捷方式就会出现两个。

更重要的是**越界**：用户定的原则是「插件不应凌驾于宿主之上」。宿主能给的能力应当通过宿主
获得，改宿主的启动方式不属于插件的职责。原先那条"唯一写宿主配置的功能"本身就是例外，例外
一旦存在就会被当成先例。

### 删除（整条功能下线，不是隐藏开关）

| 删了什么 | 在哪 |
|---|---|
| 控制器实现 | `lib/core/host-accessibility.js` |
| 改 `.lnk` 的脚本 | `lib/host-shortcuts.ps1` |
| 它的测试 | `tests/host-accessibility.test.mjs` |
| 两条 HTTP 路由 | `lib/browser/watch.js` 的 `GET/POST /host-accessibility` |
| `WatchServer` 的第 6 个构造参数 | `lib/browser/watch.js` |
| 构造调用 | `lib/index.js` 的 `createHostAccessibilityController` |
| 设置页开关 | `lib/client.js` → 换成只读说明卡 `ElectronNotePanel` |

留了两道**防复活**的门：`watch-guard.test.mjs` 里一条测试断言这四个端点真的返回 404
（不留任何可写入口）；`degraded-fallback.test.mjs` 里一条测试扫描全 `lib/` 的代码，
确保不再出现 `host-accessibility` / `SPI_SETSCREENREADER` / `.Save()` / `Arguments =`
这类写启动配置的能力（注释里可以提这些名字解释为什么不做，代码里不行）。

### 新增：树能用就用树，不能用就截图 + 坐标

这就是 ZCode 的 `strategy:auto`（优先 a11y，回落 event/坐标）。它对应的前提也澄清过：
**ZCode 本身不是"截图路线"**——它的 `include_screenshot` 默认 `false`，无障碍树是主干、
截图仅兜底。本插件现在与之一致。

**① `x_desktop_tree` 输出 `degraded`（对应 ZCode 的 `subrole` 语义）**

ZCode 用 `subrole` 区分"可绑定的窗口"与"树没暴露的残留界面"。本插件用 `degraded` 做同一件事——
让模型**机器可读地**知道这棵树不能当主干，而不是靠人去猜。

```
elementCount=13  namedCount=4   degraded=true
degradedReason: 该窗口只暴露出 13 个元素（其中 4 个有名字），疑似 Electron/Chromium 内核
未对外物化无障碍树。**语义动作（x_desktop_press / value / scroll）在此窗口基本不可用**。
改用 x_desktop_shot 看图 + x_desktop_click_at 坐标点击（兜底路径，精度低于语义动作），
或用 x_desktop_key / x_desktop_type 发按键。重试观察无用——这不是时序问题。
```

阈值 `DEGRADED_NAMED_MAX=8` / `DEGRADED_TOTAL_MIN=20`（`lib/desktop/manager.js`）用真机
5 个数据点校准，任一命中即 degraded：

| 窗口 | 元素 / 有名字 | degraded | 依据 |
|---|---|---|---|
| DSH 本体（Electron，首次观察） | 13 / 4 | true | 本轮会话最开头、任何实验之前的干净状态 |
| DSH 本体（树已被物化后） | 163 / 142 | false | SPI 实验的闩锁效应仍在同一进程内 |
| OpenCode（Electron） | 47~48 / 32~33 | false | |
| Edge 152（Chromium） | 499 / 461 | false | |
| playwright chromium-1246 极简页 | 39 / 18 | false | `probe-threshold.mjs`，四种组合加旗标全部 +0 元素 |

阈值两侧都有足够宽的间隔（4↔33、13↔48）。**改动阈值必须同步改
`tests/degraded-fallback.test.mjs` 的期望**——那条测试就是防止阈值漂移的。

**② `x_desktop_shot`（窗口级截图）—— 默认关，需用户在设置页显式打开**

**为什么单独一个开关、且默认关**（与用户 2026-10-03 定案）：这是本轮唯一一个**没有**
"树有而截图没有"之外理由的隐私边界，核心是这么一条不对称——

> `x_desktop_value` 对密码框是 **helper 内 fail-closed 硬拒绝**的。但截图是像素，
> **这层保护完全不存在**：自绘控件的密码框在树里可能压根没标成密码框，
> 截图就把明文拍下来，还送进了模型上下文。

树只给控件结构与名字，截图给的是屏幕上的一切。参照 `x_browser_shot`（浏览器整页截图
同样没有独立开关）可以说"保持一致"，但那条路径的输入是 Agent 自己打开的网页；
桌面窗口可能是你的密码管理器、聊天窗口、银行客户端。所以**不跟 `desktopEnabled` 一起默认开**。

三处配套设计（少任何一处都会退化成「文档说能用实际必失败」）：

- **工具仍然注册**。不注册的话模型连这条路径存在都不知道，也就无法向用户解释
  「为什么这个应用看不了」——那才是真正的坏。
- **拒绝信息里三样齐全**：是谁关的（用户）、为什么关（密码框保护不对称）、以及
  **不要绕过、不要改用别的方式偷偷取画面**。
- **`degradedReason` 随开关变**。开关关着时它**不再推荐 `x_desktop_shot`**，改为说明
  「截图被用户关闭」+ 给出仍然能走的路（`x_desktop_key` / `x_desktop_type`）+ 复述
  为什么默认关。否则模型会在每个 degraded 窗口上先撞一次 `ACTION_UNAVAILABLE` 才发现。

helper 新增 `window_shot` 命令。用 `PrintWindow` + `PW_RENDERFULLCONTENT` 让目标窗口
**自己**把内容画进我们给的 DC，因此**不受遮挡影响**——这比抓屏幕矩形（`CopyFromScreen`）
强得多，后者被压住时拍到的是遮挡物。真机实测 DSH（Electron）在后台被别的窗口压着时
仍取到完整画面：1965x1106、102 种颜色、0% 近黑。

另两处刻意设计：

- **近黑帧判失败**（采样亮度 < 8 的像素占比 > 92%）。Electron 在某些状态下会返回纯黑帧，
  那是"没有画面"不是"一个黑色的应用"——两者混为一谈会让模型得出完全错误的结论。
- **严格绑定 observation**，不能凭 hwnd 截任意窗口（否则就成了通用截图器）。

**③ `x_desktop_click_at`（纯坐标动作）**

helper 新增 `window_rect` 命令。**它不解析任何元素**——这正是它在树空掉时唯一可用的原因，
也是它与 `x_desktop_mouse_click`（坐标来自元素矩形，树空掉就没得用）的分水岭。

- 坐标越界即拒，错误信息里点明"x/y 是窗口内坐标而非屏幕坐标"。
- 过全套物理门控（空闲检测 + 审批 + 向用户明示），与 `x_desktop_mouse_click` 一致。
- `render` 产出 `text` + `image` 两个块（对标 `x_browser_shot`），图片要真交给模型看。

### 文案同步

`lib/skill.js` 里那段"给用户加旗标"的指引整段重写。现在教模型的是：

- `degraded` 时**必须在回复里告诉用户**「这个应用只能看图操作，精度较低」；
- 能走语义动作就必须走语义动作，`x_desktop_click_at` 是最后手段；
- 截图被关时**不许重试、不许变通、不许劝说用户打开**——那是用户的隐私边界，不是待修的缺陷；
- **本插件不修改任何应用或宿主的启动配置**，Electron 应用只能看图操作属预期行为，
  不要试图替用户改启动方式来"解决"它。

`lib/client.js` 设置页「电脑控制」组新增「允许窗口截图」开关（默认关），并在
「应用兼容」说明卡里点明：现代 Chrome/Edge（138+）默认已开原生无障碍树，通常**不需要**开它。

### 验证

- `npm test` **130/130**（115 − 3 条已删功能的测试 + 18 条新增）
- `npm run verify:contract` **24/24**（抽 `app.asar` 内宿主真校验器判全部工具的 output schema）
- 真机端到端（`probe-e2e-degraded.mjs`，真实 DSH 窗口，只观察与取证未点击）：
  `degraded` 判定 ✅、宿主真校验 ✅、真实 JPEG 33904 字节且 base64 长度与 `bytes` 字段一致 ✅、
  `render` 产出 2 个块 ✅、降采样换算（1965→1280，系数 x1.535）✅、OpenCode 对照组
  `degraded=false` ✅
- 截图开关真机（`probe-shot-switch.mjs`）：未配置时 `ACTION_UNAVAILABLE` 且拒绝信息
  三要素齐全 ✅、开关打开后真机出图 + 宿主真校验 ✅

**证据缺口（如实）**：`degradedReason` 在开关关着时的那段文案**只有单测覆盖，没有真机覆盖**
——本轮实验已把本机所有窗口的树物化（SPI 闩锁），现在**造不出一个真 degraded 窗口**。
单测用的是实测数据（DSH 首次观察 13 元素 / 4 有名字）。

### 踩到的坑（写给下一个人）

- **`Add-Type` 会按 ANSI 解码临时 `.cs`**：`uia-helper.ps1` 里那段 C# 必须**纯 ASCII**
  （注释也用英文），中文注释的字节会被当代码，报"无效的表达式项"。中文说明写在 PS 侧注释里。
  `lib/banner-overlay.ps1` 早已刻意纯 ASCII 规避同一类坑。
- **`degradedReason` 不 degraded 时必须给空串，不能 `undefined`**：宿主在 schema 校验之前先做
  无损 JSON 快照，嵌套 `undefined` 整单拒绝（0.5.9 的 `x_status` 事故，同一个坑）。
- **`skill.js` 的 `content` 是模板字符串**：里面写反引号包工具名会把字符串截断
  （`SyntaxError: Unexpected identifier`）。

### 环境还原

本轮 SPI 实验的副作用已核验还原：两个快捷方式 `args=''`（干净）、`SPI_SETSCREENREADER` 已关、
泄漏临时目录清零。**唯一残留无法还原**：当前这个 DSH 进程的树已被物化（闩锁），
重启 DSH 后自然恢复 13/4。

## 0.5.18（2026-10-02）

代码审查修复批次。起因是一次全量审查，参考了五个同类项目
（ZCode `browser-use` 0.5.1 / `computer-use` 0.6.3、`Fisfzy/dsh-ego-browser`、
`988hj7tczd-oss/dsh-computer-use`、`Anionex/dsh-computer-use`）。
99 → 115 个单测，新增 16 条。

### 修复 1（高危）：面板 HTTP 接口完全没有鉴权

**证据**：对运行中的宿主打同一个跨站请求（`Origin: https://evil.example`）：

```
GET /api                     → 403   ← 宿主自己的接口，拒
GET /api/x-control/config    → 200   ← 插件的接口，放行
```

**根因**：`dsh-host-webserver` 的分发是纯 `match(pathname) → route.handler`
（app.asar 内 `lib/index.js:229-245`），**webserver 层没有任何全局栅栏**——它自己的
README 明写"不提供内建 TLS 或应用层鉴权"，且启动时直接拒绝 `--host 0.0.0.0`，理由是
"会把 RCE 暴露到网络上"。宿主自己的 Host/Origin 三重校验 + 浏览器会话认证
（`isTrustedApiRequest` / `browserAuth.isAuthenticated`）只作用在 `dsh-client-connection`
注册的那条 `/api` 路由上。插件用 `webServer.register({kind:'prefix'})` 注册的是
**第二条独立路由**，完全落在那道栅栏之外。

而这条路上挂着有副作用的端点：`POST /update`（下载并安装新版本）、`POST /host-accessibility`
（改宿主启动快捷方式）、`POST /clear-data`（清 Cookie 与本地数据）、`POST /input`（点击打字）、
`POST /login-window`（拉起有头浏览器窗口）、`POST /config`。**审查期间实测触发过其中三项，
均已回滚并核验**（快捷方式的旗标已移除、浏览器已回无头、临时写的配置文件已删）。

**修复**：照抄参照实现 `Fisfzy/dsh-ego-browser`（同代、同宿主、同架构里唯一也注册
webServer 路由的）的做法，补三层冗余栅栏 + 请求体上限：

1. **Host 必须回环** —— 杀 DNS rebinding（webserver 只绑 127.0.0.1，但 rebinding 请求的
   Host 头是攻击者域名，所以这条一票否决）；
2. **POST 的 Origin（若存在）必须等于 Host** —— 杀跨站（按 Fetch 规范浏览器对 GET/HEAD
   之外的请求一定带 Origin，所以跨站 POST 必被拒；缺席 Origin 时不拒，那是 curl / 验收
   脚本这类非浏览器客户端，仍须过第 1、3 条）；
3. **POST 必须是 `application/json`** —— 它不是 CORS 安全列表类型，跨域使用会触发预检，
   而插件不返回任何 CORS 头，预检必然失败，请求**根本发不出去**（封掉 `text/plain` +
   `mode:'no-cors'` 那条绕过路径）；
4. `readBody` 加 64KB 硬上限 —— 此前是无上限拼接，任意本地页面都能把宿主内存吃光。

**刻意不校验宿主会话 cookie**（ego-browser 的 `guardHandler` 做法）：该 cookie 由宿主
`browserAuth` 在 index 请求时才种下，是否已种取决于宿主启动路径，拿它当硬门有可能在某些
部署下直接把面板锁死；上面三条对"远程网页"这个真实威胁模型已经闭合。

新增 `tests/watch-guard.test.mjs`（6 条）：逐条覆盖三个分支，端到端断言恶意请求打不动
任何副作用端点（`m.calls` 必须为空），以及同源合法客户端照常可用。

### 修复 2：两个"文档写着能用、实际必然失败"的功能

- **`x_desktop_type` / `x_desktop_key` 省略可选的 `element`**：此前用 `args.element ?? 0`
  去查元素，而观察树里**不存在编号 0**——`uia-helper.ps1` 的 `Observe-Tree` 第一轮
  `if ($index -gt 0)` 把窗口自身排除在 `elements` 之外（真机实测返回编号 1..11）。
  于是不传 `element` 必然撞 `ELEMENT_UNAVAILABLE: 元素 #0 不在观察快照…请重新观察；不要猜编号`
  ——一条把参数默认值取错、却把模型引向"再观察一遍"的误导性报错。
  参照实现 `988hj7tczd-oss/dsh-computer-use` 的 `guard.js:64` 在 `element` 缺席时**跳过**
  元素级检查，而不是拿 0 去顶。现在改为：新方法 `DesktopManager.windowOf()`（只取快照里的
  窗口），且因为没有元素就**无法核对目标名称**，返回文案如实写明"危险词检查已跳过"。
- **`x_vision_describe` 的 `tab_id` 捷径**：工具描述宣传"或直接给 tab_id 让本工具现拍一张"，
  但调用 `browserManager.shot(id, {})` 漏传 `attachments`，而 `manager.shot()` 拿不到它就
  直接抛「当前环境未挂载 attachments 服务」——捷径必然失败，且报错完全指错了方向。

### 修复 3：「全权操控」开关改了必须重载插件才生效

`lib/desktop/tools.js` 在 `buildDesktopTools` 里 `const trustPhysicalInput = cfg.trustPhysicalInput === true;`
把它快照成常量，而同文件所有其他设置都是实时 getter。用户在设置页打开开关后，工具仍在
请求审批（实测 `PERMISSION_DENIED`，而 `cfg.trustPhysicalInput` 确实已读到 `true`）。
改为在 `guardPhysical` 里现读。同类回归已在 `tests/banner-win.test.mjs` 钉住。

### 修复 4：自更新下载不再拉会移动的分支名

`applyUpdate` 此前用 `downloadTarball({ ref })` 直接拉 `tar.gz/main`——一个会移动的引用，
而 `resolveSha()` 本来就在同一函数里（只拿去写锁文件），于是"检查时看到的版本"与
"随后下载到的字节"之间存在一次真实竞态。现在下载**前**先把 ref 钉成 40 位 commit sha，
下载与写锁文件共用同一个 sha；**取不到 sha 时如实失败，不降级去拉分支名**（降级等于把刚
消除的竞态请回来，而"降级"看起来像成功更糟）。

仍存留的已知局限（如实记录）：下载的 tarball **没有做哈希或签名校验**。首次安装信任
GitHub 与用户的网络；TOFU 类防护只能覆盖后续更新。

### 修复 5：成功换装泄漏临时目录

`extractTarball` 此前**只在 catch 里** `rmSync`，成功路径直接泄漏——每次成功更新都在
`%TEMP%` 留一份完整的解包副本（本机实测累计 68 个目录 / 11.7 MB，且每份都是一份可执行的
插件代码）。现在 `cleanup()` 由调用方在 `finally` 里执行。已实测清空本机那 68 个残留
（删除后归零），并加两条测试（成功路径 + 失败路径都必须归零）。
这个插件在另外两处对同一类泄漏都有专门的回归记录（`banner-win.js` 的临时目录、
`host-contract-verify.mjs` 的 pkgRoot），updater 这处漏了。

### 清理与一致性

- **删除死代码**：`GET/POST /config` 路由与 `fileOverrides` 配置层。它们**永远不可达**——
  cordis 的 `resolveConfig` 会把每个声明字段都填成 volatile Ref，于是 `pick()` 的
  `fileOverrides` 分支走不到（用宿主真 schemastery+cordis 实测：文件里 `headless=false`、
  `ttlMs=1234`，宿主配置是默认值时 `pick()` 仍返回 `true`/`30000`）。而设置页实际走宿主
  `configForms`，从来不碰那个文件。留着等于一个无鉴权、可写任意键的写入口
  （`POST /config` 那条还自己读 body、不受上限约束）。README 里"热保存到 config.json"
  的说法同步改正。
- `x_status` 补上 `browserIdleMs`：`outputSchema` 声明了它，`execute` 却一直没返回
  （与 0.5.9 那次 `bannerIdleExitMs` 漏 getter 同类漂移，方向相反：那次是"返回值有、schema 无"）。
- `x_browser_tabs` 的描述改正：它**不会**启动浏览器（此前写"首次浏览器工具调用才会拉起"）。
- skill 文案同步：物理输入门控写清「全权操控」开关开启后不再逐次审批，并注明 Windows 物理
  输入是**全局**注入（无 macOS 那种 per-pid 通道），会与用户真实光标争用。
- README：`verify:contract` 的工具数 21 → 22。

### 撤回一条审查结论

审查中曾报"updater 删除 `integrity` 的正则永不生效"。**该结论错误，已撤回**：当时构造的
fixture 用了块映射 `integrity:` 作末键，而 pnpm 对 git-hosted tarball 依赖产生的是
`resolution: {gitHosted: true, integrity: X, tarball: Y}` 这一形状，正则要求尾随 `", "`
恰好匹配。用真实形状复测：旧 integrity 确实被删除，`tests/updater.test.mjs` 本就断言了这一点。

## 0.5.17（2026-10-02）

**修复：DeepSeek 官方 API 模型下整会话 HTTP 400——三个无参工具的入参根缺 `type: "object"`。**

### 根因（真机定位，真机证据）

`x_activate` / `x_browser_tabs` / `x_desktop_apps` 三个无参工具把 `parameters` 写成了
**空对象 `{}`**——根节点没有 `type`。DeepSeek 官方 API 对请求里每个 function 的
parameters 根做硬校验，缺 type 报 `got 'type: null'`（HTTP 400）；eagerRegister 下
这三个工具全程在场，**等于 DeepSeek 模型的整个会话废掉**。MiniMax / mimo 等接口
不做这项校验，所以 0.5.16 前从未暴露——又一次"换了观测面才看得见的缺陷"。

### 修复（两层）

- 三处显式补齐 `parameters: { type: 'object', properties: {} }`；
- `defineXTool` 边界兜底：入参根缺 `type`（且无 `oneOf`）时自动注入 `type: 'object'`
  ——这个类别的错误从此到不了宿主（0.3.1"注册边界统一规范化"的同款纪律）。
- 新增审计测试：遍历全部工具断言入参根 `type: 'object'`；`defineXTool` 兜底行为单测。
- 测试 99/99；verify:contract 22/22（宿主真校验器对入参根的要求本就含此项，此前
  契约门只挡"DSL 误用"，没挡"空对象根"——审计测试补上了这个盲区）。

## 0.5.16（2026-10-02）

**紧急修复：0.5.14/0.5.15 的桌面层完全瘫痪（uia-helper.ps1 语法错误），并补上一直缺失的 .ps1 语法门。**

### 事故

0.5.14 改 `uia-helper.ps1` 的 set_value 报错文案时，在 `[XControlException]::new(...)` 的
参数列表里用了「字符串 + 换行 + `+` 字符串」的续接写法——**PS 5.1 方法调用参数列表内
换行等于参数列表结束**，整个脚本解析失败。桌面层的所有工具（apps/launch/tree/press/
value/mouse_click/type/key）全部走这一个 helper，于是桌面层整体瘫痪，只有浏览器层可用。
真机验收当场抓住（agent 直接用 PowerShell 解析脚本定位到 L260），一次都没瞒过。

### 为什么连发两版都没发现

`node --check` 只查 .js；仓库 97 个测试里没有一个解析过 .ps1。PS 文件的语法与编码
（BOM）一直处于无测试裸奔状态——这与 0.3.1「注册失败零感知」是同一族问题：**没有门的地方就会烂**。

### 修复与门

- throw 改单行（并留注释说明该解析坑），官方 Parser 复核 0 错误。
- 新增 `tests/ps-scripts.test.mjs`：lib 下每个 .ps1 必须 (a) 通过官方 Parser 解析 0 错误、
  (b) 编码无歧义（带 UTF-8 BOM，或整个文件纯 ASCII——浮窗脚本是刻意纯 ASCII 的既有设计，
  由 banner 测试单独钉住，两种形态都合法）。
- 测试 97/97。

## 0.5.15（2026-10-02）

**两项已批准的改进落地：TTL 软化（慢思考不再撞墙）+ launch 直接返回真实窗口。**

### 1. TTL 软化：过期快照从"一律拒绝"改为"RuntimeId 重验"

飞书任务实测：30 秒 TTL 对"观察后要思考几分钟"的 agent 是必死墙，10 分钟耗在
反复撞 STALE_STATE 上，最后只能靠子代理紧循环绕过。

新语义：快照过期后动作**不直接拒绝**——动作本来就按 RuntimeId 在**当前**窗口树
重新解析，现在附带身份核对（helper 在动作前比对 角色+名称 与观察时是否一致）：

- 一致 → 照常执行，返回带 `revalidated: true`（agent 据此知道是重验通过）；
- 不一致（RuntimeId 被复用到了别的元素 / 控件变了）→ STALE_STATE，点名两侧身份，
  要求重新观察。

**"No blind replay" 依然成立**：核对失败即拒绝，绝不盲放旧状态；白名单、密码框
保护、危险词审批、空闲检测全部不受影响。过期快照保留 30 分钟宽限供重验，之后清理。
skill 与 ttlMs 配置描述同步更新。

### 2. `x_desktop_launch` 直接返回真实窗口

飞书实测：`Start-Process -PassThru` 返回的 pid（17796）只是启动器，真实窗口在
另一个 pid（22220），agent 得自己再找一轮。现在 launch 在 helper 内单次完成：
启动 → 轮询最多 12 秒定位**新出现的**顶层窗口（启动前 hwnd 快照对比）→
返回 `window {pid,title,hwnd,className,processName}`；没出现新窗口时按进程名
兜底匹配既有窗口（单实例应用已在运行的场景，`matched: "existing"`）；
仍找不到则如实说明并建议 x_desktop_apps 自查。agent 拿到 window 就可以直接
x_desktop_tree 观察，少一个来回。

### 测试

95/95：新增 6 个（过期快照软化路径、宽限清理语义、白名单/密码框/未知编号等
既有纪律在软 TTL 下不变）。

## 0.5.14（2026-10-02）

**修掉「中文物理输入变字母」的截断 bug；树截断不再伪装成「控件不存在」。**
两处都来自同日飞书实战任务（44 分钟报告）暴露的真缺陷。

### bug 1：`x_desktop_type` 打「轩辕」出来的是 "i"（根因用算术坐实）

`keybd_event` 的 `bScan` 参数是 **8 位**，而 KEYEVENTF_UNICODE 的码点要 16 位——
经它注入的每个字符都被截断到低字节：「轩」U+8F69 → 低字节 0x69 = **"i"**，
与飞书任务实测逐字吻合；「辕」U+8F95 → 0x95 是控制字符，直接消失。
「支持中文」的注释从写下那天起就没被真实验证过。

修法：改用 `SendInput` + 完整 INPUT 联合体（KEYBDINPUT 的 wScan 是 16 位）。
联合体必须收录 MOUSEINPUT——x64 上 INPUT 真实大小 40 字节，cbSize 对不上
SendInput 会整批拒绝，宁整批失败也不静默注入半个字。结构封送已单测（sizeof=40），
真实按键留待用户验收（往记事本打中文）。

### bug 2：树截断伪装成「控件不存在」

`x_desktop_tree` 在 max_elements 处静默截断：飞书完整树 380 元素，max=300 时
搜索框/关闭按钮/输入框全部"消失"，agent 误判「应用没有这些控件」。
修法：helper 现在上报 `truncated=true`（栈里还有未展开子树即截断），工具输出
schema 带该字段，描述写明纪律；默认 max_elements 200 → **400**。
skill 补两条实战教训：截断怀疑、Qt+WebView 应用（飞书类）的 WebView 树要窗口
取得焦点后才物化——那种场景重试观察有意义，与 Electron 的永不物化不同。

### 顺带

`x_desktop_value` 遇 contenteditable（只有 Text 通告）时的报错改为指明仅有的
两条写入通道（物理 Unicode 输入 / 剪贴板粘贴），不再是死路一条的报错。

## 0.5.13（2026-10-02）

**新增设置页「桌面观察」开关：把无障碍旗标变成用户显式点击的功能，不再只是 agent 的口头建议。**

### 背景（2026-10-02 与用户的两轮定案）

桌面观察对 Electron 应用（含 DSH 本体）只能看到十几个无名空壳，根因是渲染器无障碍树
未物化，药方是启动命令加 `--force-renderer-accessibility`。此前这件事只能由 agent 在
用户授权下手改快捷方式——属于"机器级一次性操作"，不可复制给开源用户。用户提出：
做成设置页开关，默认关闭，agent 反馈问题时用户自己来点，点击后提示重启生效。

### 行为与信任边界（这是插件唯一会写宿主启动配置的功能）

- **默认关闭**；设置页「X-Agent操控 → 桌面观察」显示快捷方式的**真实状态**（检测只读）。
- 打开 = 把旗标写入指向 DSH 的启动快捷方式（开始菜单/桌面/任务栏固定，逐个报告成败），
  提示"重启 DSH 后生效"；关闭 = 移除旗标，同样重启后恢复。**既有参数一字不动。**
- 永不修改 DSH 程序本体，永不碰其他应用的快捷方式；不用快捷方式启动的用户会看到
  如实的"未找到，请手动加参数"。
- skill 同步更新：DSH 本体引导用户用开关；其他 Electron 软件讲清做法由用户自己改；
  **任何情况下禁止 agent 代改启动配置**——说明是 agent 的职责，动手是用户的决定。

### 实现

- 新增 `lib/host-shortcuts.ps1`（WScript.Shell 读写 .lnk 的 Arguments，UTF-8 BOM，
  base64 单参数传 JSON 绕开 PS 引号地狱）与 `lib/core/host-accessibility.js`
  （spawn + 哨兵 JSON 解析 + 非win32 如实降级）。
- watch 路由 `GET/POST /api/x-control/host-accessibility`（缺控制器报不可用；
  POST 只认布尔 enabled）。开关状态不进配置表单——**快捷方式本身就是唯一事实源**，
  避免"配置说关、快捷方式开着"的双状态漂移。
- 测试 88/88：新增 4 个（PS 真跑的 detect→patch→restore 全循环、路由转发、
  非Windows 降级、目录覆盖）。

## 0.5.12（2026-10-02）

**重做设置页「版本与更新」卡片：四个实测毛病一次修掉。**

用户验收时确认这张卡布局/状态/点击/提示都有问题（它自 0.5.7 起就没人亲眼看过渲染）。
逐条根因与修法：

- **「点了没反应」**：手动「检查更新」不做任何进行中反馈，而坏网络上一次检查能跑
  15~30s——按钮看着可点、点了没动静。现在检查期间按钮变「检查中…」并禁用；
  首屏自动检查失败也会亮出「检查失败 + 重试」，不再停在「正在检查…」假装没发生。
- **「重启生效」提醒会消失**：旧实现靠 `status === 'done'` 分支显示重启提醒，但服务端
  `current` 读磁盘版本、换装完立刻变新号，60s TTL 过后的例行检查把 status 冲回 idle，
  提醒被「已是最新」顶掉。现在服务端快照带 `runningVersion`（内存里真正在跑的版本），
  「待重启」由 `runningVersion !== current` 推导——例行检查、检查失败都冲不掉，
  重启后两者相等、提醒自然消失。「当前版本」行也如实显示 `运行中 X → 已装 Y（重启生效）`。
- **状态文案与帮助文案挤一行**：拆开——每行只放状态，帮助文字沉到卡片底部的小字页脚。
- **检查/更新阶段的按钮文案不分**：服务端检查中显示「检查中…」、换装中才显示「更新中…」。

快照 → 视图的映射抽成纯函数 `resolveUpdateView`（`module.exports.__ui` 导出），
11 条分支全部上单测；`runningVersion` 在 updater 侧的快照持久性也有专测。
「已是最新」现在同时显示运行版本与云端版本，不再是一句没信息量的话。

## 0.5.11（2026-10-02）

**导航超时不再误报：goto 超时后先做一次有界宽限等待，慢启动转成功。**

### 现象（0.5.10 端到端验收，两轮一致）

`x_browser_open` 百度报「导航超时（20s）」，但 `x_browser_tabs` 显示 URL 已设置（标题暂空），
`x_browser_wait(loadState=load)` 随后成功、read 拿到完整 ARIA 树——**导航真实发生了，
只是 domcontentloaded 迟到**。同日宿主侧两轮都复现；shell 直跑同一代码 8 次仅 1 次。
网络通（curl 0.23s）、系统代理与 WPAD 自动检测均关闭，成因无法事后确证（不猜，
参照 0.5.8 的纪律），但「提交后 DCL 迟到」这个形态是确定的。

### 改动

- `BrowserManager.gotoWithGrace`：goto 超时类错误（仅 `Timeout .*exceeded`）后追加一次
  10s 的 `waitForLoadState('domcontentloaded')` 宽限——等到了就当慢启动成功，等不到才
  上抛。`open` / `navigate` / `history` 三条路径统一走它；非超时错误（如
  net::ERR_CONNECTION_REFUSED）不做宽限、立即上抛。
- 超时文案改为点名恢复路径：URL 已设置 = 导航已提交，用 `x_browser_wait` 再等或重试
  一次是正当恢复；URL 都没有才是真的不可达。
- 最坏耗时 20s+10s=30s，换来的是把"实际能开成的页面"从失败里救回来。

## 0.5.10（2026-10-02）

**修掉 `x_status` 的「value is not lossless JSON」；宿主源码终于抽到了，规则全文进了仓库。**

### 现象与两轮错判

`x_status` 一调用就报 `value is not lossless JSON`（0.5.8 之前就坏）。当时锁定过两个
"具体差异"：返回值 schema 有两层嵌套 object、返回了 schema 未声明的 `updateMirror`——
**两个都不是真凶**。真正的门在更早的位置：宿主（app.asar 内 dsh-tools
`createSuccessResult`）对返回值**先做无损 JSON 快照、再做 schema 校验**，快照拒绝
嵌套 `undefined`，而报错只有一句、不说坏在哪。schema 方向的怀疑全白费。

### 根因

`apply()` 里的 `cfg` 对象**漏写了 `bannerIdleExitMs` 的 getter**，而 `x_status` 的
返回值引用了 `cfg.bannerIdleExitMs` → 返回体带上 `config.bannerIdleExitMs: undefined`
→ 宿主快照拒绝。连锁后果：设置页「浮窗空闲自动退出」一直是**死设置**（改了不生效，
banner-win 用默认 120000 兜底，所以没人察觉）。

### 为什么 75 个测试全绿

仓库内全部测试都直接调 `execute`、不经过宿主的快照门。所以这次把门搬进插件：
- 新增 `lib/core/lossless.js`：宿主 `snapshotJsonValue` 规则的插件侧镜像
  （嵌套 undefined / -0 / 非有限数 / 非纯净原型 / 空洞或多余属性的数组 / Symbol 与
  不可枚举键 / 循环引用），报错点名到路径；
- `defineXTool` 在返回边界执行同一规则——宿主那句不给定位的报错，换成能直接定位
  实现的错误，测试当场能抓。
- 顺带抓到潜伏 bug：`tool.js` 缺必填键的分支抛 `ControlXError` 却**没 import**，
  真触发会是 `ReferenceError`——已修，并补回归测试。

### 改动

- `cfg` 补 `bannerIdleExitMs` getter（带有限性守卫，默认 120000）——死设置复活。
- `x_status` 的 output schema 补声明 `updateMirror`（返回了却没声明，schema 要说真话）。
- `updater.js` 文件头仍在教人"顺手算 integrity"（与同文件 300-308 行直接矛盾）——
  按 0.5.8 的终态结论改写。这是活的隐患：下一个读文件头的人就会把 0.5.7 的事故重演。
- `dsh-plugin.json` 的 version 从 0.3.0 追平到 0.5.10（此前与 package.json 脱节五个月）。
- skill 桌面循环补一条：Electron 应用只吐无名 Pane = 渲染器无障碍树未物化，
  让用户带 `--force-renderer-accessibility` 重启该应用（对 DSH 本体实测
  14 → 599 个元素，详见 docs/DSH-SDK-CONTRACT.md §11、§13）。

### 方法论沉淀：宿主源码一直拿得到

交接单曾写「需要宿主侧解码逻辑的源码，当前拿不到」——错。app.asar 里 JS 未压缩，
`readAsarIndex` 能按偏移量读出任意文件；本次 `dsh-tools/lib/index.js:2578` 与
`dsh-util-values` 全文由此抽出，§10.2 当场定案。

## 0.5.9（2026-10-02）

**工具注册时机：默认改成启动即注册。**

### 现象

20 个能力工具藏在 `x_activate` 后面，宿主侧注册是**成功的**——`x_activate` 明确返回
`{ok:true, activated:true, toolCount:20}`——但模型这一侧的工具表里**始终没有它们**：

- 重启 DSH：无
- 新开会话：无
- 会话中途调 `x_activate`：无

而 `apply()` 阶段就注册的两个工具（`x_status` / `x_activate`）一直都在。

### 判断

最合理的解释是：**宿主在会话建立时给模型发一份工具清单，之后注册的工具不再补发**。
于是"运行期注册"等于注册了个寂寞。

**这是推断，不是实证**——宿主把工具清单接口都挡在鉴权后面（`/api/tools`、
`/api/agent/tools` 全 401），preset 给的宿主 checkout 路径在本机不存在，读不到源码。
但"可见的 2 个"与"不可见的 20 个"之间唯一的差别就是注册时机，这个相关性够强，
值得先按它改，再用"重启 + 全新会话"做决定性验证。

### 改动

- 新增配置 `eagerRegister`（默认 **true**）：`apply()` 结束前就调 `registerCapabilities()`。
- `eagerRegister=false` 可退回旧行为。代价是省下 20 份工具 schema 的常驻上下文，
  但那条路现在看走不到模型面前，所以默认不关。
- `x_activate` 保持幂等：已经注册过再调，新增数为 0（新增断言）。

### 别把这道关和另外两道混了

排查时很容易把三件事搅在一起，它们完全不同层：

| 关 | 表现 | 解法 |
|---|---|---|
| **工具可见性**（本次） | 模型工具表里没有该工具，连调用都发不出 | 启动即注册 |
| **总开关** `browserEnabled` / `desktopEnabled` | 工具在表里，执行时报"已关闭" | 设置页打开 |
| **物理输入审批** `trustPhysicalInput` | 工具在表里，物理键鼠被逐次拦下 | 设置页打开 |

### 验证

- 单测 **75/75**（新增 3 条：默认启动注册满 22 个、`eagerRegister=false` 退回门控、
  `x_activate` 幂等；原"常驻只有 2 个"的旧断言已按新契约重写）
- 宿主契约门 **22/22**
- **尚未验证**：是否真的让模型拿到了这 20 个工具。要装上、重启、开一个全新会话才知道。

---

## 0.5.8（2026-10-02）

**紧急修复：0.5.7 自写的 pnpm integrity 让整个 profile 的 pnpm 操作全线失败。**

### 事故

0.5.7 装机约 26 分钟后，用户在插件管理器里卸载插件市场，失败。原因与插件市场无关，
是插件管理器跑 pnpm 时直接报错：

```
[ERR_PNPM_TARBALL_INTEGRITY] .../dsh-control-x/tar.gz/8468716...
  Wanted "sha512-6aKk12KWx5zF72..."   <- 0.5.7 写进锁文件的
  Got    "sha512-ebhAMc6K2NeDaoL..."   <- pnpm 自己下载到的
```

锁文件里那个值是错的。**根因不是"哈希算错"，而是"自己算出来的哈希根本不该被信任"。**
0.5.7 当时的判断依据是"pnpm 对 gitHosted tarball 的 integrity 就是 tarball 字节的
sha512-base64"——那一条在旧 commit（a3d64ff）上实测逐字符成立，于是被直接推广到了新 commit。

而对同一个 commit `8468716` 连下三次，哈希都是 `ebhAMc6K...`，完全稳定——说明
**装机当时拿到的那份字节，和后来 pnpm 拿到的那份不是同一份**。新推的 commit，
codeload 的归档很可能重新生成过（git 对象打包状态不同 → gzip 字节不同），
具体成因我没有查清，也不该靠猜。

### 影响面

pnpm 把这当成"疑似供应链投毒"，于是**该 profile 下任何一次 pnpm 操作**——更新别的插件、
装新的、卸载市场——都会卡在同一条检查上。也就是说：一个插件的更新动作，
能让整个 profile 失去安装能力。

### 改法

`syncProfileSources` **不再写 integrity**，并把本插件那条上可能存在的 integrity **删掉**，
让 pnpm 自己写。形状对齐本 profile 里本来就正常工作的 `dsh-teams-x`：

```yaml
resolution: {gitHosted: true, tarball: https://codeload.github.com/...}   # 无 integrity
```

保留的那部分仍然有用：sha 照旧改对，所以 `pnpm install` 不会把插件打回旧版本——
只是 integrity 交给它的主人生成，而不是我抢着写。

**教训**：往别人维护的锁文件里写"校验和"这类东西，代价与收益完全不成比例。
写对了没人在意，写错一个字符就让整条工具链停摆。要改锁文件，就只改那些
**语义明确、格式唯一**的字段（版本号、commit sha）；校验和让它的主人自己算。

### 验证

- 单测 **73/73**（新增断言：本插件的 resolution 行里不得出现 `integrity`，
  同时隔壁包的 integrity 必须原样保留）
- 宿主契约门 **22/22**
- 现场止血：已把用户 profile 锁文件里那条错值删掉（改前留了
  `pnpm-lock.yaml.cx-bak-*` 备份），sha 仍是 8468716，其余 8 个依赖的 integrity 一律未动

---

## 0.5.7（2026-10-02）

**插件自带版本号与自更新按钮，不再依赖插件市场。**

### 一、为什么要自己做

2026-10-02 实测：市场在 **0.5.5 上卡住不动**。用户"更新并重启"之后——

- `profiles/desktop/package.json` 的 specifier 仍停在 `#a3d64ff`（= 0.5.5），
  文件 LastWriteTime 是重启那一刻，说明确实被重写过，但 pin 纹丝不动；
- `node_modules/dsh-control-x/package.json` 的 `version` 仍是 `0.5.5`；
- 市场日志里**连一条 0.5.6 的记录都没有**（最后一条是 10-01 21:34 的 0.5.2 更新失败）。

更新能力不能寄存在一个会静默不动的第三方身上，所以本版本自带。

### 二、设置页长什么样

新增分组「版本与更新」，两张行：

- **当前版本** —— 显示盘上真实版本（读盘上的 `package.json`，不是内存里那份）；
- **检查更新** —— 打开设置页**自动检查一次**，只有真拿到更高的版本号才渲染
  `更新到 0.x.y` 按钮；已是最新 / 检查失败 / 更新失败分别有各自的文案。

### 三、更新怎么执行

`lib/core/updater.js`，四个环节：

1. **查版本**：`GET https://raw.githubusercontent.com/<repo>/main/package.json`。
   不用 GitHub API（无限流、不用 token）。
2. **下载**：`GET https://codeload.github.com/<repo>/tar.gz/main`，
   同时算出 `sha512-<base64>` 作为 integrity。
3. **换装**：`tar -xzf` 解包后**整目录 `rename` 走、再 `cpSync` 拷回来**。
4. **同步来源**：把 `profile/package.json` 的 pin 与 `pnpm-lock.yaml` 一起改到新 commit。

### 四、两个必须说清楚的实现约束

**① 绝不能原地写已安装的文件。** 实测 `node_modules/dsh-control-x` 里的文件是
pnpm 内容寻址存储的**硬链接**：

```
fsutil hardlink list ...\dsh-control-x\lib\banner-overlay.ps1
  \.pnpm-store\v11\tmp\_tmp_21360_...      <- 上次装到一半留下的残留
  \Users\...\node_modules\dsh-control-x\lib\banner-overlay.ps1
  \.pnpm-store\v11\files\f5\a72d917c...   <- 按 sha512 命名的共享 blob
```

原地覆写等于改坏 store 里那个被别的安装面共用的 blob。所以流程是"整目录搬走 + 全新拷贝"：
`rename` 只搬链接、不碰 store，`cpSync` 落的是全新 inode（链接数 1）。

**② 锁文件必须一起改对。** pnpm 对 `gitHosted` tarball 的 integrity **就是 tarball 字节的
sha512-base64**——实测下载 `a3d64ff` 的 tarball 算出来与锁文件里的值逐字符相同：

```
computed: sha512-sQp8ETh02mrvlsUmbom2WWSMvOThWdninqLKeHh3sKv3xyZB9X1iDreQK23c6DpF2z3xJKzGOj+GdMx1mFR/og==
lockfile: sha512-sQp8ETh02mrvlsUmbom2WWSMvOThWdninqLKeHh3sKv3xyZB9X1iDreQK23c6DpF2z3xJKzGOj+GdMx1mFR/og==
```

插件进程里**没有可执行的 pnpm**（只有 corepack 的 shim，首次使用要联网下载），
所以锁文件是手写改的。不同步的代价很具体：**将来任何一次 `pnpm install` 都会把插件
悄悄打回旧版本，且没有任何提示。**

锁文件改写按块处理（条目头 = 两空格 + 非空格，块内 = 四空格缩进），只动本插件那个块的
`version` 与 `integrity`；旧 sha 是 40 位十六进制的独占标记，全文替换。
改到一半失败会整体还原——半改的锁文件比不改更糟。

### 五、机器慢的那次超时：不是慢，是卡

第一次端到端跑，`checkUpdate` 报了一次 `The operation was aborted due to timeout`，
而同一时刻下载 tarball 却只用了 2 秒。于是量了两条路线（各 6 次）：

| 目标 | 成功率 | 中位耗时 |
|---|---|---|
| 直连 `raw.githubusercontent.com` | 6/6 | **78ms** |
| `gh-proxy.org` 代理 `raw` | 6/6 | 247ms（**慢 3.2 倍**） |
| 直连 `codeload`（155KB tarball） | 4/4 | **523ms** |
| `gh-proxy.org` 代理 `codeload` | 4/4 | 731ms（**慢 1.4 倍**） |

**镜像不快，所以没把它设成默认。** 真正的毛病是偶发**连接卡住**——另一轮里直连出现过
一次 19 秒后 `ECONNRESET`。那不是带宽问题，是连接问题，重试一下就好。

所以做了两件事：

- **自动重试**：直连各重试 2 次（下载 3 次），退避 400ms/800ms，只对"没有答复"的失败
  （超时、ECONNRESET、DNS）重试；HTTP 4xx/5xx 是明确答复，重试也没用。
- **可选镜像兜底**：设置页新增「更新镜像」，填 URL 前缀（如 `https://gh-proxy.org/`），
  **只在直连全部失败后才用**，默认留空。改完不用重启插件（`cfg` 是 getter，控制器
  每次作业现读一次）。

### 六、测试里逮到的三个真 bug

"连点两次更新只跑一次"这条用例第一次跑就红了：`rename EPERM`。查下来是
`createUpdateController` 的 `startApply()` **漏了 `inflight = job` 这一行**——
单飞闸形同虚设，连点两次会并行跑两个 `applyUpdate`，两个都去 `rename` 同一个包目录，
第二个在第一个已经搬走之后炸。而这正是用户在 UI 上双击按钮就会踩到的路径。

另一个：锁文件改写最初按"条目块"处理，漏掉了 `importers` 段——那里的
`specifier` / `version` 缩进在 6~8 空格的层里，不属于任何条目块，
结果旧 sha 残留在锁文件里。测试断言"旧 sha 不该残留"把它逼了出来。

第三个是我自己造的：写代码时把 `\0`（NUL）当字面字符写进了源文件，**文件被当成 binary**、
`edit` 工具直接拒收。逐字节扫 9/13/32 之间的位置才找到——全量扫过 `lib/`，0 个残留。

### 七、验证

- 单测 **73/73**（`tests/updater.test.mjs` 14 条 + `ui.test.mjs` 结构契约 1 条）
- 宿主契约门 **22/22**（`scripts/host-contract-verify.mjs`）
- 换装链路在**真网络 + 真 tar + 真实 282 行 profile 锁文件**下端到端跑通：
  0.5.5 → 0.5.6 用时 1992ms，锁文件**只改 6 行**（5 处 sha + integrity + version），
  其余包一个字节没动
- `m1/m2/m3` 在当前沙箱里跑不了（它们要真拉起 Edge 进程，`spawn EPERM`），
  这与本改动无关，报出来不掩饰

---

## 0.5.6（2026-10-02）

**去掉打字效果；修掉横幅内容层间歇性空白（用户报的"一闪一闪"）。**

### 一、横幅一闪一闪：一个不是显隐的"显隐"bug

用户报告 Agent 操作时横幅在闪。**先量再判**：把状态文件固定为 active 不变，
每 50ms 采一次屏幕像素，同时记录 `IsWindowVisible`。

```
visible-state changes over 8s : 0        <- 窗口全程可见，不是显隐抖动
dot    : 204x60 57x55 200x54 37x31      <- 37 是背景色：圆点有 31/200 次是空的
mid    : 212x163 37x37                  <- 正文中间的字同样 37/200 次是空的
```

结论：**整层内容间歇性不绘制，而窗口始终可见**。不是显示/隐藏切换，是重绘问题。

根因在 `lib/banner-overlay.ps1` 的 `Set-CxGeometry`：它**无条件**赋值
`$form.Size` 与 `$form.Region`，而 tick 在横幅可见时每秒调用它约 11 次。
**给窗口赋 Region 会让 Windows 重建窗口并整窗重绘**，于是频繁留下空白帧。

修法：只在值真的变了才赋值（Size/Region 与 Location 分别判断）。这条改动本身就是全部修复。
附带：`Invalidate()` 改成只在状态点颜色真正变化时才调——没有新东西要画就不重绘。

复测（同一脚本、同样 200 次采样）：`dot : 204x71 57x66 200x62 37x1`，
**空白从 31 次降到 1 次**。

### 二、打字效果去掉

用户要求「横幅的打字效果去掉」。连同**闪烁光标**一起去掉——它按
`Millisecond % 800 < 400` 闪烁，也就是 **1.25 Hz**，用户看到的"一闪一闪"里有它一份。
现在横幅里唯一的动画是状态点的红/黄/蓝变色。

- 浮窗：`$script:Shown` / `$script:Dots` / 打字计数 / 光标整块删除。
- Node：`BANNER_DOTS` 导出与 `dots` 字段删除，`stateSignature` 相应简化。
- 网页内横幅：打字定时器与光标元素删除，`TYPE_MS` 与 `dsh-control-x-blink` 关键帧删除。

### 顺带修掉一处我自己早先埋的坏数据

`stateSignature` 里的分隔符曾经是**一个字面控制字符 U+0001** 而非空字符串——
某次脚本化改写把它写坏了。它是 ASCII 不可见字符，grep 查不到，功能上也只是分隔符不同，
所以一直没被发现；这次逐字符 dump 才发现（`join(40, 1, 41)`）。
已改为 `'|'`，并对 `lib/` 全目录扫描确认没有其他游离控制字符。

### 验证

- 单测 **58/58**（新增 2 条：横幅内只剩圆点与文字两个元素且 600ms 后文案不变；
  reduced-motion 下圆点固定单色、不跑动画）。
- 宿主契约门 22/22，m1/m2/m3 全过。
- 真进程像素复测见上；截图 `.evidence/banner-noflash.png`。

## 0.5.5（2026-10-01）

**「全权操控」+ 横幅文案与状态点改版 + 修掉左上角闪一下。**

### 一、全权操控：物理键鼠不再半自动

用户原话：「既然是全权操控电脑那肯定是让你来按我指令来操控的。并不是半自动的。」

实测卡住的根因是**一个真 bug**：`confirm_disturbance` 这个参数**在 schema 与工具描述里
都写成了"审批服务不可用时的出口"，可代码里从来没用过它**——
`guardPhysical(exec, toolName, label)` 的签名里根本没有这个形参，三个调用点也没传。
所以哪怕模型显式自认"我知道会打扰你"，也照样被拒。

- `guardPhysical` 现在真的接收 `confirm`，三个调用点
  （`x_desktop_mouse_click` / `x_desktop_type` / `x_desktop_key`）都传 `args.confirm_disturbance`。
- 新增配置 **`trustPhysicalInput`（默认关）** 与设置页「全权操控（免逐次审批）」。
  开启后物理键鼠连审批都不问。
- 三种放行互不重叠：`trustPhysicalInput` → 用户当场点了允许 → 审批服务不存在且模型自认。
  **`rejected` 永远不放行**——那表示确实有人点了拒绝，自认和信任开关都无效。
- **危险目标（删除/支付/注销）走的是另一条护栏 `guardDangerous`，不受本开关影响。**
  「全权操控」放行的是键鼠，不是不可逆操作。空闲检测同样保留。

### 二、横幅左上角闪一下（真 bug，已修并实测）

用户报告：启动电脑操控时横幅会**先在左上角闪一下，再跳到正中**。

成因：`Application.Run($form)` 会用构造默认值（`0,0` / `420x40`）把窗体显示出来，
第一个 tick 才通过 `Set-CxGeometry` 把它挪到正中。**那一帧就是左上角那一下。**

修法：让"Run 强行显示的那一帧"不可能是错的——
1. `Run` 之前先同步读一次状态文件，填好文案并调用 `Set-CxGeometry`；
2. `Run` 之前把 `Opacity` 压到 `0`（完全透明），tick 判定要显示时才恢复 `0.82`。

实测（起真浮窗，从进程启动开始每 12~30ms 采样窗口矩形）：

```
first visible frame: (1054,18) 451x40
expected centered  : x = 1280 - w/2 = 1054
distinct positions : 1  -> 1054,18
ever seen (0,0)    : False
```

### 三、横幅文案与状态点

- 文案改为 **「X-Agent正在控制电脑，操控键鼠会打断操作」**（浮窗与网页内横幅同步改）。
  后半句是在告知用户"我随时可能抢你的键鼠"，被 Agent 打断时知道原因。
- **状态点由蓝色单点改为红→黄→蓝三色，每 2 秒切换一次**。相位取自墙钟，
  所以切换对齐整秒，不随帧率抖动。网页内横幅用同周期的 CSS `step-end` 动画，
  `prefers-reduced-motion` 下固定为蓝色静止。
- 三色与周期抽成 `DOT_COLORS` / `DOT_CYCLE_MS` 常量，避免浮窗与网页各写一套。
- 实测取色（每 800ms 采一次屏幕像素）：`204,61,57` 红 → `200,152,8` 黄 → `57,111,203` 蓝，
  **三种颜色都出现**（数值比设定值略暗，是 0.82 的窗体不透明度叠加所致，符合预期）。

### 验证

- 单测 **58/58**（新增 3 条：三色常量、Run 之前必须先算几何且全透明起步、
  `confirm_disturbance` 必须被真正接收并只在 `unavailable` 分支生效）。
- 宿主契约门 22/22，m1 14 步 / m2 / m3 全过。
- 真进程端到端：起真浮窗验证位置与取色，见上。

## 0.5.4（2026-10-01）

**横幅浮窗改为按需拉起：不操控就零进程。**

### 改了什么

用户要求「让横幅在 agent 操控的时候才加载，不随 DSH 启动而启动」。原来是 `apply()` 里
直接 `banner.start()`，浮窗随宿主启动就常驻——即使从头到尾没操控过，也留一个 PowerShell
进程每 500ms 读一次状态文件。

- `createActivityTracker` 新增 `onBegin(tool, kind)` 钩子，在 `begin()` **末尾**触发
  （状态已更新之后，订阅者读 `snapshot()` 看到的就是"活跃"——浮窗第一帧就画得出，
  不会先空一帧再补）。
- `apply()` 不再直接 `start()`，改为挂在 `onBegin` 上：**第一次真的动手才拉起浮窗**。
- `createDesktopBanner` 新增 `idleExitMs`（默认 120000）：停手够久后**自己退出**并清掉临时目录，
  下次操控再拉起。退出后 `statePath` 归 null。
- `start()` 加幂等闸：按需拉起意味着它会被每个动作调一次，没有这道闸会一路 spawn 出
  第二个 PowerShell，界面上变成两个横幅叠着。
- 重新拉起时重置 `lastActiveAt`，否则一个久未活动的浮窗起来立刻又自杀。
- 新增配置项 `bannerIdleExitMs` 与设置页「横幅空闲退出（毫秒）」，0 = 用过一次就不再退出。
  `x_status` 的 config 块也补上 `desktopBanner` / `bannerIdleExitMs`。

### 退出时刻是 graceMs + idleExitMs，不是 idleExitMs

`lastActiveAt` 记的是「横幅最后一次**可见**」的时刻，而横幅在最后一次动作后还要靠
`graceMs`（5 秒）继续停留。所以停手后真正退出的时刻是 `5s + idleExitMs`。
这是刻意的：宽限期内横幅还显示着，不该在它正显示时把进程杀掉。

### 验证

- **真进程端到端**（`.evidence/lazy-e2e.mjs`，真实 spawn PowerShell）：
  未操控 `available=false / statePath=null` → 第一次操控自动拉起（真实目录+进程）
  → 停手超过 `graceMs+idleExitMs` 后 `available=false / statePath=null` → 第二次操控重新拉起。
  全程结束 **0 残留进程、0 残留目录**。
- 单测 **55/55**（新增 3 条：按需拉起+幂等+超时退出、`apply()` 里 `banner.start()` 只能出现一次、
  `onBegin` 触发时快照已 active）。
- 宿主契约门 22/22，m1 14 步 / m2 / m3 全过。
- 跑完全套与验收脚本后 `%TEMP%` 零新增目录、零新增进程。

### 已知（非本插件代码问题）

`npm run selfcheck` 会报一条：profile 的 `cordis.patch.yml` 里存在顶层 `- id: dsh-control-x` 条目，
而插件是 bundle（自带 `cordis.patch.yml`，宿主自动应用包内 patch）→ 同 id 双声明。
实测是 **2026-10-01 22:47 市场安装 0.5.3 时写进 profile 的**，插件本身仍正常挂载
（`/api/x-control/*` 全部 200）。但历史上市场更新正是因此报过
「duplicate loader entry id "dsh-control-x" (2 rows)」并回滚，值得在下次更新前处理。

## 0.5.3（2026-10-01）

**修掉一个真 bug：横幅浮窗从启动起就钉在桌面左上角不消失。**

### 问题

用户报告桌面左上角常驻一个「带蓝色小圆点的空框」。**不是残留进程**——全机只有宿主拉起的那一个
浮窗进程，指向已安装的 profile 路径。取证：窗口 `dsh-control-x-banner` `Visible=True`，
位置 `(0,0)`、尺寸 `420x40`；而同一时刻 `banner.json` 是 `active:false`、
`/api/x-control/activity` 报 `running:false`——**状态说该隐藏，窗口却显示着**。

### 根因（`lib/banner-overlay.ps1`，两处叠加）

1. **`[System.Windows.Forms.Application]::Run($form)` 会自己 `Show()`**，
   把脚本里紧挨其前的 `$form.Show(); $form.Hide()` 抵消掉了。
2. 显隐判断写成 `if ($wantVisible -ne $script:Visible)`，**只在跳变时动作**。而
   `$script:Visible` 初值 `$false`，与「要隐藏」一致，于是 `Hide()` 一次都不会执行；
   缓存标志与表单真实可见性脱钩后永不重新同步。

三个症状同一个原因：位置停在 `(0,0)` 是因为 `Set-CxGeometry` 只在「要显示」时才跑，
永远不跑，尺寸停在构造值 `Size(420,40)`（**实测 420x40 正是构造值**）；有蓝点没文字，
是因为 `Paint` 无条件画圆点而 `Base`/`Dots` 是空串。

### 修法

显隐改读**表单真实状态**而非缓存标志（`if (-not $form.Visible) { Show() } else { if ($form.Visible) { Hide() } }`），
删掉那对误导性的 `Show(); Hide()` 前奏，首次 tick 间隔设为 16ms，让自愈在 `Run` 之后立刻发生。

### 顺带修掉临时目录泄漏

`%TEMP%` 下堆了 **62 个 `dsh-control-x-*` 孤儿目录、16.3 MB**，已全部清理。两个成因：

- `createDesktopBanner()` 一创建就 `mkdtempSync`，只有 `stop()` 才删 → 改为**在 `start()` 里惰性创建**，
  `stop()` 后置空以便复用；返回对象里的 `statePath` 相应改为 getter。
- `tests/smoke.test.mjs`（3 次 `apply()`）与 `tests/host-contract.test.mjs`（4 次）的 mock ctx
  **没有 `effect`**，所以 `ctx.effect(() => () => banner.stop())` 形同虚设，销毁钩子从不注册 → 补上
  `effect` 收集器并用 `t.after` 收尾。

### 验证

- **复现**：拿装好的脚本配一个 `active:false` 的 state 起进程 → `VISIBLE at (0,0) size 420x40`，
  与线上实例逐字节一致（不是推断）。
- **复测三态**：`active:false → hidden`；`active:true → VISIBLE (1160,18) 240x40`
  （1160 = (2560−240)/2，**居中正确**）；再回 `false → hidden`。
- 跑完整套单测后 `%TEMP%` **零新增目录、零新增进程**（修复前 smoke 漏 3、host-contract 漏 4）。
- 单测 **51/51**，宿主契约门 22/22。
- 新增两条结构化回归测试：「显隐必须读 `$form.Visible` 真实状态」与「没 `start()` 就不建目录」。
  前者做了**变异测试**——把修复还原后该用例 pass 0 / fail 1，确认守得住。

### 部署注意

已安装的 `banner-overlay.ps1` 与 pnpm 内容寻址存储是**同一条 inode**
（`fsutil hardlink list` 查到 3 个链接）。直接覆盖写会改坏 store 里按 sha512 命名的文件。
正确做法：先 `Remove-Item` 摘掉这条链接（store blob 不受影响），再写新文件，
改完断言 store blob 的 SHA512 未变、installed 链接数为 1。

### 需要用户做的

**重启 DSH 后生效**。不要直接杀那个浮窗进程：`banner-win.js` 只在 `start()` 里拉起、
`stop()` 才 kill，宿主**不会重拉**，杀掉后横幅会彻底消失直到重启。

## 0.5.2（2026-10-01）

**横幅按用户口径重做：只留一句话，点才有动画。**

### 变更（均为用户 2026-10-01 明确要求）

- **文案固定为「X-Agent 正在操控面」**，去掉工具名（原会显示「（x_desktop_launch）」）。
  桌面与浏览器活动共用同一句——用户要的是「有没有人在动我的电脑」，不是技术细节。
- **打字效果只作用于末尾三个点**：正文立刻完整出现，`...` 逐个打出。状态新增 `dots` 字段。
- **变化签名不再纳入 `tool`**：工具名每次动作都在变，纳入会导致每步都重置打字动画。
- **背景框小圆角**：圆角半径 20 → 8（原为胶囊形 `border-radius:999px`）。
- **半透明**：`Opacity` 0.97 → 0.82。
- **停手 5 秒后才消失**：宽限期 2500ms → 5000ms。2.5s 在真实节奏下会一闪一闪——
  思考、调工具、看结果之间的间隔常常就超过 2.5 秒。
- **设置页新增「浏览器空闲关闭（毫秒）」**：该能力早已实现
  （`browserIdleMs` + `manager.js` 空闲定时器，默认 5 分钟整个关掉浏览器），
  但一直没有设置页入口等于藏起来了。0 = 永不自动关。

### 验证

单测 49/49（新增「文案固定不带工具名」「签名忽略工具名与活动种类」两条锁住新契约的断言）。

### 未修（已知）

浮窗进程在「直接调 `apply()` 却没走 dispose」的路径上会残留（测试脚本、宿主热重载），
会在桌面左上角留一个空胶囊框。本次已手工清理，代码未加看门狗，待用户决定是否下次一起修。

> 已在 **0.5.3** 处理：当时判断有误——那个框不是进程残留，而是浮窗显隐 bug 本身
> （`Application.Run` 抵消 Hide + 只在跳变时动作）。进程泄漏与临时目录泄漏一并修掉。

## 0.5.1（2026-10-01）

**横幅改成真正的桌面置顶浮窗；Agent 一用浏览器就自动弹出右侧栏。**

起因是两条用户实测反馈：「桌面横幅没有提示」「侧边栏并没有弹出使用浏览器」。
逐条查证后，两条都不是"没实现"，而是实现方式在真实使用场景里够不着：

### 诊断（先证据后改法）

- **横幅本来是好的**：实测触发一次 `x_desktop_*` 并在 2.5s 宽限期内截图，
  清楚看到圆角框 + 蓝点 + `X-Agent 正在操控中...（x_desktop_apps）`。
  服务端 `/api/x-control/activity` 也如实返回 `{"active":true,"tool":"x_desktop_apps"}`。
  真因是：网页里的 `position:fixed` 横幅只存在于 **DSH 窗口的渲染层**。
  Agent 操控记事本时用户盯着记事本、DSH 窗口在后面，横幅被压在下面看不见。
- **侧边栏从不会自动弹**：代码里根本没有"打开面板"的路径，只有入口。
  另核实了注册契约本身没问题——在 `app.asar` 里读到宿主
  `dsh-client-ui-sidebar-right/lib/client.js` 的注册门（`DEFAULT_BAND="extension"`、
  `sidebar.right.pane.tab` / `.title` 两个 keyed seat 均存在），与官方
  `dsh-client-ui-plan` / `dsh-client-ui-schedule` / `dsh-client-ui-sidebar-browser`
  的写法一致，不存在"因为字段不对所以静默不显示"。

### 变更

- **桌面置顶横幅（Windows 原生浮窗）**：新增 `lib/banner-win.js` +
  `lib/banner-overlay.ps1`。无边框、`TopMost`、**点击穿透**（`WS_EX_TRANSPARENT`）、
  不抢焦点（`WS_EX_NOACTIVATE`）、不进 Alt+Tab（`WS_EX_TOOLWINDOW`）、DPI 感知、
  圆角、打字机 + 闪烁光标。宿主侧持有活动快照，**只在状态变化时**写状态文件，
  浮窗自己轮询渲染——不在浮窗里发 HTTP。
- **主题色跟随**：原生浮窗读不到 `--dsw-alias-*` 这类 CSS 变量，改为客户端解析后
  经 `POST /activity-theme` 上报，切深/浅色自动跟随（`MutationObserver` 监听
  `data-ds-dark-theme`）。服务端只接受 `#RGB/#RRGGBB/#AARRGGBB`，非法值丢弃。
- **浏览器活动也进横幅**：原先只跟踪 `x_desktop_*`，浏览器动作对用户完全不可见。
  现在 `x_browser_*` 以 `kind='browser'` 计入，文案区分为「正在操控桌面…」与
  「正在使用浏览器…」。
- **浏览器活跃时自动弹出右侧栏**：一轮活动只弹一次，不做每 600ms 重复 openTab。
- **网页内横幅降级为回退**：`/activity` 报 `overlay=true` 时网页那份主动隐藏，
  两个横幅叠在一起比一个更糟；原生浮窗起不来（非 Windows / PowerShell 缺失）
  才回落到网页横幅。
- 设置页新增「桌面置顶横幅」开关（`desktopBanner`，默认开）。

### 修复（实测踩到，全部有据）

- `Timer` 创建后是**静止**的，不调 `Start()` 就没有打字动画——表现为一个空框
  永远停在左上角。已加断言锁住。
- Windows PowerShell 5.1 在**无 BOM** 时按 ANSI 解码 `.ps1`，脚本里的中文
  字面量被打散成解析错误（`ParserError: 意外的标记"}"`）。浮窗脚本改为**纯 ASCII**，
  文案经状态文件传入（本来就该这样）。
- 浮窗子进程会让 Node 事件循环一直被吊住：宿主里表现为插件卸载后不退出，
  测试里表现为 `node --test` 永不结束。加 `child.unref()`。

### 验证

- 单测 50/50（含新增 `tests/banner-win.test.mjs`）；`verify:contract` 22/22。
- 真机起真浮窗截图确认：置顶居中、圆角框、打字动画、盖在 Edge 窗口之上可见。

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
