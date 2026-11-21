$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS from https://nodejs.org' }
if (-not (Test-Path -LiteralPath 'node_modules/tsx')) { npm install --offline=false; if ($LASTEXITCODE) { throw 'Dependency installation failed' } }
npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
node --import tsx scripts/launch.ts --open
