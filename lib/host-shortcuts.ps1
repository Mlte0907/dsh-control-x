param([string]$PayloadB64 = '')

# dsh-control-x 宿主无障碍旗标 helper（Windows PowerShell 5.1 兼容，与 uia-helper 同一套编码纪律）。
# 输入：base64(JSON)，JSON = { exe, dirs, action }。
#   exe    = 宿主可执行文件完整路径（大小写不敏感比较快捷方式的 TargetPath）
#   dirs   = 待扫描的快捷方式目录列表（递归找 *.lnk）
#   action = detect（只读）| patch（追加 --force-renderer-accessibility）| restore（移除该旗标）
# 输出：单行 __X_CONTROL_RESULT__{json}，shortcuts = [{path, target, args, patched}]。
# 纪律：只读写快捷方式的 Arguments 字段，绝不触碰目标程序本体；
# 这是插件唯一一处会写宿主启动配置的代码，且只在设置页用户显式点开关时被调用。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

$SENTINEL = '__X_CONTROL_RESULT__'
$FLAG = '--force-renderer-accessibility'

function Out-Result($obj) { Write-Output ($SENTINEL + ($obj | ConvertTo-Json -Depth 5 -Compress)) }

$result = @{ ok = $true; error = ''; exe = ''; action = ''; shortcuts = @(); errors = @() }
try {
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  $req = $json | ConvertFrom-Json
  $exeWanted = ('' + $req.exe).ToLower()
  $action = '' + $req.action
  $result.exe = $exeWanted
  $result.action = $action
  if (-not $exeWanted) {
    $result.ok = $false
    $result.error = '缺少 exe 路径'
  } else {
    $sh = New-Object -ComObject WScript.Shell
    $list = @()
    $errs = @()
    # 用 foreach 语句而非 ForEach-Object：语句共享当前作用域，数组逐元素 += 不会
    # 造出作用域影子副本（PS 5.1 数组坑，见 DSH-SDK-CONTRACT §11）。
    foreach ($dir in @($req.dirs)) {
      if (-not ($dir -and (Test-Path -LiteralPath $dir))) { continue }
      $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue
      foreach ($file in $files) {
        try {
          $link = $sh.CreateShortcut($file.FullName)
          $target = '' + $link.TargetPath
          if (-not $target -or $target.ToLower() -ne $exeWanted) { continue }
          $tokens = @(('' + $link.Arguments) -split '\s+' | Where-Object { $_ -ne '' })
          $patched = $tokens -contains $FLAG
          if ($action -eq 'patch' -and -not $patched) {
            $link.Arguments = (($tokens + $FLAG) -join ' ')
            $link.Save()
            $patched = $true
          } elseif ($action -eq 'restore' -and $patched) {
            $kept = @($tokens | Where-Object { $_ -ne $FLAG })
            $link.Arguments = ($kept -join ' ')
            $link.Save()
            $patched = $false
          }
          $list += [pscustomobject]@{ path = $file.FullName; target = $target; args = '' + $link.Arguments; patched = $patched }
        } catch {
          $errs += ($file.FullName + ': ' + $_.Exception.Message)
        }
      }
    }
    $result.shortcuts = $list
    $result.errors = $errs
  }
} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
}
Out-Result $result
