<#
  dsh-control-x point marker (a short ripple ring at the exact click point).

  Launched by lib/shot-frame.js createPointMarker() with -X/-Y = the **screen**
  coordinates that were just clicked (x_desktop_click_at's clickedAt.screenX/Y).

  WHY (borrowed, deliberately narrowed): the user pointed at UI-TARS-desktop's
  setOfMarks overlay, which paints a 250x100 red dashed *rotating* circle plus a
  center dot and a text label (click / Typing: "..." / Hotkey: ctrl + c), auto-closed
  after max 5s. We borrow ONLY the idea "mark the exact point that was acted on":
    - no text label (the user's standing rule about the banner is "do not add more
      words" -- this is the same class of decoration);
    - no rotating dashed SVG animation (Electron renders SVG for free; WinForms
      would need per-frame painting for that). Instead: a ring that expands from
      10px to 26px while fading out -- a ripple, which reads as "clicked here".

  Same discipline as shot-frame.ps1 (each line is a real trap, not decoration):
  - UTF-8 BOM or ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI without a
    BOM; tests/ps-scripts.test.mjs gates it and runs the official Parser.
  - NEVER put arithmetic inside `New-Object Type(...)` parens: PowerShell parses
    that list as an ARGUMENT ARRAY, so `$a - $b` resolves against [System.Object[]]
    and throws ("no method named op_Subtraction"). The Parser gate stays green
    through that, which is why tests/shot-frame.test.mjs runs this script for real
    and demands exit 0.
  - Ring region = outer ellipse XOR inner ellipse (FillMode.Alternate): only the
    band is painted, the middle stays see-through.
  - WS_EX_TRANSPARENT: an overlay that eats clicks makes the desktop unusable.
  - WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW: never steal focus, never show in Alt+Tab.
  - SetProcessDPIAware: without it the point would be scaled by DPI virtualization.
  - Hard lifetime: whatever happens, this process exits.
#>
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$Ms = 600,
  [int]$From = 10,
  [int]$To = 26,
  [int]$Thickness = 3,
  [string]$Color = '#ef4444'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CxMarkerNative {
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

[void][CxMarkerNative]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

if ($Ms -lt 120)   { $Ms = 120 }
if ($Ms -gt 3000)  { $Ms = 3000 }
if ($From -lt 2)   { $From = 2 }
if ($To -lt $From) { $To = $From }
if ($Thickness -lt 1) { $Thickness = 1 }

# The box is sized for the FINAL radius; the ring grows inside it as the ripple.
$half = [int][math]::Ceiling(($To + $Thickness) / 2) + 2
$script:Size   = ($half * 2)
$script:Left   = $X - $half
$script:Top    = $Y - $half
$script:Center = $half
$script:From   = $From
$script:To     = $To
$script:Thick  = $Thickness
$script:Ms     = $Ms
$script:MaxOpacity = 0.85
$script:Started = [DateTime]::UtcNow

try { $frameColor = [System.Drawing.ColorTranslator]::FromHtml($Color) }
catch { $frameColor = [System.Drawing.Color]::FromArgb(239, 68, 68) }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar  = $false
$form.StartPosition  = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location       = New-Object System.Drawing.Point($script:Left, $script:Top)
$form.Size           = New-Object System.Drawing.Size($script:Size, $script:Size)
$form.BackColor      = $frameColor
$form.Opacity        = $script:MaxOpacity
$form.Text           = 'dsh-control-x-point-marker'
$form.Name           = 'dsh-control-x-point-marker'

$form.Add_Shown({
  $h = $form.Handle
  $style = [CxMarkerNative]::GetWindowLong($h, [CxMarkerNative]::GWL_EXSTYLE)
  [void][CxMarkerNative]::SetWindowLong($h, [CxMarkerNative]::GWL_EXSTYLE, (
    $style -bor [CxMarkerNative]::WS_EX_LAYERED -bor [CxMarkerNative]::WS_EX_TRANSPARENT `
          -bor [CxMarkerNative]::WS_EX_NOACTIVATE -bor [CxMarkerNative]::WS_EX_TOOLWINDOW))
  [void][CxMarkerNative]::SetWindowPos($h, [CxMarkerNative]::HWND_TOPMOST, 0, 0, 0, 0,
    [CxMarkerNative]::SWP_NOMOVE -bor [CxMarkerNative]::SWP_NOSIZE `
    -bor [CxMarkerNative]::SWP_NOACTIVATE -bor [CxMarkerNative]::SWP_SHOWWINDOW)
})

# Ring region for radius r centered in the box: ellipse XOR ellipse (Alternate fill).
function Set-CxRing([int]$r) {
  $inner = $r - $script:Thick
  $outerBox = New-Object System.Drawing.Rectangle(0, 0, $script:Size, $script:Size)
  $ox = $script:Center - $r
  $oy = $ox
  $od = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $outer = New-Object System.Drawing.Rectangle($ox, $oy, $od, $od)
  $path.AddEllipse($outer)
  if ($inner -gt 0) {
    $ix = $script:Center - $inner
    $iy = $ix
    $id = $inner * 2
    $innerBox = New-Object System.Drawing.Rectangle($ix, $iy, $id, $id)
    $path.AddEllipse($innerBox)
  }
  $region = New-Object System.Drawing.Region($path)
  $old = $form.Region
  $form.Region = $region
  if ($null -ne $old) { $old.Dispose() }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 25
$timer.Add_Tick({
  $elapsed = ([DateTime]::UtcNow - $script:Started).TotalMilliseconds
  if ($elapsed -ge $script:Ms) {
    $timer.Stop()
    $form.Close()
    return
  }
  $p = [double]($elapsed / [double]$script:Ms)
  $r = [int]($script:From + (($script:To - $script:From) * $p))
  if ($r -lt 1) { $r = 1 }
  Set-CxRing $r
  $form.Opacity = [double][math]::Max(0.0, $script:MaxOpacity * (1.0 - $p))
})
Set-CxRing $script:From
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($form)
} finally {
  $timer.Stop()
  $timer.Dispose()
  $form.Dispose()
}
exit 0
