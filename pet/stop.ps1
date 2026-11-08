param([switch]$IncludeCl, [switch]$Installed)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'running-processes.json'
if ($Installed) { $statePath = Join-Path $env:LOCALAPPDATA 'CharacterCompanion\running-processes.json' }
if (!(Test-Path -LiteralPath $statePath)) { exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedPatterns = @{
    window = 'float_window\.py|shell[/\\]main\.cjs'
    relay = 'relay\.mjs'
    asr = 'speech_service\.py'
}
if ($IncludeCl) { $expectedPatterns.cl = 'examples[/\\]video-cohost[/\\]start-server\.ts|kernel-server\.mjs' }
foreach ($entry in $expectedPatterns.GetEnumerator()) {
    $processId = $state.($entry.Key)
    if (!$processId) { continue }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    $recordedStart = $state.($entry.Key + 'StartedAt')
    $sameStart = !$recordedStart -or ($details -and ([DateTimeOffset]$details.CreationDate).UtcDateTime -eq ([DateTimeOffset]$recordedStart).UtcDateTime)
    $legacyMatches = $true
    if ($Installed -and !$recordedStart -and $details) {
        if ($entry.Key -eq 'window') {
            $legacyMatches = $details.ExecutablePath -ieq (Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe')
        } else {
            $configPath = Join-Path $env:LOCALAPPDATA 'CharacterCompanion\config\.env.video.local'
            $legacyMatches = $details.CommandLine -and $details.CommandLine.IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
    }
    if ($details -and $sameStart -and $legacyMatches -and $details.CommandLine -match $entry.Value) { Stop-Process -Id $processId }
}
Write-Host 'Overlay and local speech services stopped. CL is kept running unless -IncludeCl is supplied.'
