# dsh-plugin-restart

[English](README.md) | 中文

给 DSH Web GUI 的设置页加一个 **「重启」** 分区：点一下就把当前正在服务这个页面的 `dsh web`
进程换掉，页面自己重连回去。

改完宿主半插件、改过 `config.json`、或者需要清掉内存里的会话状态时用它，就不必再去关终端 / 双击桌面图标。

---

## 1. 它做了什么

```
设置页「重启」按钮（lib/client.js）
   │  POST /dsh-restart/restart       ← 同源请求（带登录 Cookie）
   ▼
宿主半（lib/index.js，Cordis 插件）
   │  ctx.connection.requestRejection() 信任围栏（本机 + 同源 + 登录态）
   │  写辅助脚本 → 分离启动它 → 立刻回答 HTTP → 700ms 后自己优雅退出
   ▼
辅助脚本（restart-helper-<pid>.cjs，每次重启重新生成）
   │  1. 等端口不再接受连接（用「连接」探测，不是「绑定」）
   │  2. 交给你的启动器：Launch-DeepSeekHarness.ps1 -Restart -Port <同一端口> -NoBrowser
   │  3. 核对 server-url.json 是否出现新的启动令牌（= 新实例真的起来了）
   │  4. 确认旧进程已退出；失败时把诊断写进日志
   ▼
启动器 → dsh-server-host.mjs → 新的 dsh web（新的启动令牌）
   ▼
页面轮询 /dsh-restart/status：instanceId 变了 → location.reload()
```

### 为什么辅助脚本是**分离的 node 进程**

这条是本机实测出来的，不是猜的（`runtime-test\ProbeDetachedSpawn.mjs` 可复现）：

| 启动方式 | 能跑 | 活过父进程退出 |
| --- | --- | --- |
| PowerShell `detached: true` | **否**（静默退出码 0） | — |
| PowerShell 附着 | 是 | 否（约 2 秒后随父进程死） |
| **node `detached: true`** | 是 | **是** |
| node 附着 | 是 | 否 |

也就是说：Windows 上被要求"分离"的 PowerShell 子进程**根本不会执行脚本**（就是 dsh-market
注释里记的那个坑：`detached` 映射到 DETACHED_PROCESS，新进程没有控制台），而附着的子进程会
跟着父进程一起死。所以辅助脚本必须**分离的 node**：它能跑，也能活到旧进程退出之后。

辅助脚本自己再拉子进程时用 `powershell -WindowStyle Hidden`，这样它下面的东西有隐藏控制台、
不会弹窗 —— 同样是 dsh-market 的做法。

### 为什么旧进程要**自己退出**

辅助脚本最后才 `process.kill(oldPid, 'SIGTERM')`，让 `dsh web` 自己优雅退出。旧进程一旦退出，
端口就空出来了，启动器走的是它最普通的那条路（"端口空闲 → 拉起托管实例"），不需要任何强杀。
强杀整棵进程树反而会让端口迟迟不能重绑，替换实例就会 `EADDRINUSE` 秒死。

---

## 2. 安装

```powershell
# 装进 $DSH_HOME\profiles\web
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\unity相关对话[ai]\启动DeepSeekHarness\plugin\dsh-plugin-restart\scripts\Install-RestartPlugin.ps1"
```

其他动作（都走同一个通用安装器 `scripts\Install-DshPlugin.ps1`）：

```powershell
... -File .\scripts\Install-RestartPlugin.ps1 -Action disable    # 保留文件，热停用
... -File .\scripts\Install-RestartPlugin.ps1 -Action enable
... -File .\scripts\Install-RestartPlugin.ps1 -Action uninstall  # 删包 + 删 patch 行
```

