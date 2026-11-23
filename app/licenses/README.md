# 许可文件来源

这两份文件从**官方 Electron 39.8.10 win32-x64 发行包**提取，用于补齐自编译内核缺失的许可文本：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `LICENSES.chromium.html` | `electron-v39.8.10-win32-x64.zip` 内的同名文件（14.4 MB） | 自编译内核没有生成该文件（`docs/kernel/README.md`），而 Chromium 的第三方许可要求随二进制分发。本项目的 Chromium 为 **142.0.7444.265**，与官方 Electron 39.8.10 相同，因此以同版本官方文件代替，属**近似**而非构建产物 |
| `LICENSE.electron` | 同一 zip 内的 `LICENSE` | Electron 本体许可（MIT） |

## 提取方式（可复现）

```powershell
$zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v39.8.10-win32-x64.zip" | Select-Object -First 1
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip.FullName)
foreach ($entry in $archive.Entries) {
  if ($entry.Name -eq 'LICENSES.chromium.html') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$PWD\licenses\LICENSES.chromium.html", $true)
  }
  if ($entry.Name -eq 'LICENSE') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$PWD\licenses\LICENSE.electron", $true)
  }
}
$archive.Dispose()
```

## 待办

自编译内核应当在自己的构建流程里生成 `LICENSES.chromium.html`（Chromium 的 `credits` 产物），
之后再替换本目录的近似文件。替换后需同步更新 `NOTICE.md` 的说明。
