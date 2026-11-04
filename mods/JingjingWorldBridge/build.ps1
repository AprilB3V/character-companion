param(
    [string]$GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\Probably Stolen',
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$managedDir = Join-Path $GameDir 'Probably Stolen_Data\Managed'
$outputDir = Join-Path $PSScriptRoot 'build'
$null = New-Item -ItemType Directory -Force -Path $outputDir
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$arguments = @('/nologo', '/noconfig', '/target:library', '/optimize+', '/nostdlib+',
    ('/out:' + (Join-Path $outputDir 'JingjingWorldBridge.dll')))
foreach ($referenceName in @('mscorlib', 'System', 'System.Core', 'netstandard', 'Assembly-CSharp', 'UnityEngine.CoreModule', 'Newtonsoft.Json', '0Harmony')) {
    $arguments += '/reference:' + (Join-Path $managedDir ($referenceName + '.dll'))
}
$arguments += Join-Path $PSScriptRoot 'JingjingWorldBridge.cs'
& $compilerPath $arguments
if ($LASTEXITCODE -ne 0) { throw 'Bridge compilation failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'manifest.xml') -Destination $outputDir
if ($Install) {
    $installDir = Join-Path $GameDir 'Mods\JingjingWorldBridge'
    $null = New-Item -ItemType Directory -Force -Path $installDir
    foreach ($fileName in @('JingjingWorldBridge.dll', 'manifest.xml')) {
        Copy-Item -LiteralPath (Join-Path $outputDir $fileName) -Destination $installDir -Force
    }
    Write-Host ('Installed: ' + $installDir)
}
