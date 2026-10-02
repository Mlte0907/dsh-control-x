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
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace XNative -Name Foreground -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'

# 窗口级截图（2026-10-03）。PrintWindow 让目标窗口自己把内容画进我们给的 DC，
# 因此**不受遮挡影响**——实测 DSH（Electron）在后台被别的窗口压着时仍取到完整画面
# （1965x1106、102 种颜色、0% 近黑）。这比抓屏幕矩形（CopyFromScreen）强：后者被遮挡
# 时拍到的是遮挡物。
#
# 为什么需要它：Electron/Chromium 应用默认不对外物化 UIA 树（DSH 实测只有 13 个元素、
# 4 个有名字），语义动作 x_desktop_press/value/scroll 全都用不了。此时"看图 + 坐标点击"
# 是唯一不越界的兜底路径——对应 ZCode 的 strategy:auto（优先 a11y，回落 event/坐标）。
#
# ⚠️ 下面这个 C# 块**必须纯 ASCII**（注释也用英文）。原因：Add-Type 会把 here-string
# 写成临时 .cs 再交给编译器，那一步按 ANSI 解码——中文注释的字节会被当成代码，
# 报"无效的表达式项"（2026-10-03 实测踩过）。lib/banner-overlay.ps1 早已刻意纯 ASCII
# 规避同一类坑，这里保持一致。中文说明放在本段 PS 注释里。
$src = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
namespace XNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public class Shot {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    // Returns JPEG bytes, or null when the window cannot be captured.
    public static byte[] Capture(int hwndInt, int maxEdge, int quality) {
      RECT r;
      if (!GetWindowRect(new IntPtr(hwndInt), out r)) return null;
      int w = r.R - r.L, h = r.B - r.T;
      if (w <= 0 || h <= 0) return null;
      // Downscale huge windows so one 4K desktop shot cannot eat the context.
      int scale = 1;
      int longEdge = (w > h) ? w : h;
      if (longEdge > maxEdge) scale = (int)Math.Ceiling(longEdge / (double)maxEdge);
      Bitmap bmp;
      using (var full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(full)) {
          IntPtr hdc = g.GetHdc();
          bool ok = PrintWindow(new IntPtr(hwndInt), hdc, 2);   // 2 = PW_RENDERFULLCONTENT
          g.ReleaseHdc(hdc);
          if (!ok) return null;
        }
        // Near-black guard: Electron can hand back an all-black frame. That is
        // "no picture", not "a black app", and the two must not be conflated.
        long black = 0, n = 0;
        for (int y = 0; y < h; y += 11) {
          for (int x = 0; x < w; x += 11) {
            Color c = full.GetPixel(x, y);
            int lum = (c.R * 299 + c.G * 587 + c.B * 114) / 1000;
            if (lum < 8) black++;
            n++;
          }
        }
        if (n > 0 && black * 100 / n > 92) return null;
        if (scale <= 1) {
          bmp = new Bitmap(full);
        } else {
          bmp = new Bitmap(Math.Max(1, w / scale), Math.Max(1, h / scale));
          using (var g2 = Graphics.FromImage(bmp)) {
            g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g2.DrawImage(full, 0, 0, bmp.Width, bmp.Height);
          }
        }
      }
      try {
        using (var ms = new System.IO.MemoryStream()) {
          foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) {
            if (c.FormatID != System.Drawing.Imaging.ImageFormat.Jpeg.Guid) continue;
            var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            bmp.Save(ms, c, p);
            break;
          }
          byte[] bytes = ms.ToArray();
          return bytes.Length > 0 ? bytes : null;
        }
      } finally { bmp.Dispose(); }
    }
    public static int RectW(int hwndInt) { RECT r; return GetWindowRect(new IntPtr(hwndInt), out r) ? (r.R - r.L) : 0; }
    public static int RectH(int hwndInt) { RECT r; return GetWindowRect(new IntPtr(hwndInt), out r) ? (r.B - r.T) : 0; }
    public static int RectX(int hwndInt) { RECT r; return GetWindowRect(new IntPtr(hwndInt), out r) ? r.L : 0; }
    public static int RectY(int hwndInt) { RECT r; return GetWindowRect(new IntPtr(hwndInt), out r) ? r.T : 0; }
  }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Drawing'

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

