param([switch]$NonInteractive)

$ErrorActionPreference = 'Stop'
$configDir = Join-Path $env:LOCALAPPDATA 'CharacterCompanion\config'
$configPath = Join-Path $configDir '.env.video.local'
try {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
        $randomBytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
        $randomHex = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
        $tokenLine = 'CHARACTERLIFE_API_TOKEN' + '=' + $randomHex
        $content = ((@('# Use Configure.cmd (or CharacterCompanion.cmd setup) to fill these in.', $tokenLine) + @('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL' | ForEach-Object { $_ + '=' }) + '') -join "`n")
        $tempPath = Join-Path $configDir ([guid]::NewGuid().ToString() + '.tmp')
        try {
            [IO.File]::WriteAllText($tempPath, $content, (New-Object Text.UTF8Encoding($false)))
            try { [IO.File]::Move($tempPath, $configPath) } catch [IO.IOException] {
                if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { throw }
            }
        } finally { [IO.File]::Delete($tempPath) }
    }
    Write-Host "SETUP_OK. Configuration: $configPath"
    if (!$NonInteractive) {
        # Open the local settings page; the launcher sets up the bundled Node runtime.
        $launcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'CharacterCompanion.cmd'
        Start-Process -FilePath $launcher -ArgumentList 'setup'
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
