/**
 * dsh-plugin-restart — host half.
 *
 * Adds a "重启" card to DSH Settings whose button replaces the `dsh web` process serving the
 * page, and lets the page reconnect by itself.
 *
 * Background, and why this looks the way it does (verified on this machine — see
 * runtime-test\ProbeDetachedSpawn.mjs):
 *
 *   * A process cannot restart itself in place, so the work is handed to a helper that outlives
 *     it. The helper is started as a **node** process, `stdio: 'ignore'`, unref'd.
 *   * On Windows a `detached` PowerShell child that was asked to run a script exited with code 0
 *     *without executing anything*: the same script ran fine when not detached, and it ran fine
 *     as a detached *node* process. That is the trap dsh-market documents ("on Windows a
 *     `detached` spawn maps to DETACHED_PROCESS — the new host gets NO console"), and the reason
 *     this helper is node and is not detached.
 *   * The helper does not raise the replacement itself: it waits for the port to go quiet, then
 *     delegates to the user's launcher, which already implements "make sure a hosted instance is
 *     running" plus the token-file handshake. Because the old process exits on its own, the
 *     launcher's ordinary "port is free → start a managed instance" path applies.
 *   * The old process exits *itself*, gracefully, right after the answer is on the wire — the
 *     market's `process.kill(pid, 'SIGTERM')`. Force-killing the whole tree is what leaves the
 *     port unavailable long enough for the replacement to die with EADDRINUSE.
 *
 * Routes live under /dsh-restart/ and every one passes the connection trust fence
 * (`ctx.connection.requestRejection`), so only an authenticated same-origin browser reaches them.
 *
 * @module dsh-plugin-restart
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/** Stable Cordis plugin name. */
export const name = 'dsh-restart'

/** Services this plugin needs before it can claim its routes. */
export const inject = ['webServer', 'connection']

/**
 * Route prefix owned by this plugin. No trailing slash: the webserver matches a
 * prefix as `pathname === prefix || pathname.startsWith(prefix + '/')`.
 */
const ROUTE_PREFIX = '/dsh-restart'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Where the launcher keeps its runtime state (and where we keep our own log). */
const INSTALL_DIR = process.env.DSH_RESTART_INSTALL_DIR !== undefined && process.env.DSH_RESTART_INSTALL_DIR !== ''
  ? process.env.DSH_RESTART_INSTALL_DIR
  : join(process.env.LOCALAPPDATA ?? process.env.HOME ?? tmpdir(), 'DeepSeekHarness')

/** Compose a plugin-private data directory next to (never inside) the launcher's own. */
const DATA_DIR = process.env.DSH_RESTART_DATA !== undefined && process.env.DSH_RESTART_DATA !== ''
  ? process.env.DSH_RESTART_DATA
  : join(INSTALL_DIR, 'restart-plugin')

const LOG_DIR = join(DATA_DIR, 'logs')
const LOG_FILE = join(LOG_DIR, 'restart.log')
/** The launcher only writes this when the fresh token is ready, so it is the readiness signal. */
const URL_FILE = join(INSTALL_DIR, 'server-url.json')
const STATE_FILE = join(INSTALL_DIR, 'state.json')

/**
 * The script the restart delegates to. Overridable so a test (or a portable install that keeps
 * its launcher elsewhere) can point at a different one; the default is the launcher this plugin
 * was built for.
 */
const LAUNCHER = process.env.DSH_RESTART_LAUNCHER !== undefined && process.env.DSH_RESTART_LAUNCHER !== ''
  ? process.env.DSH_RESTART_LAUNCHER
  : join(INSTALL_DIR, 'Launch-DeepSeekHarness.ps1')

/** The acceptance window: a second restart request inside it is refused. */
const ARM_GUARD_MS = 15000
/** How long the old process stays alive after arming, so the HTTP answer lands first. */
const EXIT_DELAY_MS = 700
/** Only this much of the (append-only) log is ever read back. */
const LOG_TAIL_BYTES = 64 * 1024

/** Wall-clock stamp of the last accepted restart. */
let lastArmAt = 0

function readJsonFile (path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic (path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** Append to the shared restart log; never throws (logging must not break a route). */
function appendLine (text) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch { /* ignore */ }
}

/** The tail of the shared log, so no endpoint can return an unbounded body. */
function readLogTail () {
  try {
    if (!existsSync(LOG_FILE)) return ''
    const raw = readFileSync(LOG_FILE, 'utf8')
    return raw.length <= LOG_TAIL_BYTES ? raw : raw.slice(raw.length - LOG_TAIL_BYTES)
  } catch {
    return ''
  }
}

/** Absolute path of powershell.exe. */
function powershellExe () {
  const win = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/** Absolute node.exe of the runtime we are already running inside. */
function nodeExe () {
  return process.execPath
}

/** True when a pid is alive (Windows has no signal 0, but this form works there). */
function isProcessAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && error.code === 'EPERM'
  }
}