function Find-ByRuntimeId($window, $runtimeId, $expect) {
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $want = ($runtimeId -join '.')
    $el = $null
    foreach ($e in $all) {
        try {
            if ((($e.GetRuntimeId()) -join '.') -eq $want) { $el = $e; break }
        } catch { continue }  # 元素已消失：跳过，最终按未命中处理
    }
    if ($null -eq $el) { return $null }
    # 身份核对（TTL 软化的安全边界）：RuntimeId 理论上可被复用，动作前必须确认
    # 当前元素的 角色+名称 与观察时一致，防止对错位元素执行动作。
    if ($null -ne $expect) {
        try {
            $gotRole = Get-RoleName $el
            $gotName = $el.Current.Name
            if ($gotRole -ne $expect.role -or $gotName -ne $expect.name) {
                throw [XControlException]::new('STALE_STATE',
                    "元素身份已变化：观察时是 $($expect.role) 「$($expect.name)」，现在同一 RuntimeId 是 $gotRole 「$gotName」。界面已更新——请重新 x_desktop_tree，不要对错位元素执行动作。")
            }
        } catch [XControlException] {
            throw
        } catch {
            throw [XControlException]::new('STALE_STATE', '元素身份无法读取（可能已消失）。请重新 x_desktop_tree。')
        }
    }
    return $el
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
            $el = Find-ByRuntimeId $win @($req.runtimeId) $req.expect
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素在当前窗口树中不存在。请重新调用 x_desktop_tree。') }
            $used = Invoke-PatternAction $el $req.action
            $nc = $win.Current
            Out-Result @{ used = $used; window = @{ pid = $nc.ProcessId; title = $nc.Name; hwnd = [int64]$nc.NativeWindowHandle } }
        }
        'set_value' {
            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId) $req.expect
            if ($null -eq $el) { throw [XControlException]::new('ELEMENT_UNAVAILABLE', '观察快照已失效：元素在当前窗口树中不存在。请重新调用 x_desktop_tree。') }
            if ($el.Current.IsPassword) {
                throw [XControlException]::new('NOT_SETTABLE', '敏感输入保护：密码框拒绝自动写入——密码必须由用户本人输入。')
            }
            $vp = $null
            try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
            if ($null -eq $vp) {
                # contenteditable（通告里只有 Text 等读写模式）没有 UIA 写入通道：给出可行路径而不是死路。
                # 注意 throw 必须单行：PS 5.1 方法调用参数列表内换行 = 参数列表结束（0.5.14 血泪，parse-guard 测试钉死）。
                throw [XControlException]::new('NOT_SETTABLE', "元素不支持 ValuePattern（通告：$((Get-PatternNames $el) -join ', ')）。富文本/contenteditable 输入框的写入通道是物理输入：x_desktop_type（Unicode）或剪贴板（Set-Clipboard 后 x_desktop_key ctrl+v）。")
            }
            $vp.SetValue([string]$req.value)
            $nc = $win.Current
            Out-Result @{ used = 'ValuePattern'; window = @{ pid = $nc.ProcessId; title = $nc.Name; hwnd = [int64]$nc.NativeWindowHandle } }
        }
        'rect' {
            # 物理点击路径的前置取证：元素矩形 + 窗口是否前台。
            # 本命令只读；真正的前置与点击由 Node 侧的显式打扰门控执行（§6.7-4）。
            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId) $req.expect
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
        'window_rect' {
            # 纯坐标动作（x_desktop_click_at）的前置取证：窗口矩形 + 是否前台。
            # 只读；不解析任何元素——这正是它在树空掉时唯一可用的原因。
            $win = Resolve-Window $req
            $hwnd = [int64]$win.Current.NativeWindowHandle
            $fg = [XNative.Foreground]::GetForegroundWindow()
            Out-Result @{
                window = @{
                    pid = $win.Current.ProcessId; title = $win.Current.Name
                    hwnd = $hwnd
                    x = [XNative.Shot]::RectX([int]$hwnd); y = [XNative.Shot]::RectY([int]$hwnd)
                    width = [XNative.Shot]::RectW([int]$hwnd); height = [XNative.Shot]::RectH([int]$hwnd)
                    foreground = ($fg -eq [System.IntPtr]$hwnd)
                }
            }
        }
        'window_shot' {
            # 窗口级截图（x_desktop_shot）。PrintWindow 让窗口自己画，不受遮挡影响。
            $win = Resolve-Window $req
            $nc = $win.Current
            $hwnd = [int64]$nc.NativeWindowHandle
            $maxEdge = 1280
            if ($null -ne $req.maxEdge) { $maxEdge = [int]$req.maxEdge }
            $quality = 70
            if ($null -ne $req.quality) { $quality = [int]$req.quality }
            $bytes = [XNative.Shot]::Capture([int]$hwnd, $maxEdge, $quality)
            if ($null -eq $bytes) {
                throw [XControlException]::new('STALE_STATE', '窗口截图失败：PrintWindow 返回空，或画面几乎全黑（该窗口可能最小化、离屏、或渲染进程未就绪）。请确认窗口可见后重试；不要据此假设界面为空。')
            }
            $fg = [XNative.Foreground]::GetForegroundWindow()
            Out-Result @{
                imageBase64 = [Convert]::ToBase64String($bytes)
                bytes = $bytes.Length
                window = @{
                    pid = $nc.ProcessId; title = $nc.Name; hwnd = $hwnd
                    x = [XNative.Shot]::RectX([int]$hwnd); y = [XNative.Shot]::RectY([int]$hwnd)
                    width = [XNative.Shot]::RectW([int]$hwnd); height = [XNative.Shot]::RectH([int]$hwnd)
                    foreground = ($fg -eq [System.IntPtr]$hwnd)
                }
            }
        }
        'scroll' {            $win = Resolve-Window $req
            $el = Find-ByRuntimeId $win @($req.runtimeId) $req.expect
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
        'launch' {
            # 启动应用并轮询定位真实顶层窗口（单次 spawn 内完成）。
            # 2026-10-02 飞书实测：Start-Process -PassThru 的 pid 可能只是启动器，
            # 真实窗口在另一个 pid——用「启动前 hwnd 快照 → 新窗口 → 进程名兜底」定位。
            $before = @{}
            try {
                foreach ($w in (Get-TopWindows)) { $before[[string]$w.hwnd] = $true }
            } catch { }
            $targetPath = '' + $req.target
            if ($targetPath.ToLower().EndsWith('.lnk')) {
                try {
                    $shLocal = New-Object -ComObject WScript.Shell
                    $tl = $shLocal.CreateShortcut($targetPath)
                    if ($tl.TargetPath) { $targetPath = '' + $tl.TargetPath }
                } catch { }
            }
            $nameKey = ''
            try { $nameKey = [System.IO.Path]::GetFileNameWithoutExtension($targetPath).ToLower() } catch { }
            $p = if ($req.args) { Start-Process -FilePath $req.target -ArgumentList $req.args -PassThru }
                 else          { Start-Process -FilePath $req.target -PassThru }
            $launchPid = $p.Id
            $window = $null
            $matched = ''
            for ($i = 0; $i -lt 18 -and $null -eq $window; $i++) {
                Start-Sleep -Milliseconds 700
                try {
                    foreach ($w in (Get-TopWindows)) {
                        if ($before.ContainsKey([string]$w.hwnd)) { continue }
                        if ($w.title -and $w.title.Trim().Length -gt 0) {
                            $window = @{ pid = $w.pid; title = $w.title; className = $w.className; hwnd = $w.hwnd; processName = $w.processName }
                            $matched = 'new'
                            break
                        }
                    }
                } catch { }
            }
            if ($null -eq $window -and $nameKey) {
                # 没出现新窗口：应用可能已在运行（单实例把既有窗口提到前台），按进程名兜底。
                try {
                    foreach ($w in (Get-TopWindows)) {
                        if ($w.processName -and $w.processName.ToLower().Contains($nameKey) -and $w.title) {
                            $window = @{ pid = $w.pid; title = $w.title; className = $w.className; hwnd = $w.hwnd; processName = $w.processName }
                            $matched = 'existing'
                            break
                        }
                    }
                } catch { }
            }
            Out-Result @{ pid = $launchPid; window = $window; matched = $matched }
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
