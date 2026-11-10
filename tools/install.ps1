param([switch]$NonInteractive)

$ErrorActionPreference = 'Stop'
$rootDir = Split-Path $PSScriptRoot -Parent
$petDir = Join-Path $rootDir 'pet'
$cohostDir = Join-Path $rootDir 'vendor\CharacterLife-VideoCohost'
$configDir = Join-Path $env:LOCALAPPDATA 'CharacterCompanion\config'
$configPath = Join-Path $configDir '.env.video.local'

function Invoke-Checked($executable, [string[]]$arguments) {
    & $executable @arguments
    if ($LASTEXITCODE -ne 0) { throw "$executable failed (exit $LASTEXITCODE)." }
}

try {
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.18.0') {
        throw 'Install Node.js 22.18 or later with npm, then rerun install.cmd.'
    }
    $npm = (Get-Command npm.cmd).Source
    $git = (Get-Command git.exe).Source
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    # Update only the revisions pinned by the checked-out repository.
    Invoke-Checked $git @('-C', $rootDir, 'submodule', 'update', '--init', '--recursive', '--checkout')
    foreach ($directory in @($cohostDir, $petDir)) {
        Push-Location -LiteralPath $directory
        try {
            Invoke-Checked $npm @('ci', '--include=dev', '--no-audit', '--no-fund')
        } finally {
            Pop-Location
        }
    }
    $electronDir = Join-Path $petDir 'node_modules\electron'
    if (!(Test-Path -LiteralPath (Join-Path $electronDir 'dist\electron.exe'))) {
        Invoke-Checked node @((Join-Path $electronDir 'install.js'))
    }
    if (!(Test-Path -LiteralPath (Join-Path $electronDir 'dist\electron.exe'))) {
        throw 'Electron is missing after npm ci.'
    }
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
        $token = & node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
        if ($LASTEXITCODE -ne 0 -or $token -notmatch '^[0-9a-f]{64}$') { throw 'Token generation failed.' }
        $tokenLine = 'CHARACTERLIFE_API_TOKEN' + '=' + $token
        $tempConfig = Join-Path $configDir ([guid]::NewGuid().ToString() + '.tmp')
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(((@('# Use node pet\config-app.mjs to fill these in.', $tokenLine) + @('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL' | ForEach-Object { $_ + '=' }) + '') -join "`n"))
            [IO.File]::WriteAllBytes($tempConfig, $bytes)
            try {
                [IO.File]::Move($tempConfig, $configPath)
            } catch [IO.IOException] {
                if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { throw }
            }
        } finally {
            [IO.File]::Delete($tempConfig)
        }
    }
    Write-Host "INSTALL_OK. Model configuration: $configPath"
    if (!$NonInteractive) {
        Write-Host 'Opening the local settings page. Save your model settings there, then start the companion from the page.'
        Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"{0}"' -f (Join-Path $petDir 'config-app.mjs'))
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
