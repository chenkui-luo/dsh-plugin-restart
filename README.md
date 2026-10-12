# dsh-plugin-restart

[中文](README.zh.md) | English

A **Restart** button inside DeepSeek Harness Settings. One click replaces the `dsh web` process
that is serving your page, and the page reconnects by itself — no terminal, no re-opening the
desktop icon.

Useful after changing a plugin's host half, editing `config.json`, or when you want the in-memory
state of a session gone.

```
Settings -> Restart -> [Restart server]
   |  POST /dsh-restart/restart        (same-origin, authenticated)
   v
host half (lib/index.js)  --- starts a detached helper, answers the HTTP request, exits itself
   v
helper (generated per restart)
   1. waits for the port to stop accepting connections
   2. asks your launcher to bring the harness back up
   3. verifies the replacement really came up (launcher token file)
   4. confirms the old process is gone; writes a diagnosis if anything failed
   v
new dsh web process  ->  the page sees a new instanceId and reloads itself
```

## Install

**As a profile bundle** (the usual way, needs the `dsh` CLI with pnpm available):

```sh
dsh plugin --profile web add dsh-plugin-restart
```

**Without pnpm** (what this plugin's own installer does, and what a profile patched by hand can
use): copy the package into `<profile>/node_modules/dsh-plugin-restart` and add this row to the
profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: restart
      name: 'dsh-plugin-restart'
```

The bundled installer does both steps, with a backup and a read-back check before it writes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-RestartPlugin.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-RestartPlugin.ps1 -Action disable
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-RestartPlugin.ps1 -Action uninstall
```

Then **refresh the page** and open Settings -> Restart. Host-half changes need one restart to take
effect (Node caches imported ES modules) — and after this plugin is installed, that restart can be
done with this very button.

## Requirements

The restart delegates to the launcher a hosted install already has
(`%LOCALAPPDATA%\DeepSeekHarness\Launch-DeepSeekHarness.ps1`), which owns the reliable
stop/start/readiness sequence. When it is missing, the button answers with a clear error instead of
pretending to work, and the status card shows the path it looked for.

Windows-focused: the helper's console handling and the process stop/start behaviour are built for
it.

Point the plugin at another launcher with `DSH_RESTART_LAUNCHER` (plus `DSH_RESTART_INSTALL_DIR`
and `DSH_RESTART_DATA`) if your install keeps its files elsewhere.

## Why the helper is a detached **node** process

Measured on a real machine (reproducible with the probe in the toolkit this plugin came from):

| how the helper is started | does it run | does it outlive its parent |
| --- | --- | --- |
| PowerShell, `detached: true` | **no** (exits 0, silently) | — |
| PowerShell, attached | yes | no (dies with the parent) |
| **node, `detached: true`** | yes | **yes** |
| node, attached | yes | no |

On Windows a "detached" PowerShell child gets no console and never runs the script — the same trap
[dsh-market](https://github.com/dsh-market/dsh-market) documents. An attached helper dies together
with the process it is supposed to replace. So: a detached node helper, which then gives its own
children a hidden console through `powershell -WindowStyle Hidden`.

The old process is stopped last, and *by itself*: the helper sends it `SIGTERM` only once the
replacement is up. Force-killing the whole tree is what leaves a Windows port unbindable long
enough for the replacement to die with `EADDRINUSE`.

## API

Every route passes the connection trust fence (loopback peer + matching `Origin` + login cookie),
so only an authenticated same-origin page reaches them.

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/dsh-restart/status` | `instanceId` (this server's pid), port, workspace, launcher path/availability, whether a restart is in flight |
| POST | `/dsh-restart/restart` | Arms a restart. A second request within 15 s gets 409. The response carries **no** launch token |
| GET | `/dsh-restart/log` | Tail of the shared restart log |

If the automatic reload comes back unauthenticated (a fresh launch token is minted on every start),
the page's own token is handed back to the *same* browser connection once, so the page can reopen
itself with `?token=…`.

## Logs

`%LOCALAPPDATA%\DeepSeekHarness\restart-plugin\logs\restart.log` — append-only, so the record of a
restart survives the process that performed it. The helper writes the launcher's exit code, whether
the port is still being served, and whether a fresh token file appeared, because the process that
would normally log a failure is the one that just exited.

## Safety

- Authenticated same-origin loopback only; proxy-forwarded requests are not honoured.
- No admin rights, no system configuration touched.
- It **interrupts a running conversation turn** — that is what a restart is, and the card says so.
- If the port is owned by a process the launcher does not recognise (e.g. a `dsh web` you started by
  hand), the restart takes that port over, including its terminal's process tree.

## License

MIT
