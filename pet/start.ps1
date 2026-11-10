param([switch]$NoWindow, [switch]$LegacyWindow, [switch]$Installed, [switch]$Demo)

$ErrorActionPreference = 'Stop'
$overlayDir = $PSScriptRoot
$workspaceDir = Split-Path $overlayDir -Parent
# Optional machine-specific overrides (gitignored); see local.example.ps1.
$localConfig = Join-Path $overlayDir 'local.ps1'
if (!$Installed -and (Test-Path -LiteralPath $localConfig)) { . $localConfig }
$clDir = if ($env:CHARACTERLIFE_DIR) { $env:CHARACTERLIFE_DIR } else { Join-Path $workspaceDir '..\CLResearch\CharacterLife' }
$envPath = Join-Path $clDir '.env.video.local'
# The video cohost (start-server, adapter, season) is the vendor/CharacterLife-VideoCohost submodule.
$cohostDir = if ($env:JINGJING_COHOST_DIR) { $env:JINGJING_COHOST_DIR } else { Join-Path $workspaceDir 'vendor\CharacterLife-VideoCohost' }
# .env.video.local names the database relative to the CL folder; pin it so starting from the cohost folder keeps the same memories.
if (!$env:CHARACTERLIFE_VIDEO_DB) { $env:CHARACTERLIFE_VIDEO_DB = Join-Path $clDir 'data\jingjing-video\characterlife.db' }
$asrPython = if ($env:JINGJING_ASR_PYTHON) { $env:JINGJING_ASR_PYTHON } else { Join-Path $workspaceDir 'Open-LLM-VTuber\.venv\Scripts\python.exe' }
$windowPython = if ($env:JINGJING_WINDOW_PYTHON) { $env:JINGJING_WINDOW_PYTHON } else { 'pythonw.exe' }
# Default window is the Electron shell (transparent panel, resize, tray); -LegacyWindow keeps the old pywebview window.
$electronExe = Join-Path $overlayDir 'node_modules\electron\dist\electron.exe'
$statePath = Join-Path $overlayDir 'running-processes.json'
$logDir = $overlayDir
$useSpeech = !$Installed
$clPort = 8787
$consolePort = 8788
$relayPort = 8790
if ($Installed) {
    $installData = Join-Path $env:LOCALAPPDATA 'CharacterCompanion'
    $statePath = Join-Path $installData 'running-processes.json'
    $logDir = Join-Path $installData 'logs'
    $envPath = Join-Path $installData 'config\.env.video.local'
    $cohostDir = Join-Path $workspaceDir 'vendor\CharacterLife-VideoCohost'
    $env:CHARACTERLIFE_VIDEO_DB = Join-Path $installData 'data\characterlife.db'
    $env:JINGJING_DATA_DIR = Join-Path $installData 'data'
    $env:JINGJING_OVERLAY_DIR = $installData
    $env:JINGJING_KNOWLEDGE_PATH = (Get-ChildItem -LiteralPath (Join-Path $overlayDir 'knowledge') -Filter 'Probably-Stolen-*-v2.md' -File | Select-Object -First 1).FullName
    $env:JINGJING_ELECTRON_DATA = Join-Path $installData 'electron'
    Remove-Item Env:HISTORY_DB -ErrorAction SilentlyContinue
    if ($env:CHARACTERLIFE_PORT) { $clPort = [int]$env:CHARACTERLIFE_PORT }
    if ($env:CHARACTERLIFE_CONSOLE_PORT) { $consolePort = [int]$env:CHARACTERLIFE_CONSOLE_PORT }
    if ($env:PORT) { $relayPort = [int]$env:PORT }
    $env:CHARACTERLIFE_PORT = "$clPort"
    $env:CHARACTERLIFE_CONSOLE_PORT = "$consolePort"
    $env:CHARACTERLIFE_CONSOLE_URL = "http://127.0.0.1:$consolePort"
    $env:JINGJING_RELAY_ORIGIN = "http://127.0.0.1:$relayPort"
    $env:JINGJING_TEXT_ONLY = '1'
    Remove-Item Env:CHARACTERLIFE_API_TOKEN -ErrorAction SilentlyContinue
    if ($LegacyWindow) { throw 'The installed companion requires the Electron window.' }
    if (!$NoWindow -and !(Test-Path -LiteralPath $electronExe)) { throw 'Run install.cmd before starting the companion.' }
}
if (!(Test-Path -LiteralPath (Join-Path $cohostDir 'examples/video-cohost/start-server.ts'))) { throw "Missing video cohost repository: $cohostDir" }
$env:PYTHONUTF8 = '1'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:no_proxy = $env:NO_PROXY
$env:PORT = "$relayPort"
$env:CL_URL = "http://127.0.0.1:$clPort"
$relayUrl = "http://127.0.0.1:$relayPort"
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
        if ($process -and $process.HasExited) { throw "Service exited. Check logs in $logDir" }
        try {
            $result = Invoke-RestMethod -Uri $url -TimeoutSec 2
            return $result
        } catch { Start-Sleep -Milliseconds 400 }
    }
    throw "Service did not become ready: $url"
}

