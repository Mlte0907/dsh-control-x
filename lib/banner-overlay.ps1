<#
  dsh-control-x desktop banner overlay (native Windows always-on-top window).

  Launched by lib/banner-win.js with -StatePath pointing at a JSON file:
    { "active": true, "kind": "desktop", "tool": "x_desktop_value",
      "text": "<localized text>", "bg": "#23242a", "fg": "#eeeeee" }

  DESIGN NOTES (each one is a real trap, not decoration):
  - The whole script is deliberately ASCII-only. Windows PowerShell 5.1 reads .ps1
    as ANSI unless the file carries a UTF-8 BOM; a non-BOM file with CJK literals
    is mis-decoded and fails to PARSE ("unexpected token '}'"). The localized
    banner text arrives through the JSON state file, so this script never needs it.
  - WS_EX_TRANSPARENT (click-through) is mandatory: an always-on-top window that
    eats clicks would make the user's own desktop unusable.
  - WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW: never steal focus, never show in Alt+Tab.
  - SetProcessDPIAware: without it PowerShell is DPI-unaware and text is blurry
    on high-DPI screens.
  - Theme colors can only come from outside: the --dsw-alias-* CSS custom
    properties exist only in the web render layer, so the client resolves them
    and the Node side writes them into the state file.
#>
param(
  [Parameter(Mandatory = $true)][string]$StatePath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CxBannerNative {
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

[void][CxBannerNative]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Base    = ''
$script:Bg      = [System.Drawing.Color]::FromArgb(35, 36, 42)
$script:Fg      = [System.Drawing.Color]::FromArgb(238, 238, 238)
$script:Visible = $false
$script:LastDot = $null

# Status dot cycles red -> amber -> blue, one colour every 2s (user spec 2026-10-01).
# Phase is taken off the wall clock, so switches land on whole seconds instead of
# jittering with the frame rate.
$script:DotColors  = @(
  [System.Drawing.Color]::FromArgb(239, 68, 68),
  [System.Drawing.Color]::FromArgb(234, 179, 8),
  [System.Drawing.Color]::FromArgb(59, 130, 246)
)
$script:DotCycleMs = 2000
# Opacity while the banner is up. At startup it is forced to 0 first; see the
# comment next to Application.Run() for why.
$script:FadeOpacity = 0.82

function Get-CxDotColor() {
  $elapsed = [int]((Get-Date -UFormat %s)) * 1000 + [int]((Get-Date).Millisecond)
  $idx = [int][math]::Floor(($elapsed / $script:DotCycleMs)) % $script:DotColors.Length
  return $script:DotColors[$idx]
}

# Accept only #RGB / #RRGGBB / #AARRGGBB. Anything else keeps the default instead of
# throwing: a bad color from outside must not be able to kill the overlay, because
# a dead overlay is exactly the "silent no notification" we are trying to fix.
function Convert-CxColor([string]$value, [System.Drawing.Color]$fallback) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $fallback }
  try {
    $c = [System.Drawing.ColorTranslator]::FromHtml($value)
    return $c
  } catch { return $fallback }
}

$font    = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$padX    = 18
$dotSize = 9
$gap     = 11
$height  = 40

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar  = $false
$form.StartPosition  = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor      = $script:Bg
$form.Text           = 'dsh-control-x-banner'
$form.Name           = 'dsh-control-x-banner'
$form.Size           = New-Object System.Drawing.Size(420, $height)
$form.Opacity        = $script:FadeOpacity

$form.Add_Shown({
  $h = $form.Handle
  $style = [CxBannerNative]::GetWindowLong($h, [CxBannerNative]::GWL_EXSTYLE)
  [void][CxBannerNative]::SetWindowLong($h, [CxBannerNative]::GWL_EXSTYLE, (
    $style -bor [CxBannerNative]::WS_EX_LAYERED -bor [CxBannerNative]::WS_EX_TRANSPARENT `
          -bor [CxBannerNative]::WS_EX_NOACTIVATE -bor [CxBannerNative]::WS_EX_TOOLWINDOW))
  [void][CxBannerNative]::SetWindowPos($h, [CxBannerNative]::HWND_TOPMOST, 0, 0, 0, 0,
    [CxBannerNative]::SWP_NOMOVE -bor [CxBannerNative]::SWP_NOSIZE `
    -bor [CxBannerNative]::SWP_NOACTIVATE -bor [CxBannerNative]::SWP_SHOWWINDOW)
})

function New-CxRoundedRegion([int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 128, 128, 128)), 1
  $g.DrawRectangle($border, 1, 1, $form.Width - 3, $form.Height - 3)

  $cy = [int](($form.Height - $dotSize) / 2)
  $brush = New-Object System.Drawing.SolidBrush (Get-CxDotColor)
  $g.FillEllipse($brush, $padX, $cy, $dotSize, $dotSize)
  $brush.Dispose()

  # No typing animation and no blinking caret (user spec 2026-10-02: "remove the
  # typing effect"; the caret blinked at 1.25 Hz and read as the banner flickering).
  # The only animation left is the status dot's red/amber/blue cycle.
  $text = $script:Base
  $size = [System.Windows.Forms.TextRenderer]::MeasureText($g, $text, $font)
  $tx = $padX + $dotSize + $gap
  $ty = [int](($form.Height - $size.Height) / 2)
  [System.Windows.Forms.TextRenderer]::DrawText($g, $text, $font, (New-Object System.Drawing.Point($tx, $ty)), $script:Fg)
  $border.Dispose()
})

