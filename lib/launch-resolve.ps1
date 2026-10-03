<#
 * x_desktop_launch 的名字解析门（2026-10-04 加）。
 *
 * 为什么：0.5.32 的四个会话（四个不同模型）**全部**在第一步撞上同一个错——
 *     x_desktop_launch {"target":"豆包"} → Error: The system cannot find the file specified
 *   四家各自自救，各烧 1~3 步、约 30~60 秒：
 *     MiniMax-M3        → 改 target:"Doubao"（进程名）
 *     space-bunny-free  → Start Menu 的 "...\Start Menu\Programs\豆包.lnk"
 *     deepseek-flash    → 从 lnk 解析出 D:\doubao\Doubao.exe
 *     mimo-v2.6-flash   → C:\Users\sun_w\Desktop\豆包.lnk
 * 根因：helper 只拿 target 去 Start-Process，**不查开始菜单 / 桌面快捷方式 / App Paths / PATH**，
 * 对"已安装但没运行"的应用按中文名必失败。
 *
 * 解析顺序（Resolve-CxLaunchTarget）：
 *   1) target 本身是存在的路径
 *   2) 注入的搜索目录（测试用真实调用时不传 → 默认开始菜单两处 + 桌面两处）
 *      先按 <名>.lnk 精确匹配文件名，再按 **快捷方式指向的 exe 名** 匹配（"豆包" vs Doubao.exe）
 *   3) 注册表 App Paths（HKCU/HKLM + WOW6432Node）
 *   4) PATH（Get-Command）
 * 找不到返回 $null（调用方据此给出"已尝试过哪些地方"的可自救报错）。
 *
 * 单独成文件而不是写在 uia-helper.ps1 里：helper 是常驻 stdin 循环，没法被测试 dot-source；
 * 这个文件只定义函数，helper 用 `. (Join-Path $PSScriptRoot 'launch-resolve.ps1')` 引入。
 * 同时它是 .ps1 → 自动进 ps-scripts 的 Parser 门与编码门。
 #>

function Resolve-CxLaunchTarget {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    # 测试可注入"开始菜单/桌面"目录；不传时用本机真实位置。
    [string[]]$SearchDirs = @(),
    [switch]$NoRegistry,
    [switch]$NoPath
  )
  $t = ("$Target").Trim()
  if ($t -eq '') { return $null }

  # 1) 它自己就是一个存在的路径（绝对/相对/带扩展名的文件）
  try {
    if (Test-Path -LiteralPath $t) { return (Resolve-Path -LiteralPath $t).Path }
  } catch { }

  $leaf = $t
  try { $leaf = [System.IO.Path]::GetFileName($t) } catch { }
  $base = $leaf
  try { $base = [System.IO.Path]::GetFileNameWithoutExtension($leaf) } catch { }
  if ($base -eq '') { $base = $leaf }
  $baseL = $base.ToLower()

  # 2) 快捷方式搜索（开始菜单用户/公共 + 桌面用户/公共）
  if ($SearchDirs.Count -eq 0) {
    $SearchDirs = @(
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
      (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
      (Join-Path $env:USERPROFILE 'Desktop'),
      (Join-Path $env:PUBLIC 'Desktop')
    )
  }
  $lnks = @()
  foreach ($dir in $SearchDirs) {
    try {
      if ($dir -and (Test-Path -LiteralPath $dir)) {
        $lnks += Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
      }
    } catch { }
  }
  if ($lnks.Count -gt 0) {
    # 2a) 快捷方式文件名精确匹配（忽略大小写、忽略 .lnk / .exe 后缀）
    $byName = $lnks | Where-Object {
      $n = [System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLower()
      ($n -eq $baseL) -or ($n -eq ($baseL + '.exe'))
    } | Select-Object -First 1
    if ($byName) { return $byName.FullName }

    # 2b) 按**快捷方式指向的目标 exe 名**匹配——"Doubao" 这种进程名也该能启动
    #     （真机 MiniMax-M3 就是靠改 target 为 Doubao 才成功的）
    try {
      $sh = New-Object -ComObject WScript.Shell
      foreach ($lnk in $lnks) {
        try {
          $tp = '' + $sh.CreateShortcut($lnk.FullName).TargetPath
          if ($tp -eq '') { continue }
          $tb = [System.IO.Path]::GetFileNameWithoutExtension($tp).ToLower()
          if ($tb -eq $baseL) { return $lnk.FullName }
        } catch { }
      }
    } catch { }
  }

  # 3) 注册表 App Paths（应用名 → exe 全路径的经典登记处）
  if (-not $NoRegistry) {
    $roots = @(
      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
    )
    $exeName = $baseL
    if (-not $exeName.EndsWith('.exe')) { $exeName = $exeName + '.exe' }
    foreach ($root in $roots) {
      try {
        $key = Get-Item -LiteralPath (Join-Path $root $exeName) -ErrorAction Stop
        $val = $key.GetValue('')
        if ($val -and (Test-Path -LiteralPath $val)) { return $val }
      } catch { }
    }
  }

  # 4) PATH
  if (-not $NoPath) {
    try {
      $cmd = Get-Command -Name $leaf -CommandType Application -ErrorAction Stop | Select-Object -First 1
      if ($cmd -and $cmd.Source) { return $cmd.Source }
    } catch { }
    # 无扩展名时再按 exe 试一次（Get-Command 对 "foo" 常能补 .exe，但 "foo.exe" 更稳）
    try {
      $cmd = Get-Command -Name ($leaf + '.exe') -CommandType Application -ErrorAction Stop | Select-Object -First 1
      if ($cmd -and $cmd.Source) { return $cmd.Source }
    } catch { }
  }

  return $null
}
