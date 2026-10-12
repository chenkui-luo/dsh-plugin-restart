/**
 * dsh-plugin-restart — browser half.
 *
 * Contributes a Settings page ("重启" / "Restart") whose button restarts the
 * `dsh web` process serving this page, then reconnects the page by itself.
 *
 * Bundle format follows dsh-plugin-app-icon: the DSH kernel loads client plugins
 * through `window.__ModuleLoader__.load` with a lazy CommonJS-shaped factory, so
 * this is a classic script. Only `react` is required (a platform seed module) and
 * the page draws itself with `React.createElement` + inline styles — no bundler,
 * no CSS pipeline, no cross-plugin value imports.
 *
 * The reconnect dance, in order:
 *   1. POST /dsh-restart/restart — the host arms a detached helper and answers
 *      *before* the port goes away, so this fetch resolves cleanly.
 *   2. Poll /dsh-restart/status once a second. While the server is down the fetch
 *      rejects; that is expected, not an error.
 *   3. When the status answers again with a *different* instanceId, the successor
 *      process is live. Reload.
 *   4. If the reload comes back unauthenticated (the per-launch token changed and
 *      this browser had no session cookie), the successor server hands this
 *      connection the page's own token back, and we re-navigate with `?token=…`.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-restart',
	factory: (require) => {
		const React = require('react')
		const exports = {}

		/** Settings namespace / locale namespace for this page. */
		const NS = 'restart'

		const API = {
			status: '/dsh-restart/status',
			restart: '/dsh-restart/restart'
		}

		/** Where the page keeps the token it was opened with, so a failed reload can retry it. */
		const TOKEN_KEY = 'dsh-restart:page-token'

		/** How long to keep waiting for the successor process before telling the user. */
		const WAIT_LIMIT_MS = 90000
		/** Poll cadence while waiting: the successor normally answers within a few seconds. */
		const POLL_MS = 800
		/** How long to wait for the status route to answer at all before showing "unavailable". */
		const FIRST_STATUS_MS = 15000

		const zh = {
			nav: '重启',
			title: '重启',
			cardTitle: '重启 DeepSeek Harness',
			cardDesc: '结束后台服务进程并立刻用同一份配置重新拉起——和双击桌面图标重启是同一件事（只是不新开窗口）。改了插件、配置或需要清掉内存状态时用它。',
			noticeStrong: '点下去会中断当前正在跑的对话回合。',
			noticeRest: '页面会在新服务就绪后自动刷新并重新连上；如果卡在「等待服务回来」，用下面的按钮手动重开。',
			run: '重启服务',
			running: '重启中…',
			phaseRestarting: '正在重启服务…',
			phaseStarting: '服务正在启动…',
			phaseConnecting: '正在重新连接…',
			phaseReloading: '已连上新服务，正在刷新页面…',
			phaseStuck: '等了一会儿还没等到新服务回来。可以看看日志，或手动重开页面。',
			phaseStuckNoLauncher: '找不到启动器脚本，无法自动重启。请手动关掉 dsh web，再双击桌面图标打开。',
			phaseFailed: '重启请求没有被接受。',
			phaseDone: '已连接到重新启动后的服务。',
			openSite: '重新打开登录链接',
			reloadPage: '刷新页面',
			retry: '重试',
			loading: '读取当前实例…',
			unavailable: '暂时读不到服务状态。',
			noInstance: '（页面没有带令牌打开，读取不到实例信息）',
			details: '当前实例',
			port: '端口',
			hostPid: 'host pid',
			dshPid: 'dsh pid',
			since: '启动于',
			workspace: '工作目录',
			baseUrl: '裸地址',
			launcher: '启动器',
			missing: '（缺失）',
			found: '（已就绪）',
			unknown: '未知',
			recovery: '页面重新连上时认不出登录状态，可以带着原令牌重开一次。',
			recoveryHint: '（正常情况下用不到；自动刷新失败时再点）'
		}

		const en = {
			nav: 'Restart',
			title: 'Restart',
			cardTitle: 'Restart DeepSeek Harness',
			cardDesc: 'Stops the background server process and immediately starts it again with the same configuration — the same thing the desktop icon does, without opening a new window. Use it after changing plugins or config, or to clear in-memory state.',
			noticeStrong: 'Clicking this interrupts any conversation turn that is currently running.',
			noticeRest: 'The page reloads and reconnects by itself once the new server is ready; if it stays on "waiting for the server", reopen it with the button below.',
			run: 'Restart server',
			running: 'Restarting…',
			phaseRestarting: 'Restarting the server…',
			phaseStarting: 'The server is starting…',
			phaseConnecting: 'Reconnecting…',
			phaseReloading: 'The new server answered; reloading the page…',
			phaseStuck: 'The new server did not come back in time. Check the log, or reopen the page manually.',
			phaseStuckNoLauncher: 'The launcher script was not found, so the restart cannot run automatically. Close dsh web yourself and reopen it from the desktop icon.',
			phaseFailed: 'The restart request was not accepted.',
			phaseDone: 'Connected to the restarted server.',
			openSite: 'Reopen the login link',
			reloadPage: 'Reload page',
			retry: 'Try again',
			loading: 'Reading the current instance…',
			unavailable: 'Service status is unavailable right now.',
			noInstance: '(the page was opened without a token, so instance details are unavailable)',
			details: 'Current instance',
			port: 'Port',
			hostPid: 'host pid',
			dshPid: 'dsh pid',
			since: 'Started',
			workspace: 'Workspace',
			baseUrl: 'Plain URL',
			launcher: 'Launcher',
			missing: ' (missing)',
			found: ' (ready)',
			unknown: 'unknown',
			recovery: 'The page could not restore its session. You can reopen it once with its original token.',
			recoveryHint: ' (not normally needed — use it only if the automatic reload failed)'
		}

		const styles = {
			page: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px', maxWidth: '760px' },
			header: { display: 'flex', alignItems: 'center', gap: '12px' },
			title: { fontWeight: 600, fontSize: '15px' },
			hint: { fontSize: '12.5px', opacity: 0.72, lineHeight: 1.6 },
			card: {
				display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px',
				borderRadius: '12px', border: '1px solid var(--dsh-border, rgba(128,128,128,0.28))',
				background: 'var(--dsh-surface-subtle, rgba(128,128,128,0.06))'
			},
			cardTitle: { fontWeight: 600, fontSize: '14px' },
			row: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
			button: {
				font: 'inherit', fontSize: '12.5px', padding: '7px 15px', borderRadius: '8px', cursor: 'pointer',
				border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
				background: 'var(--dsh-surface, transparent)', color: 'inherit'
			},
			primary: { background: '#4D6BFE', borderColor: '#4D6BFE', color: '#fff', fontWeight: 600 },
			danger: { background: '#DC2626', borderColor: '#DC2626', color: '#fff', fontWeight: 600 },
			secondary: { fontSize: '12px', padding: '5px 12px' },
			disabled: { opacity: 0.55, cursor: 'default' },
			notice: { fontSize: '12.5px', lineHeight: 1.65, opacity: 0.85 },
			warn: {
				fontSize: '12.5px', lineHeight: 1.6, padding: '9px 11px', borderRadius: '8px',
				background: 'rgba(77,107,254,0.10)', border: '1px solid rgba(77,107,254,0.35)'
			},
			ok: { color: '#16a34a', fontSize: '12.5px' },
			err: { color: '#dc2626', fontSize: '12.5px' },
			small: { fontSize: '11.5px', opacity: 0.75, lineHeight: 1.75, wordBreak: 'break-word' },
			code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' }
		}

		function el (tag, props, ...children) { return React.createElement(tag, props, ...children) }

		/** GET/POST a JSON route of the host half; throws with the host's own message. */
		async function call (url, body) {
			const init = body === undefined
				? { method: 'GET', headers: { accept: 'application/json' } }
				: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
			const response = await fetch(url, init)
			let payload = null
			try { payload = await response.json() } catch { /* not JSON */ }
			if (payload === null) throw new Error('HTTP ' + response.status)
			if (payload.ok !== true) throw new Error(payload.error === undefined ? 'unknown error' : payload.error)
			return payload
		}

		/** The token this page was opened with, if any (the launcher and app windows always pass one). */
		function pageToken () {
			try {
				const at = new URLSearchParams(window.location.search).get('token')
				if (at !== null && at !== '') return at
				return window.sessionStorage.getItem(TOKEN_KEY)
			} catch {
				return null
			}
		}

		function rememberToken (token) {
			if (token === null || token === '') return
			try { window.sessionStorage.setItem(TOKEN_KEY, token) } catch { /* private mode */ }
		}

		function formatTime (value) {
			if (typeof value !== 'string' || value === '') return ''
			const at = new Date(value)
			if (Number.isNaN(at.getTime())) return value
			return at.toLocaleString()
		}

		function RestartPage (props) {
			const t = typeof props.t === 'function' ? props.t : null
			// Memoized on the translator: an unstable `tr` would re-create `check`
			// every render and turn the mount effect below into a self-feeding loop.
			const tr = React.useCallback((key, fallback) => {
				if (t === null) return fallback
				try {
					const value = t(key)
					return typeof value === 'string' && value !== key && value !== '' ? value : fallback
				} catch { return fallback }
			}, [t])

			const [status, setStatus] = React.useState(null)
			const [loadError, setLoadError] = React.useState(null)
			/** 'idle' | 'restarting' | 'waiting' | 'stuck' | 'failed' | 'done' */
			const [phase, setPhase] = React.useState('idle')
			const [phaseText, setPhaseText] = React.useState('')
			const [recoveryToken, setRecoveryToken] = React.useState(null)
			const [openHint, setOpenHint] = React.useState(false)

			/** Instance we came from; a different value means the successor is live. */
			const beforeRef = React.useRef(null)
			const deadlineRef = React.useRef(0)
			const timerRef = React.useRef(null)
			const busyRef = React.useRef(false)

			/** Poll the status route and settle the phase machine. Safe to call at any time. */
			const check = React.useCallback(async () => {
				try {
					const payload = await call(API.status)
					setStatus(payload)
					setLoadError(null)
					if (payload.restartToken) setRecoveryToken(payload.restartToken)
					if (!busyRef.current) return

					if (beforeRef.current === null) beforeRef.current = payload.instanceId
					const isNew = payload.instanceId !== null && payload.instanceId !== beforeRef.current
					if (!isNew) {
						// Still the process we started from: it is on its way out.
						setPhase('waiting')
						setPhaseText(tr('phaseStarting', 'The server is starting…'))
						return
					}

					// A different process answered, but the port may have been taken over by
					// something that is not a DSH host. Only reload onto a real status answer.
					if (payload.ok !== true) {
						setPhase('waiting')
						setPhaseText(tr('phaseConnecting', 'Reconnecting…'))
						return
					}

					setPhase('done')
					setPhaseText(tr('phaseReloading', 'The new server answered; reloading the page…'))
					busyRef.current = false
					if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null }
					window.setTimeout(() => { window.location.reload() }, 400)
				} catch (error) {
					const message = String((error && error.message) || error)
					// While the port is down the fetch rejects; that is the expected state, not a
					// failure. Only the deadline turns it into one.
					setStatus(null)
					setLoadError(message)
					if (!busyRef.current) return
					if (Date.now() > deadlineRef.current) {
						setPhase('stuck')
						setPhaseText('')
						return
					}
					setPhase('waiting')
					setPhaseText(tr('phaseConnecting', 'Reconnecting…'))
				}
			}, [tr])

			React.useEffect(() => {
				rememberToken(new URLSearchParams(window.location.search).get('token'))
				void check()
			}, [check])

			/** Reinstate an interrupted restart (e.g. the user switched sections mid-wait). */
			React.useEffect(() => {
				if (busyRef.current && timerRef.current === null) {
					timerRef.current = window.setInterval(() => { void check() }, POLL_MS)
				}
			}, [check])

			React.useEffect(() => () => {
				if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null }
			}, [])

			async function onRestart () {
				if (busyRef.current) return
				busyRef.current = true
				setPhase('restarting')
				setPhaseText(tr('phaseRestarting', 'Restarting the server…'))
				setRecoveryToken(null)
				beforeRef.current = status !== null && status.instanceId !== undefined ? status.instanceId : null
				deadlineRef.current = Date.now() + WAIT_LIMIT_MS

				// Start watching *before* the POST: the host answers first and then exits itself,
				// but a slow local machine can still close the connection mid-response — and the
				// restart is already armed at that point, so the wait must not be skipped.
				if (timerRef.current === null) {
					timerRef.current = window.setInterval(() => { void check() }, POLL_MS)
				}

				try {
					await call(API.restart, { token: pageToken() })
				} catch (error) {
					const message = String((error && error.message) || error)
					// A refused restart is the only outcome worth reporting as a failure; a
					// connection error means the port is already gone, which is the normal path.
					if (!/^HTTP 5/.test(message) && message !== 'unknown error' && /^HTTP 4/.test(message)) {
						busyRef.current = false
						if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null }
						setPhase('failed')
						setPhaseText(message)
						return
					}
					setPhase('waiting')
					setPhaseText(tr('phaseConnecting', 'Reconnecting…'))
				}

				void check()
			}

			const launcherAvailable = status !== null && status.launcherAvailable === true
			const instance = status !== null ? status : null
			const busy = phase === 'restarting' || phase === 'waiting'
			const buttonStyle = Object.assign(
				{},
				styles.button,
				busy || phase === 'done' ? styles.danger : styles.primary,
				phase === 'failed' || phase === 'stuck' ? styles.disabled : null
			)

			const statusLine = phaseText !== '' ? phaseText : (
				phase === 'stuck'
					? tr('phaseStuck', 'The new server did not come back in time. Check the log, or reopen the page manually.')
					: phase === 'done'
						? tr('phaseDone', 'Connected to the restarted server.')
						: phase === 'failed'
							? tr('phaseFailed', 'The restart request was not accepted.')
							: ''
			)

			const detailRows = []
			if (instance !== null) {
				if (instance.port > 0) detailRows.push(el('span', { key: 'port' }, `${tr('port', 'Port')} ${instance.port}`))
				if (instance.hostPid > 0) detailRows.push(el('span', { key: 'host' }, `host pid ${instance.hostPid}`))
				if (instance.dshPid > 0) detailRows.push(el('span', { key: 'dsh' }, `dsh pid ${instance.dshPid}`))
				if (instance.startedAt) detailRows.push(el('span', { key: 'since' }, `${tr('since', 'Started')} ${formatTime(instance.startedAt)}`))
				if (instance.workspace) detailRows.push(el('div', { key: 'ws' }, `${tr('workspace', 'Workspace')}: ${instance.workspace}`))
				if (instance.launcherPath) {
					detailRows.push(el('div', { key: 'launcher' },
						`${tr('launcher', 'Launcher')}: ${instance.launcherPath}${launcherAvailable ? tr('found', ' (ready)') : tr('missing', ' (missing)')}`))
				}
			}

			const actions = el('div', { style: styles.row },
				el('button', {
					type: 'button',
					style: buttonStyle,
					disabled: busy || phase === 'failed',
					onClick: () => { void onRestart() }
				}, busy ? tr('running', 'Restarting…') : phase === 'failed' ? tr('retry', 'Try again') : tr('run', 'Restart server')),
				el('button', {
					type: 'button',
					style: Object.assign({}, styles.button, styles.secondary),
					disabled: busy,
					onClick: () => { window.location.reload() }
				}, tr('reloadPage', 'Reload page')),
				recoveryToken !== null && recoveryToken !== ''
					? el('button', {
						type: 'button',
						style: Object.assign({}, styles.button, styles.secondary),
						onClick: () => {
							window.location.href = `${window.location.origin}/?token=${encodeURIComponent(recoveryToken)}`
						}
					}, tr('openSite', 'Reopen the login link'))
					: null
			)

			return el('div', { style: styles.page },
				el('div', { style: styles.header },
					el('div', null,
						el('div', { style: styles.title }, tr('title', 'Restart')),
						el('div', { style: styles.hint }, tr('cardDesc', 'Stops the background server process and immediately starts it again with the same configuration.'))
					)
				),
				el('div', { style: styles.card },
					el('div', { style: styles.cardTitle }, tr('cardTitle', 'Restart DeepSeek Harness')),
					el('div', { style: styles.notice },
						el('strong', null, tr('noticeStrong', 'Clicking this interrupts any conversation turn that is currently running.')),
						el('span', null, ' ' + tr('noticeRest', 'The page reloads and reconnects by itself once the new server is ready.'))
					),
					actions,
					statusLine !== ''
						? el('div', { style: phase === 'failed' ? styles.err : (phase === 'done' ? styles.ok : styles.warn) }, statusLine)
						: null,
					!launcherAvailable && instance !== null
						? el('div', { style: styles.err }, tr('phaseStuckNoLauncher', 'The launcher script was not found, so the restart cannot run automatically.'))
						: null,
					recoveryToken !== null && recoveryToken !== ''
						? el('div', { style: styles.warn },
							tr('recovery', 'The page could not restore its session. You can reopen it once with its original token.'),
							el('span', { style: styles.small }, tr('recoveryHint', ' (not normally needed)')))
						: null
				),
				el('div', { style: styles.hint }, tr('details', 'Current instance')),
				el('div', { style: Object.assign({}, styles.small, styles.row) },
					instance === null
						? el('span', null, loadError !== null ? tr('unavailable', 'Service status is unavailable right now.') + ' ' + loadError : tr('loading', 'Reading the current instance…'))
						: (detailRows.length > 0 ? detailRows : el('span', null, tr('noInstance', '(the page was opened without a token)')))
				)
			)
		}

		/** Register the dictionary and the Settings page. */
		function apply (ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'restart: dictionaries')
			const t = ctx.locale.bind(NS)
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'restart',
				order: 900,
				label: () => t('nav'),
				locale: NS
			}, RestartPage))
		}

		exports.inject = ['slots', 'locale']
		exports.apply = apply
		return exports
	}
})
