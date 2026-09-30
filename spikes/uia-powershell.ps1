# Spike：PowerShell + .NET System.Windows.Automation 读取 UIA 树（纯只读）。
# 目的：为"桌面观察"路线②（.NET UIA helper）取得可行性证据：
#   1) 本机 PowerShell 能否加载 UIAutomationClient；
#   2) 能否枚举顶层窗口；
#   3) 能否取到窗口内控件树（role/name/enabled）；
#   4) 耗时（决定 helper 常驻还是按调用拉起）。
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCond)

"== top-level windows ($($windows.Count)) =="
$target = $null
foreach ($w in $windows) {
    $c = $w.Current
    "  [{0}] {1} | pid={2} class={3}" -f $c.NativeWindowHandle, $c.Name, $c.ProcessId, $c.ClassName
    if (-not $target -and $c.Name -and $c.Name -notmatch 'Program Manager|Windows Input Experience|Settings') {
        $target = $w
    }
}

if ($target) {
    $t = $target.Current
    "== control tree of '{0}' (depth<=3, max 40) ==" -f $t.Name
    $all = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $n = 0
    foreach ($el in $all) {
        if ($n -ge 40) { "  ... (truncated, total $($all.Count))"; break }
        $e = $el.Current
        "  {0} | name='{1}' enabled={2}" -f $e.ControlType.ProgrammaticName, $e.Name, $e.IsEnabled
        $n++
    }
    "tree total elements: $($all.Count)"
}
$sw.Stop()
"elapsed: $($sw.ElapsedMilliseconds) ms"