/**
 * Which launcher mode to ask for.
 *
 * In this design the old process exits before the launcher runs, so the port is usually free and
 * the launcher's ordinary "start a managed instance" path applies. `-TakeOver` is requested when
 * something *else* is still serving the port, because only a takeover can reclaim that.
 */
function restartMode () {
  const record = readJsonFile(STATE_FILE) ?? readJsonFile(URL_FILE)
  if (record === null) return 'takeover'
  const dshPid = Number(record.dshPid ?? 0)
  if (dshPid === process.pid) return 'restart'
  if (dshPid > 0 && isProcessAlive(dshPid)) return 'restart'
  return 'takeover'
}

/**
 * The URL the page is being served from, as seen by the server.
 *
 * Used as an *identity* for "is this still the page that clicked?" — a reloaded page presents
 * the same connection only if its token is unchanged, so the identity is per-tab. The token
 * itself is never echoed by the restart response; it comes back only on this connection.
 */
function connectionKey (req) {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const token = url.searchParams.get('token')
    if (token === null || token === '') return null
    return String(token).slice(-12)
  } catch {
    return null
  }
}

/** Per-connection stash of the page's current token, kept across the restart. */
const RECOVERY_FILE = join(DATA_DIR, 'recovery.json')

/**
 * Remember the token the page is currently loaded with, keyed by the connection identity.
 *
 * `dsh web` mints a fresh launch token on every start. The browser normally re-authenticates
 * with its signed cookie (whose signing key persists in $DSH_HOME), but if that fails the page
 * would be stuck on a 401 — so the plugin holds the page's own token across the restart and
 * hands it back to the *same* browser connection on its next status poll.
 */
function stashRecoveryToken (key, token) {
  if (key === null || token === '') return
  writeJsonAtomic(RECOVERY_FILE, { key, token: String(token), at: new Date().toISOString() })
}

function takeRecoveryToken (key) {
  if (key === null) return null
  const record = readJsonFile(RECOVERY_FILE)
  if (record === null || record.key !== key) return null
  if (record.consumed === true) return null
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(RECOVERY_FILE, JSON.stringify({ ...record, consumed: true }, null, 2), 'utf8')
  } catch { /* best effort */ }
  return typeof record.token === 'string' && record.token !== '' ? record.token : null
}

/** Everything the settings card shows. Must never throw: a poll during downtime is normal. */
function statusPayload (req) {
  const record = readJsonFile(STATE_FILE)
  const state = record === null ? null : {
    port: Number(record.port ?? 0),
    workspace: typeof record.workspace === 'string' ? record.workspace : '',
    hostPid: Number(record.hostPid ?? record.pid ?? 0),
    dshPid: Number(record.dshPid ?? 0),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null
  }
  return {
    ok: true,
    // Identity the page compares before and after a click: the process id of this server is the
    // most direct answer to "am I still talking to the same process?".
    instanceId: String(process.pid),
    serverPid: process.pid,
    port: state === null ? 0 : state.port,
    workspace: state === null ? '' : state.workspace,
    hostPid: state === null ? 0 : state.hostPid,
    dshPid: state === null ? 0 : state.dshPid,
    startedAt: state === null ? null : state.startedAt,
    launcherPath: LAUNCHER,
    launcherAvailable: existsSync(LAUNCHER),
    restartInFlight: Date.now() - lastArmAt < ARM_GUARD_MS,
    restartToken: takeRecoveryToken(connectionKey(req))
  }
}

/**
 * The helper's source, written to disk and run as `node <file>`.
 *
 * It is a **node** process on purpose: on Windows a `detached` PowerShell child asked to run a
 * script exits with code 0 without running anything (verified here; dsh-market documents the
 * same class of problem), while a node process runs normally and can give its own children a
 * hidden console through `powershell -WindowStyle Hidden`.
 *
 * In order: wait for the port to stop accepting connections (checked by *connecting* — binding
 * to test would hold the very port the replacement needs), settle briefly for TIME_WAIT, hand
 * over to the launcher, verify the successor actually came up, and only then end the old process
 * gracefully. Every path substituted in is ASCII, because Windows PowerShell 5.1 parses its own
 * command line as ANSI.
 */
