# minimal-agent-app demo — Pactile init -> capability smoke -> generated tree
$ErrorActionPreference = "Stop"

$ScriptDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\.."))
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js 20 or newer is required. Install Node.js and try again."
}
$NodeVersionText = (& $NodeCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $NodeVersionText -notmatch "^v(?<Major>\d+)\.") {
    throw "Could not read the Node.js version from '$($NodeCommand.Source)'."
}
if ([int]$Matches.Major -lt 20) {
    throw "Node.js 20 or newer is required (found $NodeVersionText)."
}
Write-Host "Using Node.js $NodeVersionText"

$WorkspaceInput = if ($env:PACTILE_DEMO_WORKSPACE) {
    $env:PACTILE_DEMO_WORKSPACE
} else {
    Join-Path $ScriptDir "_demo-workspace"
}
if (-not [System.IO.Path]::IsPathRooted($WorkspaceInput)) {
    $WorkspaceInput = Join-Path $ScriptDir $WorkspaceInput
}
$Workspace = [System.IO.Path]::GetFullPath($WorkspaceInput)
if (
    $Workspace -eq [System.IO.Path]::GetPathRoot($Workspace) -or
    $Workspace -eq $ScriptDir -or
    $Workspace -eq $RepoRoot
) {
    throw "Refusing to use a filesystem or repository root as the demo workspace."
}

$BuiltCli = Join-Path $RepoRoot "packages\cli\dist\bin\pactile.js"
$PactileCommand = $null
$PactilePrefix = @()
if (Test-Path -LiteralPath $BuiltCli) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "packages\cli\dist\cli\index.js"))) {
        Write-Host "Building CLI from monorepo..."
        Push-Location $RepoRoot
        try {
            pnpm build
            if ($LASTEXITCODE -ne 0) {
                throw "pnpm build failed with exit code $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }
    }
    if (-not (Test-Path -LiteralPath $BuiltCli)) {
        throw "Build did not create $BuiltCli."
    }
    $PactileCommand = $NodeCommand.Source
    $PactilePrefix = @($BuiltCli)
} else {
    $GlobalPactile = Get-Command pactile -ErrorAction SilentlyContinue
    if (-not $GlobalPactile) {
        throw "pactile not found. Install: npm install -g @blxzer/pactile`nOr run from the Pactile repo after pnpm build."
    }
    $PactileCommand = if ($GlobalPactile.Source) { $GlobalPactile.Source } else { $GlobalPactile.Name }
}

function Invoke-Pactile {
    $Arguments = @($script:PactilePrefix) + @($args)
    & $script:PactileCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pactile command failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Using CLI: $PactileCommand $($PactilePrefix -join ' ')"
if (Test-Path -LiteralPath $Workspace) {
    $WorkspaceItem = Get-Item -LiteralPath $Workspace -Force
    if ($WorkspaceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to replace a link or junction at $Workspace."
    }
    Remove-Item -LiteralPath $Workspace -Recurse -Force
}
New-Item -ItemType Directory -Path $Workspace | Out-Null
Push-Location $Workspace
try {
    Write-Host ""
    Write-Host "==> pactile --version"
    Invoke-Pactile --version

    Write-Host ""
    Write-Host "==> verify pactile init --help supports --codex"
    $InitHelp = (Invoke-Pactile init --help | Out-String)
    if ($InitHelp -notmatch "--codex") {
        throw "pactile init --help does not advertise --codex."
    }
    Write-Host "init help advertises --codex"

    Write-Host ""
    Write-Host "==> pactile init --codex --yes --skip-readiness --user pactile-demo"
    Invoke-Pactile init --codex --yes --skip-readiness --user pactile-demo
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "==> Generated Codex layout ($Workspace)"
Get-ChildItem -Force $Workspace | ForEach-Object { $_.Name }
Write-Host ""
Write-Host ".pactile/"
Get-ChildItem (Join-Path $Workspace ".pactile") -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }
Write-Host ""
Write-Host ".agents/skills/"
Get-ChildItem (Join-Path $Workspace ".agents\skills") -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }

Write-Host ""
Write-Host "Done. Open $Workspace in Codex to continue with your normal workflow."
