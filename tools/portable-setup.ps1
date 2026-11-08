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
        $content = "$tokenLine`n# DEEPSEEK_API_KEY=`n# DEEPSEEK_BASE_URL=`n# DEEPSEEK_MODEL=`n"
        $tempPath = Join-Path $configDir ([guid]::NewGuid().ToString() + '.tmp')
        try {
            [IO.File]::WriteAllText($tempPath, $content, (New-Object Text.UTF8Encoding($false)))
            try { [IO.File]::Move($tempPath, $configPath) } catch [IO.IOException] {
                if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { throw }
            }
        } finally { [IO.File]::Delete($tempPath) }
    }
    Write-Host "SETUP_OK. Configuration: $configPath"
    if (!$NonInteractive) { Start-Process notepad.exe -ArgumentList ('"{0}"' -f $configPath) }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