const HELPER_SOURCE = `
const { spawn: spawnChild } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')

const port = __PORT__
const launcher = __LAUNCHER__
const dataDir = __DATA_DIR__
const powershell = __POWERSHELL__
const logFile = __LOG_FILE__
const urlFile = __URL_FILE__
const oldPid = __OLD_PID__
const quitAfterMs = __QUIT_AFTER_MS__

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const note = (text) => {
  try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] [helper] ' + text + '\\n') } catch { /* ignore */ }
}

const listening = () => new Promise((resolve) => {
  const probe = net.connect({ host: '127.0.0.1', port })
  const done = (value) => { probe.destroy(); resolve(value) }
  probe.on('connect', () => done(true))
  probe.on('error', () => done(false))
  setTimeout(() => done(false), 500)
})

const readUrl = () => {
  try { return JSON.parse(fs.readFileSync(urlFile, 'utf8')).url } catch { return null }
}

const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

const main = async () => {
  note('helper started (old pid ' + oldPid + ')')

  const quietBy = Date.now() + 30000
  while (Date.now() < quietBy && await listening()) await sleep(250)
  if (await listening()) note('port ' + port + ' was still in use after 30s; starting anyway')
  else note('port ' + port + ' is quiet')
  await sleep(400)

  const knownUrl = readUrl()
  const startedAt = Date.now()
  note('invoking launcher ' + launcher)

  const command = '& ' + quote(powershell) + ' -NoProfile -ExecutionPolicy Bypass -File ' + quote(launcher) +
    ' -Port ' + port + ' -DataDir ' + quote(dataDir) + ' -NoBrowser -Quiet -Restart'
  let exitCode = null
  try {
    exitCode = await new Promise((resolve) => {
      const child = spawnChild(powershell, ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {
        detached: false,
        windowsHide: true,
        stdio: 'ignore'
      })
      child.on('error', (error) => { note('could not start the launcher: ' + (error && error.message ? error.message : error)); resolve(null) })
      child.on('exit', (code) => resolve(code))
    })
  } catch (error) {
    note('launcher threw: ' + (error && error.message ? error.message : error))
  }
  note('launcher finished with exit code ' + exitCode + ' after ' + Math.round((Date.now() - startedAt) / 1000) + 's')

  // Readiness: the launcher writes the token file only once the successor answers with one.
  const upBy = Date.now() + 30000
  let fresh = null
  while (Date.now() < upBy) {
    const current = readUrl()
    if (current !== null && current !== knownUrl) { fresh = current; break }
    await sleep(500)
  }
  if (fresh === null) {
    note('FAILED: no fresh token file, so the replacement never became ready (launcher exit ' + exitCode + ')')
    note('port is ' + (await listening() ? 'still serving' : 'quiet') + ' - see the launcher log beside this one')
  } else {
    note('replacement is ready: ' + fresh.replace(/token=[^&]+/, 'token=<redacted>'))
  }

  await sleep(quitAfterMs)
  note('stopping the old process ' + oldPid)
  try { process.kill(oldPid, 'SIGTERM') } catch (error) { note('old process was already gone: ' + error.message) }

  // Confirm rather than assume: the old process exiting is what frees the port, so its absence
  // is worth recording (the process may also have exited by itself before the signal).
  const goneBy = Date.now() + 10000
  let alive = true
  while (Date.now() < goneBy && alive) {
    try { process.kill(oldPid, 0); alive = true } catch { alive = false }
    if (alive) await sleep(200)
  }
  note(alive ? 'WARNING: the old process is still alive' : 'old process is gone')
  setTimeout(() => process.exit(0), 200)
}

main()
`

/** Fill the helper's placeholders and write it down: one file per restart, so crashes leave evidence. */
function writeHelper (values) {
  mkdirSync(DATA_DIR, { recursive: true })
  const path = join(DATA_DIR, `restart-helper-${process.pid}.cjs`)
  let source = HELPER_SOURCE
  for (const [token, value] of Object.entries(values)) {
    source = source.replaceAll(`__${token}__`, JSON.stringify(value))
  }
  writeFileSync(path, source, 'utf8')
  return path
}

/**
 * Exposed for runtime-test\CheckHelperScript.mjs: the helper is generated from a string constant,
 * so it is worth checking offline (placeholder substitution, Node parsing) rather than during a
 * restart.
 */
export function writeRestartHelper (overrides = {}) {
  return writeHelper({
    PORT: 3099,
    LAUNCHER,
    DATA_DIR: INSTALL_DIR,
    POWERSHELL: powershellExe(),
    LOG_FILE,
    URL_FILE,
    OLD_PID: process.pid,
    QUIT_AFTER_MS: EXIT_DELAY_MS,
    ...overrides
  })
}

