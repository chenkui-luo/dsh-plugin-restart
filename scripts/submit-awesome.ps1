# submit-awesome.ps1 - submit plugin\dsh-plugin-restart to the awesome-dsh-plugin list.
#
# Two entry points exist for community plugins, and they have different rules:
#
#   dsh-marketplace  (ydhrdh/dsh-marketplace)      one registry/plugins/<id>/plugin.json + PR   <- already submitted
#   awesome-dsh-plugin (awesome-dsh-plugin/...)    one data/plugins/<owner>__<repo>.yml + PR
#
# The list generates its README from those YAML files, so a submission never edits the big README.
# It also has a hard precondition that cannot be worked around: THE REPO MUST BE AT LEAST ONE DAY
# OLD, and CI checks it on every PR. This script therefore refuses to submit before that, instead
# of opening a PR that is guaranteed to be closed.
#
# Usage:
#   .\submit-awesome.ps1                       # checks the age, then submits when allowed
#   .\submit-awesome.ps1 -CheckOnly            # just report readiness
#   .\submit-awesome.ps1 -Force                # submit even inside the 24h window (expect a refusal)
#   .\submit-awesome.ps1 -Token ghp_...        # or set DSH_GITHUB_TOKEN
#
# Needs: git, node, network to github.com (see publish-restart.ps1 for the certificate note).
[CmdletBinding()]
param(
    [string]$Token = '',
    [string]$Owner = 'chenkui-luo',
    [string]$Repo = 'dsh-plugin-restart',
    [string]$Upstream = 'awesome-dsh-plugin/awesome-dsh-plugin',
    [string]$BaseBranch = 'main',
    [string]$Category = 'dev',
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$toolkitRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$workRoot = Join-Path $toolkitRoot 'runtime-test\market-submit'
$entryFile = Join-Path $workRoot ("awesome\{0}__{1}.yml" -f 'chenkui-luo', 'dsh-plugin-restart')
$caDir = Join-Path $toolkitRoot 'runtime-test\certs'
$caFile = Join-Path $caDir 'steamtools-ca.pem'

if ([string]::IsNullOrWhiteSpace($Token)) { $Token = $env:DSH_GITHUB_TOKEN }

# ---- the certificate github.com is served with on this machine --------------------------------
# Same story as publish-restart.ps1: a local accelerator answers for github.com with a self-signed
# leaf certificate, which git refuses. Fetch it and use it for these commands only.
if (-not (Test-Path -LiteralPath $caDir)) { New-Item -ItemType Directory -Path $caDir -Force | Out-Null }
$fetch = @'
const fs = require('node:fs'); const tls = require('node:tls'); const { X509Certificate } = require('node:crypto')
const s = tls.connect({ host: 'github.com', port: 443, servername: 'github.com', rejectUnauthorized: false }, () => {
  const p = s.getPeerCertificate(true)
  const top = p.issuerCertificate && p.issuerCertificate.fingerprint !== p.fingerprint ? p.issuerCertificate : p
  fs.writeFileSync(process.argv[2], new X509Certificate(top.raw).toString(), 'utf8')
  console.log('  certificate refreshed')
  s.end()
})
s.on('error', (e) => { console.log('  certificate fetch failed: ' + e.message); process.exit(1) })
'@
$fetchPath = Join-Path $env:TEMP 'dsh-fetch-gh-cert.cjs'
[System.IO.File]::WriteAllText($fetchPath, $fetch, (New-Object System.Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath $caFile)) { & node $fetchPath $caFile }

# ---- readiness report -------------------------------------------------------------------------
$nodeScript = @'
const tok = process.env.DSH_GH_TOKEN || ''
const H = { 'user-agent': 'dsh-submit', accept: 'application/vnd.github+json' }
if (tok) H.authorization = 'Bearer ' + tok
const [owner, repo] = [process.argv[2], process.argv[3]]
const upstream = process.argv[4]
;(async () => {
  const info = await (await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: H })).json()
  const ageHours = (Date.now() - new Date(info.created_at).getTime()) / 3600000
  console.log('  repo       :', info.full_name, '| private:', info.private, '| created:', info.created_at)
  console.log('  age        :', ageHours.toFixed(1), 'h', (ageHours >= 24 ? '(old enough)' : '(TOO NEW - list requires 24h)'))
  console.log('  topics     :', JSON.stringify(info.topics))
  console.log('  dsh-plugin topic set :', Array.isArray(info.topics) && info.topics.includes('dsh-plugin'))
  console.log('  default branch       :', info.default_branch)
  const pkgRaw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${info.default_branch}/package.json`, { headers: H })
  // raw.githubusercontent is not reachable through this machine's accelerator; use the API instead
  const pkgRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/package.json`, { headers: { ...H, accept: 'application/vnd.github.raw' } })
  const pkg = pkgRes.status === 200 ? JSON.parse(await pkgRes.text()) : null
  console.log('  dsh.bundle :', pkg && pkg.dsh && pkg.dsh.bundle ? JSON.stringify(pkg.dsh.bundle) : 'MISSING (list requires it)')
  const patchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/cordis.patch.yml`, { headers: { ...H, accept: 'application/vnd.github.raw' } })
  console.log('  cordis.patch.yml     :', patchRes.status === 200 ? 'present' : 'MISSING')
  const hasPatch = patchRes.status === 200
  const up = await (await fetch(`https://api.github.com/repos/${upstream}`, { headers: H })).json()
  console.log('  upstream   :', up.full_name, '| writable directly:', JSON.stringify(up.permissions))
  console.log('  READY      :', (ageHours >= 24 && Array.isArray(info.topics) && info.topics.includes('dsh-plugin') && pkg && pkg.dsh && pkg.dsh.bundle && hasPatch) ? 'YES' : 'NOT YET')
})().catch((e) => console.log('  FAILED:', e.cause?.code || e.message))
'@
$checkPath = Join-Path $env:TEMP 'dsh-awesome-check.cjs'
[System.IO.File]::WriteAllText($checkPath, $nodeScript, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '=== readiness for the awesome list ===' -ForegroundColor Cyan
$env:DSH_GH_TOKEN = $Token
& node --use-system-ca $checkPath $Owner $Repo $Upstream
Remove-Item Env:DSH_GH_TOKEN -ErrorAction SilentlyContinue

if ($CheckOnly) { exit 0 }

# ---- gate on the one hard rule -----------------------------------------------------------------
$ageProbe = @'
const H = { 'user-agent': 'dsh-submit', accept: 'application/vnd.github+json' }
;(async () => {
  const i = await (await fetch('https://api.github.com/repos/' + process.argv[2] + '/' + process.argv[3], { headers: H })).json()
  console.log(((Date.now() - new Date(i.created_at).getTime()) / 3600000).toFixed(1))
})()
'@
$agePath = Join-Path $env:TEMP 'dsh-age.cjs'
[System.IO.File]::WriteAllText($agePath, $ageProbe, (New-Object System.Text.UTF8Encoding($false)))
$ageHours = [double](& node --use-system-ca $agePath $Owner $Repo)
if ($ageHours -lt 24 -and -not $Force) {
    Write-Host ''
    Write-Host ("BLOCKED: the repository is {0:N1} h old; the list requires 24 h and checks it in CI." -f $ageHours) -ForegroundColor Yellow
    Write-Host ("Re-run this script after {0}" -f (Get-Date).AddHours(24 - $ageHours).ToString('yyyy-MM-dd HH:mm'))
    exit 2
}

if ([string]::IsNullOrWhiteSpace($Token)) { throw 'a GitHub token is required to fork and push (-Token or DSH_GITHUB_TOKEN)' }

# ---- fork, clone, add the entry, push, open the PR ---------------------------------------------
if (-not (Test-Path -LiteralPath $entryFile)) { throw ("entry file not found: {0}" -f $entryFile) }
$upstreamName = ($Upstream -split '/')[1]
$forkFull = "$Owner/$upstreamName"
$cloneDir = Join-Path $workRoot "awesome-fork"

$env:DSH_GH_TOKEN = $Token
$forkScript = @'
const H = { 'user-agent': 'dsh-submit', accept: 'application/vnd.github+json', authorization: 'Bearer ' + process.env.DSH_GH_TOKEN, 'content-type': 'application/json' }
;(async () => {
  const r = await fetch('https://api.github.com/repos/' + process.argv[2] + '/forks', { method: 'POST', headers: H, body: JSON.stringify({ default_branch_only: true }) })
  const j = await r.json()
  console.log('  fork:', r.status, j.full_name ?? j.message)
})()
'@
$forkPath = Join-Path $env:TEMP 'dsh-awesome-fork.cjs'
[System.IO.File]::WriteAllText($forkPath, $forkScript, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '=== fork ===' -ForegroundColor Cyan
& node --use-system-ca $forkPath $Upstream

if (Test-Path -LiteralPath $cloneDir) { Remove-Item -LiteralPath $cloneDir -Recurse -Force }
& git -c http.sslBackend=openssl -c "http.sslCAInfo=$caFile" clone --quiet --depth 1 --branch $BaseBranch "https://github.com/$forkFull.git" $cloneDir
if ($LASTEXITCODE -ne 0) { throw 'clone of the fork failed' }

Set-Location -LiteralPath $cloneDir
& git checkout --quiet -b "add/$Repo"
$targetDir = Join-Path $cloneDir 'data\plugins'
if (-not (Test-Path -LiteralPath $targetDir)) { throw ("unexpected layout: no data\plugins in {0}" -f $cloneDir) }
$targetName = "{0}__{1}.yml" -f $Owner, $Repo
Copy-Item -LiteralPath $entryFile -Destination (Join-Path $targetDir $targetName) -Force
Write-Host ("  added data/plugins/{0}" -f $targetName)

& git -c user.name=$Owner -c user.email='noreply@github.com' add -A
& git -c user.name=$Owner -c user.email='noreply@github.com' commit --quiet -m ("Add {0}/{1} to the list" -f $Owner, $Repo)

$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
& git -c http.sslBackend=openssl -c "http.sslCAInfo=$caFile" -c "http.extraHeader=Authorization: Basic $b64" push --quiet --no-progress origin HEAD
if ($LASTEXITCODE -ne 0) { throw 'push to the fork failed' }

$prScript = @'
const fs = require('node:fs')
const H = { 'user-agent': 'dsh-submit', accept: 'application/vnd.github+json', authorization: 'Bearer ' + process.env.DSH_GH_TOKEN, 'content-type': 'application/json' }
;(async () => {
  const body = [
    'Adds **' + process.argv[4] + '** to the list.',
    '',
    'A Restart card in DSH Settings: one click replaces the `dsh web` process serving the page and reconnects the page by itself, for host-half plugin changes or config edits that cannot hot-reload.',
    '',
    '- Repository: https://github.com/' + process.argv[4],
    '- Declares `dsh.bundle` (`./cordis.patch.yml`) and ships `cordis.patch.yml` at the repo root',
    '- Carries the `dsh-plugin` topic',
    '- Repository age at submission: ' + process.argv[5] + ' h',
    '',
    'Windows-first: the helper\'s console handling and the stop/start sequence are built for it. It delegates the restart to the launcher a hosted install already has, and reports a clear error instead of pretending to work when that launcher is absent.'
  ].join('\n')
  const r = await fetch('https://api.github.com/repos/' + process.argv[2] + '/pulls', {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: 'Add ' + process.argv[4] + ' to the list', head: process.argv[3] + ':add/' + process.argv[6], base: 'main', body, maintainer_can_modify: true })
  })
  const j = await r.json()
  console.log('  PR:', r.status, j.html_url ?? j.message)
})()
'@
$prPath = Join-Path $env:TEMP 'dsh-awesome-pr.cjs'
[System.IO.File]::WriteAllText($prPath, $prScript, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '=== pull request ===' -ForegroundColor Cyan
& node --use-system-ca $prPath $Upstream $Owner "$Owner/$Repo" $ageHours $Repo

Remove-Item Env:DSH_GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $fetchPath,$checkPath,$agePath,$forkPath,$prPath -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'done.' -ForegroundColor Green
