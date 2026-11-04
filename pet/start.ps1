param([switch]$NoWindow, [switch]$LegacyWindow)

$ErrorActionPreference = 'Stop'
$overlayDir = $PSScriptRoot
$workspaceDir = Split-Path $overlayDir -Parent
# Optional machine-specific overrides (gitignored); see local.example.ps1.
$localConfig = Join-Path $overlayDir 'local.ps1'
if (Test-Path -LiteralPath $localConfig) { . $localConfig }
$clDir = if ($env:CHARACTERLIFE_DIR) { $env:CHARACTERLIFE_DIR } else { Join-Path $workspaceDir '..\CLResearch\CharacterLife' }
$envPath = Join-Path $clDir '.env.video.local'
# The video cohost (start-server, adapter, season) is the vendor/CharacterLife-VideoCohost submodule.
$cohostDir = if ($env:JINGJING_COHOST_DIR) { $env:JINGJING_COHOST_DIR } else { Join-Path $workspaceDir 'vendor\CharacterLife-VideoCohost' }
if (!(Test-Path -LiteralPath (Join-Path $cohostDir 'examples/video-cohost/start-server.ts'))) { throw "Missing video cohost repository: $cohostDir" }
# .env.video.local names the database relative to the CL folder; pin it so starting from the cohost folder keeps the same memories.
if (!$env:CHARACTERLIFE_VIDEO_DB) { $env:CHARACTERLIFE_VIDEO_DB = Join-Path $clDir 'data\jingjing-video\characterlife.db' }
$asrPython = if ($env:JINGJING_ASR_PYTHON) { $env:JINGJING_ASR_PYTHON } else { Join-Path $workspaceDir 'Open-LLM-VTuber\.venv\Scripts\python.exe' }
$windowPython = 'C:\Python313\pythonw.exe'
# Default window is the Electron shell (transparent panel, resize, tray); -LegacyWindow keeps the old pywebview window.
$electronExe = Join-Path $overlayDir 'node_modules\electron\dist\electron.exe'
$statePath = Join-Path $overlayDir 'running-processes.json'
$env:PYTHONUTF8 = '1'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:no_proxy = $env:NO_PROXY
$env:PORT = '8790'
$env:CL_URL = 'http://127.0.0.1:8787'
$env:ASR_URL = 'http://127.0.0.1:8791'
# User-level DEEPSEEK_* variables would override .env.video.local (node --env-file never overrides),
# so drop them from this process; CL and the relay then read the video configuration file only.
Remove-Item Env:DEEPSEEK_API_KEY, Env:DEEPSEEK_BASE_URL, Env:DEEPSEEK_MODEL -ErrorAction SilentlyContinue

function Get-ListenerProcess($port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    return $null
}

function Wait-Service($url, $process, $seconds = 30) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if ($process -and $process.HasExited) { throw "Service exited. Check logs in $overlayDir" }
        try {
            $result = Invoke-RestMethod -Uri $url -TimeoutSec 2
            return $result
        } catch { Start-Sleep -Milliseconds 400 }
    }
    throw "Service did not become ready: $url"
}

function Start-Background($executable, $arguments, $directory, $logName) {
    return Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $overlayDir "$logName.stdout.log") -RedirectStandardError (Join-Path $overlayDir "$logName.stderr.log")
}

if (!(Test-Path -LiteralPath $envPath)) { throw 'Missing CL video configuration.' }
if (!(Test-Path -LiteralPath $asrPython)) { throw 'Missing installed speech-recognition Python environment.' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$previousState = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
$state = [ordered]@{}

if (!(Get-ListenerProcess 8787)) {
    $clProcess = Start-Background $nodePath @("--env-file=$envPath", 'examples/video-cohost/start-server.ts') $cohostDir 'cl'
    $null = Wait-Service 'http://127.0.0.1:8787/healthz' $clProcess
}
$state.cl = Get-ListenerProcess 8787

if (!(Get-ListenerProcess 8791)) {
    $asrProcess = Start-Background $asrPython @('speech_service.py') $overlayDir 'asr'
    $null = Wait-Service 'http://127.0.0.1:8791/health' $asrProcess 45
}
$state.asr = Get-ListenerProcess 8791

if (!(Get-ListenerProcess 8790)) {
    $relayProcess = Start-Background $nodePath @("--env-file=$envPath", 'relay.mjs') $overlayDir 'relay'
    $null = Wait-Service 'http://127.0.0.1:8790/history' $relayProcess
}
$state.relay = Get-ListenerProcess 8790
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/status' -TimeoutSec 15
if (!$health.cl.connected -or !$health.asr.ready) { throw 'CL or speech recognition is not ready; check local logs.' }

if ($previousState -and $previousState.window) {
    $existingWindow = Get-CimInstance Win32_Process -Filter "ProcessId=$($previousState.window)"
    if ($existingWindow -and $existingWindow.CommandLine -match 'float_window\.py|shell[/\\]main\.cjs') { $state.window = $existingWindow.ProcessId }
}
if (!$NoWindow -and !$state.window) {
    # This is the requested visible interactive overlay, not a background helper.
    $windowLogs = @{ RedirectStandardOutput = (Join-Path $overlayDir 'window.stdout.log'); RedirectStandardError = (Join-Path $overlayDir 'window.stderr.log') }
    if ($LegacyWindow -or !(Test-Path -LiteralPath $electronExe)) {
        $windowProcess = Start-Process -FilePath $windowPython -ArgumentList 'float_window.py' -WorkingDirectory $overlayDir -WindowStyle Normal -PassThru @windowLogs
    } else {
        $windowProcess = Start-Process -FilePath $electronExe -ArgumentList 'shell\main.cjs' -WorkingDirectory $overlayDir -PassThru @windowLogs
    }
    $state.window = $windowProcess.Id
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Host 'Jingjing ready: microphone -> local ASR -> CharacterLife -> text overlay.'
Write-Host ('CL memory connected; stored memories: ' + $health.cl.memories)