function Start-Background($executable, $arguments, $directory, $logName) {
    return Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$logName.stdout.log") -RedirectStandardError (Join-Path $logDir "$logName.stderr.log")
}

if (!(Test-Path -LiteralPath $envPath)) { throw 'Missing CL video configuration.' }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if ($useSpeech -and !(Test-Path -LiteralPath $asrPython)) { throw 'Missing installed speech-recognition Python environment.' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$envFileArgument = '--env-file="{0}"' -f $envPath
$previousState = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$state = [ordered]@{}
$startedProcesses = @()
trap {
    foreach ($process in $startedProcesses) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
    break
}
if ($Installed) {
    Get-ChildItem Env: | Where-Object Name -like 'CHARACTERLIFE_THINK_*' | ForEach-Object {
        Remove-Item -LiteralPath ('Env:' + $_.Name)
    }
    Remove-Item Env:JINGJING_THINKING -ErrorAction SilentlyContinue
    $env:JINGJING_ALLOW_MOCK = if ($Demo) { '1' } else { '0' }
    $modelStatusJson = & $nodePath "--env-file=$envPath" (Join-Path $overlayDir 'model-status.mjs') --check
    if ($LASTEXITCODE -ne 0) {
        throw 'Model configuration is required. Run Configure.cmd (or CharacterCompanion.cmd setup) to open the settings page, save the API key, base URL and model name, then start again. Use CharacterCompanion.cmd -Demo only for offline fixed-response testing.'
    }
    $modelStatus = $modelStatusJson | ConvertFrom-Json
    $configStream = [IO.File]::OpenRead($envPath)
    $configHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $configHash = [BitConverter]::ToString($configHasher.ComputeHash($configStream)).Replace('-', '')
    } finally {
        $configStream.Dispose()
        $configHasher.Dispose()
    }
    $ownedServices = @()
    foreach ($service in @(
        @{ name = 'cl'; port = $clPort; pattern = 'examples[/\\]video-cohost[/\\]start-server\.ts|kernel-server\.mjs' },
        @{ name = 'relay'; port = $relayPort; pattern = 'relay\.mjs' }
    )) {
        $listener = Get-ListenerProcess $service.port
        if (!$listener) { continue }
        $name = $service.name
        $details = Get-CimInstance Win32_Process -Filter "ProcessId=$listener"
        $recordedStart = $previousState.($name + 'StartedAt')
        $sameStart = !$recordedStart -or ($details -and ([DateTimeOffset]$details.CreationDate).UtcDateTime -eq ([DateTimeOffset]$recordedStart).UtcDateTime)
        if (!$previousState.installed -or $previousState.$name -ne $listener -or !$sameStart -or $details.CommandLine -notmatch $service.pattern -or $details.CommandLine.IndexOf($envPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "Port $($service.port) is already in use. Stop the existing service and try again."
        }
        $ownedServices += $details
    }
    $consoleListener = Get-ListenerProcess $consolePort
    if ($consoleListener -and $consoleListener -ne (Get-ListenerProcess $clPort)) {
        throw "Port $consolePort is already in use. Stop the existing service and try again."
    }
    if ($previousState -and ($previousState.configHash -ne $configHash -or $previousState.modelMode -ne $modelStatus.mode)) {
        # Reload only verified companion processes when configuration or mode changes.
        [array]::Reverse($ownedServices)
        foreach ($owned in $ownedServices) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.ProcessId)"
            if ($current -and $current.CreationDate -eq $owned.CreationDate) {
                $process = Get-Process -Id $owned.ProcessId
                Stop-Process -Id $owned.ProcessId -ErrorAction Stop
                if (!$process.WaitForExit(5000)) { throw 'The previous companion service did not stop.' }
            }
        }
    }
    $state.installed = $true
    $state.configHash = $configHash
    $state.modelMode = $modelStatus.mode
}

