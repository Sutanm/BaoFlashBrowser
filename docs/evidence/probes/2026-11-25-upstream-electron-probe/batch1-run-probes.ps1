# 驱动四个场景：每个场景独立进程，记录退出码与最后几行输出。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Label
)
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:ELECTRON_RUN_AS_NODE = $null
Set-Content -Path (Join-Path $dir 'package.json') -Value '{ "name":"b11-probe","version":"1.0.0","main":"probe.js" }' -Encoding utf8

function Get-ExitMeaning([int]$code) {
  switch ($code) {
    0 { 'OK' }
    -1073740791 { 'STATUS_STACK_BUFFER_OVERRUN(0xC0000409) = CHECK/crash' }
    -1073741819 { 'STATUS_ACCESS_VIOLATION(0xC0000005)' }
    -1073741823 { 'STATUS_CONTROL_C_EXIT' }
    default { "exit=$code" }
  }
}

Write-Output "===== $Label  ($Exe) ====="
foreach ($s in 'crash-reload', 'crash-navigate', 'resizable-bounds', 'wrappable-gc') {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = '"' + $dir + '" ' + $s
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $dir
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  if (-not $p.WaitForExit(40000)) { try { $p.Kill() } catch {}; Write-Output ("{0,-18} TIMEOUT" -f $s); continue }
  $code = $p.ExitCode
  $result = ($stdout -split "`n" | Where-Object { $_ -match '^RESULT ' } | Select-Object -First 1)
  $last = ($stdout -split "`n" | Where-Object { $_ -match '^\[probe\]' } | Select-Object -Last 2) -join ' | '
  $err = ($stderr -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' | '
  Write-Output ("{0,-18} exit={1}  {2}" -f $s, $code, (Get-ExitMeaning $code))
  if ($result) { Write-Output ("                   {0}" -f $result.Trim()) }
  if ($last) { Write-Output ("                   log: {0}" -f $last) }
  if ($err) { Write-Output ("                   err: {0}" -f $err) }
}
