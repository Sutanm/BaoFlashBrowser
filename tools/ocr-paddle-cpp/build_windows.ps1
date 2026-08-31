param(
  [Parameter(Mandatory = $true)][string]$PaddleLib,
  [Parameter(Mandatory = $true)][string]$PaddleOcrCpp,
  [Parameter(Mandatory = $true)][string]$OpenCVSourceDir,
  [Parameter(Mandatory = $true)][string]$OpenCVConfigDir,
  [Parameter(Mandatory = $true)][string]$OpenCVImportLib,
  [string]$BuildDir = '.cache/ocr/windows-cpp-build'
)

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path

cmake -S $sourceDir -B $BuildDir -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  "-DPADDLE_LIB=$PaddleLib" `
  "-DPADDLE_OCR_CPP=$PaddleOcrCpp" `
  "-DOPENCV_SOURCE_DIR=$OpenCVSourceDir" `
  "-DOPENCV_CONFIG_DIR=$OpenCVConfigDir" `
  "-DOPENCV_IMPORT_LIB=$OpenCVImportLib"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

cmake --build $BuildDir --config Release
exit $LASTEXITCODE