function Set-CxGeometry {
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $measure = $script:Base
  if ($measure.Length -gt 40) { $measure = $measure.Substring(0, 40) }
  $bmp = New-Object System.Drawing.Bitmap 8, 8
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $size = [System.Windows.Forms.TextRenderer]::MeasureText($g, $measure, $font)
  $g.Dispose(); $bmp.Dispose()
  $w = $padX * 2 + $dotSize + $gap + $size.Width + 18
  if ($w -lt 240) { $w = 240 }
  if ($w -gt 900) { $w = 900 }
  $locX = [int]($vs.Left + ($vs.Width - $w) / 2)
  $locY = [int]($vs.Top + 18)
  # Only assign when the value actually changed. Assigning Size or Region forces
  # Windows to rebuild and repaint the whole window, and the tick calls this ~11
  # times a second -- so an unconditional assignment made the banner blank out
  # every frame or two (measured: content present in only 163/200 samples while
  # IsWindowVisible never changed, i.e. the whole content layer was intermittently
  # not painted). Idempotent assignment is the whole fix.
  if ($form.Width -ne $w -or $form.Height -ne $height) {
    $form.Size = New-Object System.Drawing.Size -ArgumentList $w, $height
    $form.Region = New-CxRoundedRegion $w $height 8
  }
  if ($form.Left -ne $locX -or $form.Top -ne $locY) {
    $form.Location = New-Object System.Drawing.Point -ArgumentList $locX, $locY
  }
  } catch {
    throw
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80

# Read the state file once. Shared by the tick and the pre-Show pass below so the
# two cannot drift apart.
function Read-CxState() {
  try {
    if (Test-Path -LiteralPath $StatePath) {
      $raw = [System.IO.File]::ReadAllText($StatePath)
      if (-not [string]::IsNullOrWhiteSpace($raw)) { return ($raw | ConvertFrom-Json) }
    }
  } catch { return $null }
  return $null
}

$timer.Add_Tick({
  # One bad frame must never cost us the banner: every stage is isolated so a
  # geometry failure cannot stall the show/hide state.
  try {
    $state = Read-CxState

    $wantVisible = $false
    if ($null -ne $state -and $state.active -eq $true) {
      $wantVisible = $true
      $bg = Convert-CxColor $state.bg $script:Bg
      $fg = Convert-CxColor $state.fg $script:Fg
      if ($bg -ne $script:Bg) { $script:Bg = $bg; $form.BackColor = $bg }
      if ($fg -ne $script:Fg) { $script:Fg = $fg }
      $base = [string]$state.text
      if ($base -ne $script:Base) {
        $script:Base = $base
        try { Set-CxGeometry } catch { }
      }
    }
    if ($wantVisible) { try { Set-CxGeometry } catch { } }

    # Drive visibility from the form's ACTUAL state, not from a cached flag.
    # Application.Run($form) shows the form itself, which undid the explicit
    # Hide() that used to precede it; a cached flag started at $false therefore
    # agreed with itself and never issued the Hide(), leaving an empty box
    # pinned at (0,0) on screen from startup until the next real transition.
    if ($wantVisible) {
      # Opacity is 0 until the very first decision to show, so the frame that
      # Application.Run() forces onto the screen can never be the wrong one.
      if ($form.Opacity -ne $script:FadeOpacity) { $form.Opacity = $script:FadeOpacity }
      if (-not $form.Visible) { $form.Show() }
    } else {
      if ($form.Visible) { $form.Hide() }
    }
    $script:Visible = $wantVisible
    # The only thing that still has to repaint every frame is the status dot's
    # colour cycle. When it is off (inactive, or the cycle is settled) there is
    # nothing to redraw, so skip Invalidate entirely -- a needless repaint is how
    # the content layer used to blink.
    if ($script:Visible) {
      $now = Get-CxDotColor
      if ($now -ne $script:LastDot) { $script:LastDot = $now; $form.Invalidate() }
    }
  } catch {
    # Deliberately silent: a bad frame must not kill the overlay, and there is no
    # one to read a console here. The next tick retries from a clean slate.
  }
})

# Application.Run($form) shows the form by itself, at whatever Size/Location the
# form happens to have, which is the constructor default (0,0 / 420x40). That is
# the top-left flash users reported: the window appears in the corner, then the
# first tick drags it to the centre. So before we ever Run, we read the state and
# compute the real geometry, and we start fully transparent. The first visible
# frame is then already in the right place at the right size.
$pre = Read-CxState
if ($null -ne $pre -and $pre.active -eq $true) {
  $script:Base = [string]$pre.text
  $bg = Convert-CxColor $pre.bg $script:Bg
  $fg = Convert-CxColor $pre.fg $script:Fg
  $script:Bg = $bg
  $script:Fg = $fg
  $form.BackColor = $bg
}
$form.Opacity = 0
try { Set-CxGeometry } catch { }

# A WinForms Timer is created INACTIVE; without an explicit Start() its Tick never
# runs. The first tick must land almost immediately: it is the thing that decides
# show-vs-hide for the frame Run just forced onto the screen.
$timer.Interval = 16
$timer.Start()
[System.Windows.Forms.Application]::Run($form)