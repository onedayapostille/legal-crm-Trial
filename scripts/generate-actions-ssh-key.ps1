[CmdletBinding()]
param(
  [string]$OutputPath = (Join-Path $env:USERPROFILE ".ssh\alghazzawi_github_actions_ed25519")
)

$ErrorActionPreference = "Stop"

if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
  throw "Refusing to overwrite existing private key: $OutputPath"
}
if (Test-Path -LiteralPath "$OutputPath.pub" -PathType Leaf) {
  throw "Refusing to overwrite existing public key: $OutputPath.pub"
}

$parent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null

& ssh-keygen -t ed25519 -a 100 -f $OutputPath -C "github-actions-alghazzawi-production" -N ""
if ($LASTEXITCODE -ne 0) {
  throw "ssh-keygen failed with exit code $LASTEXITCODE"
}

Write-Host "Created a dedicated Actions key pair."
Write-Host "Private key path: $OutputPath (contents intentionally not printed)"
Write-Host "Public key path: $OutputPath.pub"
& ssh-keygen -lf "$OutputPath.pub" -E sha256
Write-Host "STOP: obtain approval before installing the public key or adding the private key to GitHub."
