$ErrorActionPreference = 'Stop'
$outputDir = Join-Path $PSScriptRoot 'build'
$null = New-Item -ItemType Directory -Force -Path $outputDir
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testPath = Join-Path $outputDir 'CollectorTests.exe'
& $compilerPath /nologo /noconfig /target:exe /reference:System.dll /reference:System.Core.dll ('/out:' + $testPath) (Join-Path $PSScriptRoot 'JingjingWorldBridge.cs') (Join-Path $PSScriptRoot 'tests\CollectorTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Collector test compilation failed.' }
& $testPath
if ($LASTEXITCODE -ne 0) { throw 'Collector tests failed.' }