if (!(Get-ListenerProcess $clPort)) {
    $kernelEntry = if ($Installed) { '"{0}"' -f (Join-Path $overlayDir 'kernel-server.mjs') } else { 'examples/video-cohost/start-server.ts' }
    $clProcess = Start-Background $nodePath @($envFileArgument, $kernelEntry) $cohostDir 'cl'
    $startedProcesses += $clProcess
    $null = Wait-Service "$env:CL_URL/healthz" $clProcess
}
$state.cl = Get-ListenerProcess $clPort

if ($useSpeech -and !(Get-ListenerProcess 8791)) {
    $asrProcess = Start-Background $asrPython @('speech_service.py') $overlayDir 'asr'
    $startedProcesses += $asrProcess
    $null = Wait-Service 'http://127.0.0.1:8791/health' $asrProcess 45
}
if ($useSpeech) { $state.asr = Get-ListenerProcess 8791 }

if (!(Get-ListenerProcess $relayPort)) {
    $relayProcess = Start-Background $nodePath @($envFileArgument, 'relay.mjs') $overlayDir 'relay'
    $startedProcesses += $relayProcess
    $null = Wait-Service "$relayUrl/history" $relayProcess
}
$state.relay = Get-ListenerProcess $relayPort
$health = Invoke-RestMethod -Uri "$relayUrl/api/status" -TimeoutSec 15
if (!$health.cl.connected -or ($useSpeech -and !$health.asr.ready)) { throw 'CL or speech recognition is not ready; check local logs.' }
if ($Installed -and !$health.asr.disabled) { throw 'The running relay is not in installed text mode.' }
if ($Installed -and $health.model.mode -ne $modelStatus.mode) { throw 'The running companion model mode does not match the configuration.' }
if ($Installed -and $health.cl.character.id -ne 'jingjing') { throw 'The running kernel is not bound to the Jingjing character.' }

if ($previousState -and $previousState.window) {
    $existingWindow = Get-CimInstance Win32_Process -Filter "ProcessId=$($previousState.window)"
    $recordedStart = $previousState.windowStartedAt
    $sameStart = !$recordedStart -or ($existingWindow -and ([DateTimeOffset]$existingWindow.CreationDate).UtcDateTime -eq ([DateTimeOffset]$recordedStart).UtcDateTime)
    $legacyWindowMatches = !$Installed -or $recordedStart -or ($existingWindow -and $existingWindow.ExecutablePath -ieq $electronExe)
    if ($existingWindow -and $sameStart -and $legacyWindowMatches -and $existingWindow.CommandLine -match 'float_window\.py|shell[/\\]main\.cjs') { $state.window = $existingWindow.ProcessId }
}
if (!$NoWindow -and !$state.window) {
    # This is the requested visible interactive overlay, not a background helper.
    $windowLogs = @{ RedirectStandardOutput = (Join-Path $logDir 'window.stdout.log'); RedirectStandardError = (Join-Path $logDir 'window.stderr.log') }
    if ($LegacyWindow -or !(Test-Path -LiteralPath $electronExe)) {
        $windowProcess = Start-Process -FilePath $windowPython -ArgumentList 'float_window.py' -WorkingDirectory $overlayDir -WindowStyle Normal -PassThru @windowLogs
    } else {
        $windowProcess = Start-Process -FilePath $electronExe -ArgumentList 'shell\main.cjs' -WorkingDirectory $overlayDir -PassThru @windowLogs
    }
    $state.window = $windowProcess.Id
    $startedProcesses += $windowProcess
}
if ($Installed) {
    foreach ($name in @('cl', 'relay', 'window')) {
        if ($state.$name) {
            $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.$name)"
            if (!$details) { throw "Companion process exited before startup completed: $name" }
            $state[$name + 'StartedAt'] = $details.CreationDate.ToUniversalTime().ToString('o')
        }
    }
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Host 'Jingjing ready.'
Write-Host ('CL memory connected; stored memories: ' + $health.cl.memories)
