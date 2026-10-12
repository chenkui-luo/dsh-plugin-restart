# publish-restart.ps1 - push local changes of plugin\dsh-plugin-restart to its public repository.
#
# Why this needs special handling on this machine: github.com resolves to 127.0.0.1 because
# Watt Toolkit (SteamTools) accelerates GitHub through a local reverse proxy, and that proxy
# presents a SELF-SIGNED LEAF certificate for github.com:
#     CN=github.com   issuer: CN=SteamTools Certificate, O=BeyondDimension, C=CN
# Git's schannel backend fails it with SEC_E_NO_CREDENTIALS; its openssl backend fails it with
# "unable to get local issuer certificate". Neither is a GitHub problem, and neither is fixed by
# touching the machine's trust store. What works is handing git exactly that one certificate:
#
#     git -c http.sslBackend=openssl -c http.sslCAInfo=<steamtools-ca.pem> ...
#
# The certificate is fetched from the live connection (nothing is copied out of the trust store),
# and it is used only for these commands - no global git config is modified.
#
# Authentication: an extraHeader carrying Basic auth. A Bearer header is refused by the proxy
# ("invalid credentials") even though the same token works against the GitHub API.
#
# Usage:
#   .\publish-restart.ps1                 # refresh the CA and push the current branch
#   .\publish-restart.ps1 -Token ghp_...  # same, with an explicit token
#   .\publish-restart.ps1 -RefreshCaOnly  # only re-fetch the certificate
#
# The token is never written to disk. Prefer setting it in the environment (DSH_GITHUB_TOKEN) or
# letting git prompt for it.
[CmdletBinding()]
param(
    [string]$Token = '',
    [string]$Repo = 'chenkui-luo/dsh-plugin-restart',
    [string]$Remote = 'origin',
    [string]$Branch = 'main',
    [switch]$RefreshCaOnly
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$pluginDir = Split-Path -Parent $here
$toolkitRoot = Split-Path -Parent (Split-Path -Parent $pluginDir)
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'package.json'))) {
    throw ("could not locate the plugin package from {0}" -f $here)
}
# Keep the fetched certificate OUT of the package: inside the toolkit it lives next to the other
# test-time artefacts, and a standalone checkout falls back to the temp directory.
$caDir = $(if (Test-Path -LiteralPath (Join-Path $toolkitRoot 'runtime-test')) {
        Join-Path $toolkitRoot 'runtime-test\certs'
    } else {
        Join-Path $env:TEMP 'dsh-github-certs'
    })
if (-not (Test-Path -LiteralPath $caDir)) { New-Item -ItemType Directory -Path $caDir -Force | Out-Null }
$caFile = Join-Path $caDir 'steamtools-ca.pem'

if ([string]::IsNullOrWhiteSpace($Token)) { $Token = $env:DSH_GITHUB_TOKEN }

# ---- refresh the certificate ------------------------------------------------------------------
$fetcher = @'
const fs = require('node:fs')
const tls = require('node:tls')
const { X509Certificate } = require('node:crypto')
const socket = tls.connect({ host: 'github.com', port: 443, servername: 'github.com', rejectUnauthorized: false }, () => {
  const peer = socket.getPeerCertificate(true)
  const top = peer.issuerCertificate && peer.issuerCertificate.fingerprint !== peer.fingerprint ? peer.issuerCertificate : peer
  const cert = new X509Certificate(top.raw)
  fs.writeFileSync(process.argv[2], cert.toString(), 'utf8')
  console.log('  certificate: subject=' + JSON.stringify(cert.subject) + ' issuer=' + JSON.stringify(cert.issuer) + ' validTo=' + cert.validTo)
  socket.end()
})
socket.on('error', (error) => { console.log('  could not fetch the certificate: ' + error.message); process.exit(1) })
'@
$fetcherPath = Join-Path $env:TEMP 'dsh-fetch-gh-cert.cjs'
[System.IO.File]::WriteAllText($fetcherPath, $fetcher, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '=== github TLS certificate ===' -ForegroundColor Cyan
& node $fetcherPath $caFile
if (-not (Test-Path -LiteralPath $caFile)) { throw "no certificate written to $caFile" }
if ($RefreshCaOnly) { Write-Host ("refreshed: {0}" -f $caFile); exit 0 }

# ---- push --------------------------------------------------------------------------------------
Write-Host '=== push ===' -ForegroundColor Cyan
Push-Location $pluginDir
try {
    $gitArgs = @('-c', 'http.sslBackend=openssl', '-c', "http.sslCAInfo=$caFile")
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
        $gitArgs += @('-c', "http.extraHeader=Authorization: Basic $basic")
    } else {
        Write-Host '  (no token supplied - git will prompt, or use a credential helper)'
    }
    $gitArgs += @('push', $Remote, "HEAD:$Branch")
    Write-Host ("  git {0}" -f ($gitArgs -join ' '))
    & git @gitArgs 2>&1 | ForEach-Object {
        $line = [string]$_
        if (-not [string]::IsNullOrWhiteSpace($Token)) {
            $line = $line.Replace($Token, 'ghp_***').Replace($basic, 'BASIC_***')
        }
        Write-Host ("  {0}" -f $line)
    }
    if ($LASTEXITCODE -ne 0) { throw ("git push exited with {0}" -f $LASTEXITCODE) }
    Write-Host ''
    Write-Host ("pushed to https://github.com/{0}" -f $Repo) -ForegroundColor Green
} finally {
    Pop-Location
    Remove-Item -LiteralPath $fetcherPath -Force -ErrorAction SilentlyContinue
}
