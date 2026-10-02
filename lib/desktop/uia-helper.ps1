# dsh-control-x 桌面观察与语义动作 helper（PowerShell + .NET UIA，兼容 Windows PowerShell 5.1）。
#
# 协议：stdin 收一行 JSON {command, ...args}；stdout 输出单行
#   __X_CONTROL_RESULT__{json}
# 观察类命令只读；动作类命令只使用 UIA 模式（Invoke/Value/Scroll/Toggle/Select/
# ExpandCollapse）——这些是对应用无障碍接口的 COM 调用，不注入任何输入事件，
# 不抢前台焦点（PROPOSAL.md §6.7-3 的 Windows 实现）。物理键鼠输入不在本 helper 内。
#
# RuntimeId 是 UIA 官方的跨调用元素标识：观察时记录，动作时在同一窗口树内
# 按 RuntimeId 重新解析（元素对象不能跨进程边界传递）。解析失败一律报错，
# 不猜测、不重试旧状态（§6.5-1）。
$ErrorActionPreference = 'Stop'
# 强制 UTF-8 stdio：PS 5.1 重定向管道默认用控制台代码页（GBK），不修正则
# 中文窗口标题/元素名在 JSON 里全是乱码（M2 实测证据）。必须在 ConvertFrom-Json 之前设置。
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace XNative -Name Foreground -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'

# 带错误码的异常，让 Node 侧拿到结构化错误（类定义必须在任何使用之前）。
class XControlException : System.Exception {
    [string] $Code
    XControlException([string] $code, [string] $message) : base($message) { $this.Code = $code }
}

$SENTINEL = '__X_CONTROL_RESULT__'

function Out-Result($obj) {
    Write-Output ($SENTINEL + ($obj | ConvertTo-Json -Depth 8 -Compress))
}

function Out-Fail($code, $message) {
    Out-Result @{ error = @{ code = $code; message = $message } }
}

function Get-TopWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $fg = [XNative.Foreground]::GetForegroundWindow()
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $list = @()
    foreach ($w in $wins) {
        $c = $w.Current
        $procName = ''
        try { $procName = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
        $list += [pscustomobject]@{
            pid = $c.ProcessId; processName = $procName; title = $c.Name
            className = $c.ClassName; hwnd = [int64]$c.NativeWindowHandle
            focused = ($fg -eq [System.IntPtr]$c.NativeWindowHandle)
        }
    }
    return ,@($list)
}

function Resolve-Window($spec) {
    # $spec: { pid?, hwnd?, title? } —— 三种定位方式，命中多个时报错而非猜测。
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $wins = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
    $hits = @()
    foreach ($w in $wins) {
        $c = $w.Current
        if ($null -ne $spec.pid -and $c.ProcessId -ne [int]$spec.pid) { continue }
        if ($null -ne $spec.hwnd -and [int64]$c.NativeWindowHandle -ne [int64]$spec.hwnd) { continue }
        if ($null -ne $spec.title -and ($c.Name -notlike ('*' + $spec.title + '*'))) { continue }
        $hits += $w
    }
    if ($hits.Count -eq 0) {
        throw [XControlException]::new('ELEMENT_UNAVAILABLE', "没有命中的顶层窗口（pid=$($spec.pid) hwnd=$($spec.hwnd) title=$($spec.title)）。先调用 x_desktop_apps 获取当前窗口列表。")
    }
    if ($hits.Count -gt 1) {
        $titles = ($hits | ForEach-Object { '"' + $_.Current.Name + '"' }) -join ', '
        throw [XControlException]::new('STALE_STATE', "命中 $($hits.Count) 个窗口：$titles。请补 hwnd 精确指定。")
    }
    return $hits[0]
}

function Get-RoleName($el) {
    return $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
}

function Get-PatternNames($el) {
    $names = @()
    foreach ($p in $el.GetSupportedPatterns()) {
        $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')
    }
    # 逐元素重建数组：PS 5.1 的 ,@() 包装 + @() 重收 + ConvertTo-Json 组合
    # 会产生嵌套数组（实测 [["Invoke"]]），必须避开管道展开陷阱。
    $names = @()
    foreach ($p in $el.GetSupportedPatterns()) {
        $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')
    }
    return $names
}

