# Install-RestartPlugin.ps1 - install / uninstall the DSH "Restart" plugin into a profile.
#
# Thin wrapper in front of the generic installer scripts\Install-DshPlugin.ps1, so every
# plugin in this repository installs with the exact same steps (a managed block in the
# profile's cordis.patch.yml plus the package materialised under <profile>\node_modules\).
#
# ASCII-only on purpose (Windows PowerShell 5.1 would mis-read a BOM-less UTF-8 file as ANSI).
#
# Usage:
#   Install-RestartPlugin.ps1                      # install into $DSH_HOME\profiles\web
#   Install-RestartPlugin.ps1 -ProfileDir <dir>    # install into another profile (tests)
#   Install-RestartPlugin.ps1 -Action uninstall    # remove package + patch block
#   Install-RestartPlugin.ps1 -Action disable      # keep files, disable the row (live)
#   Install-RestartPlugin.ps1 -Action enable
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall', 'disable', 'enable')]
    [string]$Action = 'install',

    [string]$DSHHome = '',
    [string]$Profile = 'web',
    [string]$ProfileDir = '',
    [string]$Source = '',
    [string]$PluginName = 'dsh-plugin-restart',
    [string]$PluginId = 'restart',
    [string]$PatchFile = '',
    [switch]$HomeLayer
)

$ErrorActionPreference = 'Stop'
$SelfDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Source resolution lives here (not in the generic script): only this wrapper knows where it
# is. Running from the repository, the package is <repo>\plugin\<name> (this file lives in its
# scripts\ folder); running from an installed copy, the package *is* the parent directory.
if ([string]::IsNullOrWhiteSpace($Source)) {
    $packageDir = Split-Path -Parent $SelfDir
    $fromRepo = Join-Path (Split-Path -Parent $packageDir) 'plugin\dsh-plugin-restart'
    if (Test-Path -LiteralPath (Join-Path $fromRepo 'package.json')) { $Source = $fromRepo }
    elseif (Test-Path -LiteralPath (Join-Path $packageDir 'package.json')) { $Source = $packageDir }
}

# From the repository the generic installer sits at <repo>\scripts\Install-DshPlugin.ps1; an
# installed copy carries it inside its own scripts\ folder (the installer vendors it there),
# so the repository seat is tried first and the vendored copy second.
$packageDir = Split-Path -Parent $SelfDir
$genericCandidates = @(
    (Join-Path (Split-Path -Parent (Split-Path -Parent $packageDir)) 'scripts\Install-DshPlugin.ps1'),
    (Join-Path $SelfDir 'Install-DshPlugin.ps1')
)
$Generic = $null
foreach ($candidate in $genericCandidates) {
    if (Test-Path -LiteralPath $candidate) { $Generic = $candidate; break }
}
if ($null -eq $Generic) {
    # Standalone checkouts (and the published package) do not carry the toolkit's generic
    # installer, so print the two steps it performs instead of failing with a path error.
    if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
        $dshHome = $(if (-not [string]::IsNullOrWhiteSpace($DSHHome)) { $DSHHome }
            elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME }
            else { Join-Path $env:USERPROFILE '.dsh' })
        $ProfileDir = Join-Path $dshHome ("profiles\{0}" -f $Profile)
    }
    $target = Join-Path (Join-Path $ProfileDir 'node_modules') $PluginName
    Write-Host 'Install-DshPlugin.ps1 not found next to this script, so here is the manual equivalent:'
    Write-Host ''
    Write-Host ('  1) copy this package to: {0}' -f $target)
    Write-Host ('  2) add this row to {0}:' -f (Join-Path $ProfileDir 'cordis.patch.yml'))
    Write-Host ''
    Write-Host '     - insert:'
    Write-Host ('         - id: {0}' -f $PluginId)
    Write-Host ("           name: '{0}'" -f $PluginName)
    Write-Host ''
    Write-Host '  3) refresh the browser page, then open Settings -> Restart.'
    Write-Host ''
    Write-Host 'Both steps are what this script automates when the full toolkit is present.'
    exit 2
}

$Forward = @{
    Action     = $Action
    Profile    = $Profile
    PluginName = $PluginName
    PluginId   = $PluginId
    Source     = $Source
}
if (-not [string]::IsNullOrWhiteSpace($DSHHome)) { $Forward.DSHHome = $DSHHome }
if (-not [string]::IsNullOrWhiteSpace($ProfileDir)) { $Forward.ProfileDir = $ProfileDir }
if (-not [string]::IsNullOrWhiteSpace($PatchFile)) { $Forward.PatchFile = $PatchFile }
if ($HomeLayer) { $Forward.HomeLayer = $true }

& $Generic @Forward
