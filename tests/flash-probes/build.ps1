$ErrorActionPreference = 'Continue'
$flex = 'D:\tools\flex-sdk'
$player = "$flex\frameworks\libs\player\32.0"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $dir 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-1.8'

$targets = @('LsoWrite','LsoRead','HttpProbe','FullscreenProbe','WebSocketProbe','Stage3DProbe')
foreach ($t in $targets) {
  $out = Join-Path $outDir "$t.swf"
  if (Test-Path $out) { Remove-Item $out -Force }
  & cmd /c "`"$flex\bin\mxmlc.bat`" -target-player=32.0 -swf-version=32 -static-link-runtime-shared-libraries=true -compiler.external-library-path=`"$player`" -compiler.library-path=`"$player`" -use-network=true -debug=false -output=`"$out`" `"$dir\$t.as`"" 2>&1 | Out-Null
  if (Test-Path $out) { "  OK   $t.swf  $((Get-Item $out).Length)B" } else { "  FAIL $t" }
}