安装脚本会：把包放进 `<profile>\node_modules\`（含通用安装器的副本，装完仍能卸）、在
`<profile>\cordis.patch.yml` 写一个带标记的托管块（写前备份、写后回读校验、长度骤减自动回滚）、
**不动**其它插件的行。

**生效方式**：浏览器半随页面刷新生效；**宿主半的改动要重启一次才会加载**（Node 按 URL 缓存已
导入的模块）—— 这件事在这个插件装好之后，可以直接用这个按钮做。

---

## 3. 宿主半的接口

所有路由在 `/dsh-restart/*` 下，且**每个请求都先过 `ctx.connection.requestRejection`**
（本机地址 + 同源 Origin + 登录 Cookie），未登录一律 401。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-restart/status` | `instanceId`(本进程 pid)、端口、工作目录、启动器路径与是否存在、是否有重启在进行 |
| POST | `/dsh-restart/restart` | 安排重启；15 秒内重复请求 409；响应**不含令牌** |
| GET | `/dsh-restart/log` | 重启日志尾部（排查看这个） |

页面判定"新实例已就绪"：`instanceId` 与点按钮前不同，且该响应 `ok === true`。

### 换登录令牌的补救

`dsh web` 每次启动都换随机令牌。正常情况下浏览器已有签名 Cookie（签名密钥持久化在
`$DSH_HOME\.credentials.yaml`），刷新即可；万一认不出登录态，插件会把**这个页面自己带的令牌**
留着，新起来的那一代通过 `/status` 还给它，页面便能用 `?token=...` 重新打开。令牌只回给当初
存下它的那条连接，且只回一次。

---

## 4. 日志与状态文件

| 文件 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\DeepSeekHarness\restart-plugin\logs\restart.log` | 插件与辅助脚本的共同日志（**只追加不截断**：上一次重启的证据也留着） |
| `%LOCALAPPDATA%\DeepSeekHarness\restart-plugin\restart-helper-<pid>.cjs` | 每次重启生成的辅助脚本（保留最近 5 份） |
| `%LOCALAPPDATA%\DeepSeekHarness\restart-plugin\recovery.json` | 页面令牌的暂存（一次性） |

辅助脚本会自己写下"启动器退出码 / 端口是否还有人服务 / 有没有拿到新令牌"——因为要记录失败的
那个进程正好就是刚刚被杀掉的那个。

## 5. 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_RESTART_INSTALL_DIR` | 启动器运行目录（默认 `%LOCALAPPDATA%\DeepSeekHarness`） |
| `DSH_RESTART_DATA` | 插件私有数据目录（默认 `<INSTALL_DIR>\restart-plugin`） |
| `DSH_RESTART_LAUNCHER` | 指定别的启动器脚本（便携安装 / 自检用） |

---

## 6. 安全性

- 路由只对本机 + 同源 + 已登录的页面开放（与官方插件同一套围栏）；
- 不接受任何转发头语义；不需要管理员权限，不改系统配置；
- 会**中断当前正在跑的对话回合** —— 这是重启的本来含义，设置页上已写明；
- `-TakeOver` 路径碰到的进程是端口真正的占用者（可能是你手动开的 `dsh web`，连同它的终端窗口树）。

---

## 7. 自检

```powershell
cd "D:\unity相关对话[ai]\启动DeepSeekHarness"

# 1) 离线检查：宿主半能导入、占位符都替换了、纯 ASCII、Node 能解析、关键不变量都在
node runtime-test\CheckHelperScript.mjs

# 2) 端到端（假宿主 + 假启动器，但加载真实插件代码）：含真的重启一次
node runtime-test\VerifyRestartPlugin.mjs

# 3) 真实链路冒烟（真启动器 + 真 dsh web，在备用端口 3099，不碰 3080 会话）
powershell -NoProfile -ExecutionPolicy Bypass -File runtime-test\SmokeRestartReal.ps1

# 4) 分离进程行为探针（想知道"哪种 spawn 能活"时用）
node runtime-test\ProbeDetachedSpawn.mjs
```

第 2 项用替身，是因为真实那条链（启动器 → `dsh-server-host.mjs` → dsh）用管道捕获输出，受限
沙箱禁止开命名管道会 EPERM；第 3 项补上了这一点：它跑完整的真实链路，只是换一个端口。

已知差异：这个沙箱里被结束的端口偶尔长时间不可重绑，所以第 2 项的替换实例用另一个端口
（`--next-port`）；真实安装里始终是同一个端口，第 3 项验证的正是那条路径。
