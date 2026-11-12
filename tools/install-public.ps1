param(
    [switch]$NonInteractive,
    [string]$ArchivePath,
    [string]$ChecksumPath
)

$ErrorActionPreference = 'Stop'
$version = '0.1.0-rc.4'
$packageName = "CharacterCompanion-$version-win-x64"
$appsDir = Join-Path $env:LOCALAPPDATA 'CharacterCompanion\apps'
$targetDir = Join-Path $appsDir $packageName
$stagingDir = $null
function Test-Package([string]$directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $directory 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne $version -or $manifest.platform -ne 'win-x64' -or !$manifest.files) { throw 'Unexpected installed manifest.' }
    $targetPrefix = [IO.Path]::GetFullPath($directory) + [IO.Path]::DirectorySeparatorChar
    foreach ($file in $manifest.files) {
        $filePath = [IO.Path]::GetFullPath((Join-Path $directory $file.path))
        if (!$filePath.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path.' }
        if ((Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash -ne $file.sha256) { throw "Installed file check failed: $($file.path)" }
    }
    foreach ($required in @('CharacterCompanion.cmd', 'tools\portable-setup.ps1', 'runtime\node\node.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $directory $required) -PathType Leaf)) { throw "Missing required file: $required" }
    }
}
try {
    if ([bool]$ArchivePath -ne [bool]$ChecksumPath) { throw 'Supply both ArchivePath and ChecksumPath for offline installation.' }
    if (Test-Path -LiteralPath $targetDir) {
        try { Test-Package $targetDir } catch {
            # Files were deleted or changed; keep the old folder aside and reinstall a clean copy.
            # User settings and memories live outside this folder and are not touched.
            $brokenDir = '{0}.broken-{1}' -f $targetDir, (Get-Date -Format 'yyyyMMddHHmmss')
            Write-Host "Installed files are incomplete ($($_.Exception.Message)). Reinstalling; old copy kept at $brokenDir"
            [IO.Directory]::Move($targetDir, $brokenDir)
        }
    }
    if (!(Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $appsDir -Force | Out-Null
        $stagingDir = Join-Path $appsDir ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $stagingDir | Out-Null
        if (!$ArchivePath) {
            $baseUrl = "https://github.com/AprilB3V/character-companion/releases/download/v$version"
            $ArchivePath = Join-Path $stagingDir "$packageName.zip"
            $ChecksumPath = Join-Path $stagingDir 'SHA256SUMS.txt'
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS.txt" -OutFile $ChecksumPath
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$packageName.zip" -OutFile $ArchivePath
        }
        $checksumLines = @(Get-Content -LiteralPath $ChecksumPath -Encoding UTF8 | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+" + [regex]::Escape("$packageName.zip") + '$') })
        if ($checksumLines.Count -ne 1) { throw 'Expected exactly one package checksum.' }
        $expectedHash = ($checksumLines[0] -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Package checksum mismatch.' }
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath (Join-Path $stagingDir 'unpacked')
        $unpackedDir = Join-Path $stagingDir "unpacked\$packageName"
        if (!(Test-Path -LiteralPath (Join-Path $unpackedDir 'release-manifest.json'))) { throw 'Package manifest missing.' }
        Test-Package $unpackedDir
        try { [IO.Directory]::Move($unpackedDir, $targetDir) } catch [IO.IOException] {
            if (!(Test-Path -LiteralPath $targetDir -PathType Container)) { throw }
        }
    }
    Test-Package $targetDir
    & (Join-Path $targetDir 'tools\portable-setup.ps1') -NonInteractive
    if (!$?) { throw 'Configuration setup failed.' }
    Write-Host "INSTALL_OK. Start: $targetDir\CharacterCompanion.cmd"
    if (!$NonInteractive) {
        & (Join-Path $targetDir 'tools\portable-setup.ps1')
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($stagingDir -and (Test-Path -LiteralPath $stagingDir)) {
        $resolvedStage = [IO.Path]::GetFullPath($stagingDir)
        $resolvedApps = [IO.Path]::GetFullPath($appsDir) + [IO.Path]::DirectorySeparatorChar
        if (!$resolvedStage.StartsWith($resolvedApps, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected staging directory.' }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