/**
 * Arm a restart: write the helper, start it, then let this process exit so the port is free.
 * @param req - the accepted restart request (for the connection identity).
 * @param token - the page's current launch token, stashed for a possible re-login.
 * @returns the payload for the immediate HTTP answer.
 */
function armRestart (req, token) {
  if (!existsSync(LAUNCHER)) {
    throw new Error(`未找到启动器 ${LAUNCHER}，无法自动重启；请手动关掉 dsh web 再打开桌面图标。`)
  }

  const mode = restartMode()
  const port = currentPort()
  const helper = writeHelper({
    PORT: port,
    LAUNCHER,
    DATA_DIR: INSTALL_DIR,
    POWERSHELL: powershellExe(),
    LOG_FILE,
    URL_FILE,
    OLD_PID: process.pid,
    QUIT_AFTER_MS: EXIT_DELAY_MS
  })

  // Detached + ignored stdio + unref: the helper has to outlive the process it is about to
  // stop, and a child that shares this process' console/handles is taken down with it (that is
  // exactly what left an earlier revision with a helper that logged "helper started" and
  // nothing else). A detached *node* process does run here, unlike a detached PowerShell one —
  // see the module note.
  const child = spawn(nodeExe(), [helper], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  })
  child.on('error', (error) => appendLine(`helper could not be started: ${error.message}`))
  child.unref()

  appendLine(`restart armed: mode=${mode} helper pid=${child.pid} port=${port} oldPid=${process.pid}`)
  stashRecoveryToken(connectionKey(req), token)

  // Exit only after the answer is on the wire: killing the process mid-response would look like
  // a broken button in the browser instead of the restart it actually is.
  const timer = setTimeout(() => {
    appendLine('stopping this process so the port is free for the replacement')
    process.kill(process.pid, 'SIGTERM')
  }, EXIT_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()

  return { ok: true, armed: true, mode, port, instanceId: String(process.pid) }
}

/** The port this server actually listens on (falls back to the launcher's record). */
function currentPort () {
  const record = readJsonFile(STATE_FILE)
  const recorded = record === null ? 0 : Number(record.port ?? 0)
  if (recorded > 0) return recorded
  return 3099
}

/** Read a JSON request body with a hard ceiling. */
function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (error) { reject(new Error(`请求体不是合法 JSON：${error.message}`)) }
    })
  })
}

function sendJson (res, value, statusCode = 200) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(body.length) })
  res.end(body)
}

/**
 * Route dispatch: true when the request belonged to this plugin.
 * @param ctx - Cordis plugin context carrying the connection trust fence.
 * @param req - node request.
 * @param res - node response.
 */
async function handle (ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(ROUTE_PREFIX + '/')) return false

  // Trust fence: loopback/trusted Host, matching Origin, valid login cookie.
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) { res.statusCode = rejection; res.end(); return true }

  const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
  const method = (req.method ?? 'GET').toUpperCase()

  try {
    if (route === 'status' && method === 'GET') {
      sendJson(res, statusPayload(req))
      return true
    }

    if (route === 'restart' && method === 'POST') {
      const body = await readJsonBody(req)
      if (Date.now() - lastArmAt < ARM_GUARD_MS) {
        sendJson(res, { ok: false, error: '已经有一次重启正在进行，请稍候。' }, 409)
        return true
      }
      const payload = armRestart(req, typeof body.token === 'string' ? body.token : '')
      lastArmAt = Date.now()
      sendJson(res, payload)
      return true
    }

    if (route === 'log' && method === 'GET') {
      sendJson(res, { ok: true, log: readLogTail(), logFile: LOG_FILE })
      return true
    }

    sendJson(res, { ok: false, error: `未知接口：${method} ${url.pathname}` }, 404)
    return true
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return true
  }
}

/** Housekeeping at activation: mark the new generation, keep the last few helper scripts. */
function prepare () {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  // The recovery stash is deliberately kept: the successor writes the page's new token over it.
  pruneHelpers()
  appendLine(`host started (pid ${process.pid}, restart plugin active)`)
}

/** Keep the helper scripts of the last few generations — they are the only forensic record. */
function pruneHelpers () {
  try {
    const entries = readdirSync(DATA_DIR).filter((name) => /^restart-helper-\d+\.cjs$/.test(name))
    if (entries.length <= 5) return
    for (const name of entries.sort().slice(0, entries.length - 5)) {
      try { rmSync(join(DATA_DIR, name), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * Claim the plugin's routes on the host webserver.
 * @param ctx - Cordis plugin context carrying webServer + connection.
 */
export function apply (ctx) {
  prepare()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => { void handle(ctx, req, res) }
  }), 'restart: http routes')
}
