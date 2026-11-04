param([switch]$IncludeCl)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'running-processes.json'
if (!(Test-Path -LiteralPath $statePath)) { exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$expectedPatterns = @{
    window = 'float_window\.py|shell[/\\]main\.cjs'
    relay = 'relay\.mjs'
    asr = 'speech_service\.py'
}
if ($IncludeCl) { $expectedPatterns.cl = 'examples[/\\]video-cohost[/\\]start-server\.ts' }
foreach ($entry in $expectedPatterns.GetEnumerator()) {
    $processId = $state.($entry.Key)
    if (!$processId) { continue }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if ($details -and $details.CommandLine -match $entry.Value) { Stop-Process -Id $processId }
}
Write-Host 'Overlay and local speech services stopped. CL is kept running unless -IncludeCl is supplied.'