function Get-ElementValue($el) {
    try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        return $vp.Current.Value
    } catch { return $null }
}

function Get-ToggleState($el) {
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        return $tp.Current.ToggleState.ToString()
    } catch { return $null }
}

function Invoke-PatternAction($el, $action) {
    $supported = Get-PatternNames $el
    if ($action -and $action -ne 'auto' -and $supported -notcontains $action) {
        throw [XControlException]::new('ACTION_UNAVAILABLE', "元素未通告 $action 模式（可用：$($supported -join ', ')）。不要猜动作名。")
    }
    $order = @('Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse')
    if ($action -and $action -ne 'auto') { $order = @($action) }
    foreach ($name in $order) {
        try {
            switch ($name) {
                'Invoke'        { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'Invoke' }
                'Toggle'        { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return 'Toggle' }
                'SelectionItem' { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return 'SelectionItem' }
                'ExpandCollapse'{ $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); return 'ExpandCollapse' }
            }
        } catch {
            continue  # 该模式实际不可用，尝试下一个
        }
    }
    throw [XControlException]::new('ACTION_UNAVAILABLE', "元素不支持任何语义动作（通告：$($supported -join ', ')）。")
}

function Find-ByRuntimeId($window, $runtimeId) {
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $want = ($runtimeId -join '.')
    foreach ($el in $all) {
        try {
            if ((($el.GetRuntimeId()) -join '.') -eq $want) { return $el }
        } catch { continue }  # 元素已消失：跳过，最终按未命中处理
    }
    return $null
}

function Observe-Tree($win, $maxElements) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $elements = @()
    $lines = @()
    $index = 0
    $stack = New-Object System.Collections.Stack
    $stack.Push(@(@($win), 0))
    while ($stack.Count -gt 0 -and $index -lt $maxElements) {
        $item = $stack.Pop()
        $el = $item[0]; $depth = $item[1]
        if ($index -gt 0) {
            $c = $el.Current
            $value = Get-ElementValue $el
            $rid = @()
            foreach ($r in $el.GetRuntimeId()) { $rid += [int]$r }
            $pn = @()
            foreach ($p in $el.GetSupportedPatterns()) {
                $pn += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')
            }
            $elements += [pscustomobject]@{
                index = $index
                runtimeId = $rid
                role = (Get-RoleName $el)
                name = $c.Name
                enabled = $c.IsEnabled
                isPassword = $c.IsPassword
                focused = $c.HasKeyboardFocus
                patterns = $pn
                value = $value
                toggleState = (Get-ToggleState $el)
            }
            $indent = '  ' * $depth
            $valueHint = ''
            if ($null -ne $value -and $value.Length -gt 0) { $valueHint = ' = ' + ($value.Substring(0, [Math]::Min(40, $value.Length))) }
            $pw = ''
            if ($c.IsPassword) { $pw = ' [password]' }
            $lines += ('{0}- {1} "{2}" #{3}{4}{5}' -f $indent, (Get-RoleName $el), $c.Name, $index, $valueHint, $pw)
        }
        $index++
        $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition)
        for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push(@($children[$i], $depth + 1)) }
    }
    $sw.Stop()
    # 截断取证（2026-10-02 飞书任务教训）：循环因达到 maxElements 而停手时栈里还有
    # 待展开的子树——不把这个事实报出去，「控件不存在」其实是「被截断没看到」。
    $truncated = ($stack.Count -gt 0)
    return @{ elements = @($elements); tree = ($lines -join "`n"); elapsedMs = $sw.ElapsedMilliseconds; truncated = $truncated }
}

