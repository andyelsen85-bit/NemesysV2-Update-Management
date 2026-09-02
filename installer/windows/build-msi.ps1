param(
  [string]$Configuration = "Release",
  [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$client = Join-Path $root "clients\windows-service"
$project = Join-Path $PSScriptRoot "NemesysV2.Client.wixproj"

dotnet publish $client -c $Configuration -r win-x64 --self-contained true -p:PublishSingleFile=true
dotnet build $project -c $Configuration -p:MsiVersion=$Version -p:DefineConstants="MsiVersion=$Version;ClientPublishDir=$client\bin\$Configuration\net8.0-windows\win-x64\publish"

Write-Host "MSI created under installer\windows\bin\$Configuration"