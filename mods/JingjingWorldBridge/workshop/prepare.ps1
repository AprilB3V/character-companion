param(
    [string]$GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\Probably Stolen',
    # Updates the existing Jingjing item. Pass 0 explicitly only when creating a separate item.
    [string]$PublishedFileId = '3835039157',
    # 0 public, 1 friends only, 2 private, 3 unlisted.
    [ValidateSet('0', '1', '2', '3')][string]$Visibility = '2',
    [string]$ChangeNote = 'Developer test build.',
    [switch]$PublicListing
)

# Build the mod and stage a Workshop upload folder plus a SteamCMD item file. Uploading is a separate, manual step:
#   steamcmd +login <account> +workshop_build_item <path printed below> +quit
$ErrorActionPreference = 'Stop'
$modDir = Split-Path $PSScriptRoot -Parent
$stageDir = Join-Path $PSScriptRoot ('stage\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$contentDir = Join-Path $stageDir 'content'

& (Join-Path $modDir 'build.ps1') -GameDir $GameDir
$null = New-Item -ItemType Directory -Force -Path $contentDir
foreach ($fileName in @('JingjingWorldBridge.dll', 'manifest.xml')) {
    Copy-Item -LiteralPath (Join-Path $modDir "build\$fileName") -Destination $contentDir
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.txt') -Destination $contentDir

function Quote-Vdf([string]$text) {
    # Backslashes and quotes are escaped; newlines stay literal (KeyValues strings may span lines).
    return '"' + ($text -replace '\\', '\\' -replace '"', '\"' -replace "`r`n", "`n") + '"'
}

$descriptionFile = if ($PublicListing) { 'description-public.txt' } else { 'description.txt' }
$description = Get-Content -LiteralPath (Join-Path $PSScriptRoot $descriptionFile) -Raw -Encoding UTF8
$fields = [ordered]@{
    appid = '4348910'
    publishedfileid = $PublishedFileId
    contentfolder = $contentDir
    previewfile = (Join-Path $PSScriptRoot 'preview.png')
    visibility = $Visibility
    title = if ($PublicListing) { 'Jingjing World Bridge 鲸鲸游戏世界接口' } else { 'Jingjing World Bridge 鲸鲸游戏世界接口（测试）' }
    description = $description.TrimEnd()
    changenote = $ChangeNote
}
$lines = @('"workshopitem"', '{')
foreach ($key in $fields.Keys) { $lines += "    `"$key`" $(Quote-Vdf $fields[$key])" }
$lines += '}'
$vdfPath = Join-Path $stageDir 'workshop_item.vdf'
[System.IO.File]::WriteAllText($vdfPath, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

Get-ChildItem -LiteralPath $contentDir | Format-Table Name, Length -AutoSize
Write-Host "Item file: $vdfPath"
Write-Host "Upload:    steamcmd +login <account> +workshop_build_item `"$vdfPath`" +quit"