# ── 命令分派 ──
try {
    $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
    switch ($req.command) {
        'list_windows' {
            Out-Result @{ windows = (Get-TopWindows) }
        }
        'observe' {
            $win = Resolve-Window $req
            $c = $win.Current
            $max = 400
            if ($null -ne $req.maxElements) { $max = [int]$req.maxElements }
            $procName = ''
            try { $procName = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
            $tree = Observe-Tree $win $max
            Out-Result @{
                window = @{ pid = $c.ProcessId; title = $c.Name; className = $c.ClassName; hwnd = [int64]$c.NativeWindowHandle; processName = $procName }
                elements = $tree.elements
                tree = $tree.tree
                elapsedMs = $tree.elapsedMs
                truncated = $tree.truncated
            }
        }
        'press' {
            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId)
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素在当前窗口树中不存在。请重新调用 x_desktop_tree。') }
            $used = Invoke-PatternAction $el $req.action
            $nc = $win.Current
            Out-Result @{ used = $used; window = @{ pid = $nc.ProcessId; title = $nc.Name; hwnd = [int64]$nc.NativeWindowHandle } }
        }
        'set_value' {
            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId)
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素在当前窗口树中不存在。请重新调用 x_desktop_tree。') }
            if ($el.Current.IsPassword) {
                throw [XControlException]::new('NOT_SETTABLE', '敏感输入保护：密码框拒绝自动写入——密码必须由用户本人输入。')
            }
            $vp = $null
            try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
            if ($null -eq $vp) {
                # contenteditable（通告里只有 Text 等读写模式）没有 UIA 写入通道：给出可行路径而不是死路。
                throw [XControlException]::new('NOT_SETTABLE', "元素不支持 ValuePattern（通告：$((Get-PatternNames $el) -join ', ')）。"
                    + '富文本/contenteditable 输入框的写入通道是物理输入：x_desktop_type（Unicode）或剪贴板（Set-Clipboard 后 x_desktop_key ctrl+v）。')
            }
            $vp.SetValue([string]$req.value)
            $nc = $win.Current
            Out-Result @{ used = 'ValuePattern'; window = @{ pid = $nc.ProcessId; title = $nc.Name; hwnd = [int64]$nc.NativeWindowHandle } }
        }
        'rect' {
            # 物理点击路径的前置取证：元素矩形 + 窗口是否前台。
            # 本命令只读；真正的前置与点击由 Node 侧的显式打扰门控执行（§6.7-4）。
            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId)
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素不存在。请重新观察。') }
            $r = $el.Current.BoundingRectangle
            $nc = $win.Current
            $fg = [XNative.Foreground]::GetForegroundWindow()
            # GetClickablePoint 偶发 NoClickablePoint（窗口渲染时序），回退矩形中心。
            $cx = [int]($r.X + $r.Width / 2)
            $cy = [int]($r.Y + $r.Height / 2)
            try {
                $center = $el.GetClickablePoint()
                $cx = [int]$center.X
                $cy = [int]$center.Y
            } catch {}
            Out-Result @{
                element = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height; clickX = $cx; clickY = $cy }
                window = @{ pid = $nc.ProcessId; title = $nc.Name; hwnd = [int64]$nc.NativeWindowHandle; foreground = ($fg -eq [System.IntPtr]$nc.NativeWindowHandle) }
            }
        }
        'scroll' {            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId)
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素不存在。请重新观察。') }
            $sp = $null
            try { $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } catch {}
            if ($null -eq $sp) { throw [XControlException]::new('ACTION_UNAVAILABLE', '元素不支持 ScrollPattern。') }
            $amount = 3
            if ($null -ne $req.amount) { $amount = [int]$req.amount }
            switch ($req.direction) {
                'up'    { for ($i = 0; $i -lt $amount; $i++) { $sp.ScrollVertical([System.Windows.Automation.ScrollAmount]::SmallDecrement) } }
                'down'  { for ($i = 0; $i -lt $amount; $i++) { $sp.ScrollVertical([System.Windows.Automation.ScrollAmount]::SmallIncrement) } }
                'left'  { for ($i = 0; $i -lt $amount; $i++) { $sp.ScrollHorizontal([System.Windows.Automation.ScrollAmount]::SmallDecrement) } }
                'right' { for ($i = 0; $i -lt $amount; $i++) { $sp.ScrollHorizontal([System.Windows.Automation.ScrollAmount]::SmallIncrement) } }
                default { throw [XControlException]::new('INTERNAL', "direction 必须是 up/down/left/right，收到 $($req.direction)") }
            }
            Out-Result @{ used = 'ScrollPattern' }
        }
        default {
            Out-Fail 'INTERNAL' "未知命令 $($req.command)"
        }
    }
} catch [XControlException] {
    Out-Fail $_.Exception.Code $_.Exception.Message
} catch {
    Out-Fail 'INTERNAL' ($_.Exception.Message)
}
