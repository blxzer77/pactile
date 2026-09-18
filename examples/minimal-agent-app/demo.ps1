# minimal-agent-app demo — pactile init → capability smoke → list tree
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$Workspace = Join-Path $ScriptDir "_demo-workspace"

function Resolve-Pactile {
    $built = Join-Path $RepoRoot "packages\cli\bin\pactile.js"
    if (Test-Path $built) {
        $dist = Join-Path $RepoRoot "packages\cli\dist\cli\index.js"
        if (-not (Test-Path $dist)) {
            Write-Host "Building CLI from monorepo..."
            Push-Location $RepoRoot
            pnpm build
            Pop-Location
        }
        return $built
    }
    $global = Get-Command pactile -ErrorAction SilentlyContinue
    if ($global) {
        return $global.Source
    }
    Write-Error "pactile not found. Install: npm install -g @blxzer/pactile`nOr run from the Pactile repo after pnpm build."
}

$Pactile = Resolve-Pactile
Write-Host "Using CLI: $Pactile"

if (Test-Path $Workspace) {
    Remove-Item -Recurse -Force $Workspace
}
New-Item -ItemType Directory -Path $Workspace | Out-Null
Set-Location $Workspace

Write-Host ""
Write-Host "==> pactile init --cursor --codex -y"
node $Pactile init --cursor --codex -y

Write-Host ""
Write-Host "==> pactile capability-smoke --json"
node $Pactile capability-smoke --json

Write-Host ""
Write-Host "==> Generated layout ($Workspace)"
Get-ChildItem -Force | ForEach-Object { $_.Name }
Write-Host ""
Write-Host ".pactile/"
Get-ChildItem .pactile -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }
Write-Host ""
Write-Host ".cursor/"
Get-ChildItem .cursor -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }

Write-Host ""
Write-Host "Done. Open $Workspace in Cursor or Codex to continue with your normal workflow."
