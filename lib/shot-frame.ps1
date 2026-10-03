<#
  dsh-control-x shot frame flash (gentle outline around the captured window).

  Launched by lib/shot-frame.js with -X/-Y/-W/-H = the exact window rect that was
  just screenshotted. A 2px rounded frame is drawn INSIDE that rect, held briefly,
  then faded out.

  USER FEEDBACK (2026-10-04, first live run): "蓝了，然后好像比豆包的框大了一点，
  闪了一下，能更优雅一点么？温和一点。"  So this version:
    - no outward expansion (the old -4px outset was exactly the "bigger than the
      window" complaint) -- safe because the capture already finished before this
      process is spawned, so nothing here can leak into the screenshot;
    - 2px instead of 4px, 0.7 opacity instead of 0.95, rounded corners;
    - hold 120ms first, then fade over the rest (420ms total) instead of decaying
      from the very first frame, which read as a harsh "flash".

  DESIGN NOTES (each one is a real trap, not decoration):
  - This file carries a UTF-8 BOM: it quotes the user's Chinese feedback verbatim as
    evidence, and Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM, so
    CJK bytes get decoded as garbage and can even fabricate a stray hash-gt sequence
    that closes the header comment early (hit for real in lib/launch-resolve.ps1 on
    2026-10-04 -- and again HERE when this note itself spelled that sequence out).
    tests/ps-scripts.test.mjs gates "BOM or pure ASCII" for every lib/*.ps1 and also
    runs the official Parser over it.
  - NEVER put arithmetic inside `New-Object Type(...)` parens: PowerShell parses
    that list as an ARGUMENT ARRAY, so `$a - $b` is resolved against
    [System.Object[]] and throws at runtime ("no method named op_Subtraction").
    The official-Parser gate stays green through that, which is why
    tests/shot-frame.test.mjs runs this script for real and demands exit 0.
  - Ring region (outer rounded rect XOR inner rounded rect, FillMode.Alternate):
    only the border band is painted, the interior stays see-through. The user's
    desktop is never covered.
  - WS_EX_TRANSPARENT is mandatory: an overlay that eats clicks would make the
    user's own desktop unusable while it is up.
  - WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW: never steal focus, never show in Alt+Tab.
  - SetProcessDPIAware: without it PowerShell is DPI-unaware and the rect would be
    scaled by DPI virtualization (frame lands at the wrong size/position).
  - Hard lifetime: whatever happens, this process exits. A leaked overlay pinned
    to the desktop is worse than no hint at all.
#>
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [int]$Ms = 420,
  [int]$Hold = 120,
  [int]$Thickness = 2,
  [int]$Radius = 6,
  [string]$Color = '#4a7dff'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CxFrameNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_LAYERED     = 0x00080000;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_NOACTIVATE  = 0x08000000;
  public const int WS_EX_TOOLWINDOW  = 0x00000080;

  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
}
'@

[void][CxFrameNative]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

if ($W -lt 4 -or $H -lt 4) { exit 0 }
if ($Ms -lt 120)   { $Ms = 120 }
if ($Ms -gt 3000)  { $Ms = 3000 }
if ($Hold -lt 0)   { $Hold = 0 }
if ($Hold -ge $Ms) { $Hold = [int]($Ms / 3) }
if ($Thickness -lt 1) { $Thickness = 1 }
# 线宽不得超过半边，否则内圈塌成 0（高 <2*厚度 的细条尤其容易踩）。
$maxT = [int][math]::Floor([math]::Min($W, $H) / 2) - 1
if ($maxT -lt 1) { $maxT = 1 }
if ($Thickness -gt $maxT) { $Thickness = $maxT }
if ($Radius -lt 0) { $Radius = 0 }

# 贴合窗口：不再外扩（旧版 -Border 外扩 4px 正是"比窗口大了一点"的来源）。
$script:Left   = $X
$script:Top    = $Y
$script:Width  = $W
$script:Height = $H
$script:Ms     = $Ms
$script:HoldMs = $Hold
$script:MaxOpacity = 0.7
$script:Started = [DateTime]::UtcNow

try { $frameColor = [System.Drawing.ColorTranslator]::FromHtml($Color) }
catch { $frameColor = [System.Drawing.Color]::FromArgb(74, 125, 255) }

# 圆角矩形路径。算术一律先算进变量——New-Object 括号里的表达式会被当参数数组解析。
function New-CxRoundRect([int]$rx, [int]$ry, [int]$rw, [int]$rh, [int]$rr) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $rr * 2
  if ($rr -lt 1 -or $rw -lt $d -or $rh -lt $d) {
    $rect = New-Object System.Drawing.Rectangle($rx, $ry, $rw, $rh)
    $path.AddRectangle($rect)
    return $path
  }
  $right  = $rx + $rw - $d
  $bottom = $ry + $rh - $d
  $path.AddArc($rx, $ry, $d, $d, 180, 90)
  $path.AddArc($right, $ry, $d, $d, 270, 90)
  $path.AddArc($right, $bottom, $d, $d, 0, 90)
  $path.AddArc($rx, $bottom, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar  = $false
$form.StartPosition  = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location       = New-Object System.Drawing.Point($script:Left, $script:Top)
$form.Size           = New-Object System.Drawing.Size($script:Width, $script:Height)
$form.BackColor      = $frameColor
$form.Opacity        = $script:MaxOpacity
$form.Text           = 'dsh-control-x-shot-frame'
$form.Name           = 'dsh-control-x-shot-frame'

# Ring region: rounded outer XOR rounded inner -> only the border band is drawn and
# the middle stays fully transparent.
$innerW = $script:Width - ($Thickness * 2)
$innerH = $script:Height - ($Thickness * 2)
$innerRadius = $Radius - $Thickness
if ($innerRadius -lt 0) { $innerRadius = 0 }
$outerPath = New-CxRoundRect 0 0 $script:Width $script:Height $Radius
$innerPath = New-CxRoundRect $Thickness $Thickness $innerW $innerH $innerRadius
$ring = New-Object System.Drawing.Drawing2D.GraphicsPath
$ring.AddPath($outerPath, $false)
$ring.AddPath($innerPath, $false)
$form.Region = New-Object System.Drawing.Region($ring)

$form.Add_Shown({
  $h = $form.Handle
  $style = [CxFrameNative]::GetWindowLong($h, [CxFrameNative]::GWL_EXSTYLE)
  [void][CxFrameNative]::SetWindowLong($h, [CxFrameNative]::GWL_EXSTYLE, (
    $style -bor [CxFrameNative]::WS_EX_LAYERED -bor [CxFrameNative]::WS_EX_TRANSPARENT `
          -bor [CxFrameNative]::WS_EX_NOACTIVATE -bor [CxFrameNative]::WS_EX_TOOLWINDOW))
  [void][CxFrameNative]::SetWindowPos($h, [CxFrameNative]::HWND_TOPMOST, 0, 0, 0, 0,
    [CxFrameNative]::SWP_NOMOVE -bor [CxFrameNative]::SWP_NOSIZE `
    -bor [CxFrameNative]::SWP_NOACTIVATE -bor [CxFrameNative]::SWP_SHOWWINDOW)
})

# Hold at full opacity, then fade. The tick is also the hard lifetime cap: no state
# can keep this overlay pinned to the desktop (a stuck frame would be worse than none).
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
  $elapsed = ([DateTime]::UtcNow - $script:Started).TotalMilliseconds
  if ($elapsed -ge $script:Ms) {
    $timer.Stop()
    $form.Close()
    return
  }
  if ($elapsed -le $script:HoldMs) {
    $form.Opacity = $script:MaxOpacity
    return
  }
  $span = [double][math]::Max(1, $script:Ms - $script:HoldMs)
  $remain = [double]($script:Ms - $elapsed)
  $ratio = [double]($remain / $span)
  $form.Opacity = [double][math]::Max(0.0, [math]::Min($script:MaxOpacity, $ratio * $script:MaxOpacity))
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($form)
} finally {
  $timer.Stop()
  $timer.Dispose()
  $form.Dispose()
}
exit 0
