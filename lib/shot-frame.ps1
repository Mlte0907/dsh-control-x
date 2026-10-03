<#
  dsh-control-x shot frame flash (transient outline around the captured window).

  Launched by lib/shot-frame.js with -X/-Y/-W/-H = the exact window rect that was
  just screenshotted. It draws a 4px frame **outside** that rect and fades out.

  DESIGN NOTES (each one is a real trap, not decoration):
  - ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the
    file has a UTF-8 BOM, and a non-BOM file with CJK literals fails to PARSE.
    The repo has a parser gate over every lib/*.ps1 (tests/ps-scripts.test.mjs).
  - The frame is expanded outward (-Border), so it can never land inside the
    captured pixels even if this process paints while BitBlt is still running.
  - Ring region (outer rect XOR inner rect): only the border is painted, the
    interior stays see-through. No TransparencyKey layering needed, and the
    user's desktop is never covered.
  - WS_EX_TRANSPARENT is mandatory: an overlay that eats clicks would make the
    user's own desktop unusable while it is up.
  - WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW: never steal focus, never show in Alt+Tab.
  - SetProcessDPIAware: without it PowerShell is DPI-unaware and the rect would be
    scaled by the DPI virtualization (frame lands at the wrong size/position).
  - Hard lifetime: whatever happens, this process exits. A leaked overlay pinned
    to the desktop is worse than no hint at all.
#>
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [int]$Ms = 350,
  [int]$Border = 4,
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

if ($W -lt 2 -or $H -lt 2) { exit 0 }
if ($Ms -lt 80)  { $Ms = 80 }
if ($Ms -gt 2000) { $Ms = 2000 }
if ($Border -lt 1) { $Border = 1 }

# Outward expansion: the frame must never overlap the captured pixels.
$script:Left   = $X - $Border
$script:Top    = $Y - $Border
$script:Width  = $W + ($Border * 2)
$script:Height = $H + ($Border * 2)
$script:Ms     = $Ms
$script:MaxOpacity = 0.95

try { $frameColor = [System.Drawing.ColorTranslator]::FromHtml($Color) }
catch { $frameColor = [System.Drawing.Color]::FromArgb(74, 125, 255) }

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

# Ring region: outer rect XOR inner rect (GraphicsPath defaults to FillMode.Alternate),
# so only the border band is drawn and the middle stays fully transparent.
#
# The inner size MUST be computed into variables first (hit for real on 2026-10-03):
#   `New-Object Type($a, $b - $c, ...)` parses the parentheses as an ARGUMENT ARRAY,
#   so the `-` is resolved against [System.Object[]] and throws at runtime:
#     "Cannot invoke ... because [System.Object[]] does not contain a method named
#      'op_Subtraction'"
# Probe reproduction: the arithmetic form fails, the precomputed-variable form works.
# The official-Parser gate (tests/ps-scripts.test.mjs) stays green through this, which is
# why tests/shot-frame.test.mjs also runs this script for real and demands exit 0.
$innerW = $script:Width - ($Border * 2)
$innerH = $script:Height - ($Border * 2)
$ring = New-Object System.Drawing.Drawing2D.GraphicsPath
$ring.AddRectangle((New-Object System.Drawing.Rectangle(0, 0, $script:Width, $script:Height)))
$ring.AddRectangle((New-Object System.Drawing.Rectangle($Border, $Border, $innerW, $innerH)))
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

# Fade out, then close. The tick is also the hard lifetime cap: no state can keep
# this overlay pinned to the desktop (a stuck frame would be worse than none).
$script:Deadline = [DateTime]::UtcNow.AddMilliseconds($script:Ms)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.Add_Tick({
  $remain = ($script:Deadline - [DateTime]::UtcNow).TotalMilliseconds
  if ($remain -le 0) {
    $timer.Stop()
    $form.Close()
    return
  }
  $ratio = [double]($remain / [double]$script:Ms)
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
