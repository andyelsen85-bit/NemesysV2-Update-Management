param(
  [string]$Configuration = "Release",
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$') {
  throw "Version must contain exactly three numeric fields, for example 1.2.3."
}

$versionParts = $Version.Split('.') | ForEach-Object { [uint32]$_ }
if ($versionParts[0] -gt 255 -or $versionParts[1] -gt 255 -or $versionParts[2] -gt 65535) {
  throw "MSI version fields exceed Windows Installer limits (major/minor <= 255, build <= 65535)."
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$client = Join-Path $root "clients\windows-service"
$project = Join-Path $PSScriptRoot "NemesysV2.Client.wixproj"

dotnet publish $client -c $Configuration -r win-x64 --self-contained true -p:PublishSingleFile=true -p:Version=$Version
dotnet build $project -c $Configuration -p:MsiVersion=$Version -p:ClientPublishDir="$client\bin\$Configuration\net8.0-windows\win-x64\publish"

Write-Host "MSI created under installer\windows\bin\$Configuration"