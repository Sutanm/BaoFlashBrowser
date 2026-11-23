<#
.SYNOPSIS
把自编译内核的 `out/Rel` 组装成一个干净的、可直接运行的分发目录。

.DESCRIPTION
从内核构建输出里只挑运行时需要的文件（可执行文件、PAK/ICU/快照、GPU 相关 DLL、
VC 运行库、locales），不复制 pdb / obj / 测试 exe / runtime_deps / build.ninja 等构建中间物。

原先这份脚本放在仓库外的 `flashprobe/` 里，换机器就丢失；现在随仓库维护。
`npm run runtime:prepare -- <Dist>` 会从这个目录取运行时。

.EXAMPLE
pwsh -NoProfile -File scripts\assemble-kernel-dist.ps1 `
  -Out D:\cr\src\out\Rel -Dist D:\kernel-dist
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Dist,
  # 可选：BYOP 插件。开发环境可以把它同时放到 dist 与 .runtime 里。
  [string]$Flash
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Out)) { throw "构建输出不存在: $Out" }
New-Item -ItemType Directory -Path $Dist -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $Dist 'resources\app\main.js'))) {
  throw "dist 里缺少 resources\app\main.js —— 先放入一个可执行的 app（Electron 的默认启动器也行）"
}

$files = @(
  'electron.exe',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
  'icudtl.dat', 'v8_context_snapshot.bin', 'snapshot_blob.bin',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'libEGL.dll', 'libGLESv2.dll',
  'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'ffmpeg.dll',
  'msvcp140.dll', 'msvcp140_atomic_wait.dll',
  'vcruntime140.dll', 'vcruntime140_1.dll', 'vccorlib140.dll'
)
$dirs = @('angledata', 'hyphen-data', 'locales')

$copied = 0
$missing = @()
foreach ($f in $files) {
  $src = Join-Path $Out $f
  if (Test-Path -LiteralPath $src) {
    Copy-Item $src (Join-Path $Dist $f) -Force
    $copied++
  } else {
    $missing += $f
  }
}
foreach ($d in $dirs) {
  $src = Join-Path $Out $d
  if (Test-Path -LiteralPath $src) {
    Copy-Item $src (Join-Path $Dist $d) -Recurse -Force
    $copied++
  } else {
    $missing += $d
  }
}

if ($Flash) {
  if (Test-Path -LiteralPath $Flash) {
    Copy-Item $Flash (Join-Path $Dist 'pepflashplayer64.dll') -Force
    $copied++
  } else {
    $missing += "pepflashplayer64.dll（指定了 -Flash 但文件不存在：$Flash）"
  }
}

# locales 只保留两个（体积）；其余删除
$loc = Join-Path $Dist 'locales'
if (Test-Path $loc) {
  Get-ChildItem $loc -File | Where-Object { $_.Name -notin @('en-US.pak', 'zh-CN.pak') } | Remove-Item -Force
}

Write-Host ("复制条目: " + $copied)
if ($missing.Count) { Write-Host ("缺失（需确认是否可选）: " + ($missing -join ', ')) }
$size = (Get-ChildItem $Dist -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("dist 体积: " + [math]::Round($size / 1MB, 1) + " MB")
Write-Host ''
Write-Host '下一步：'
Write-Host ("  npm run runtime:prepare -- " + $Dist)
