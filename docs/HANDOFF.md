# 交接文档 / HANDOFF

> **给下一个接手这个项目的人或 Agent。**
>
> 这份文档不讲「项目是什么」（→ [`README.md`](../README.md)），也不讲「为什么这样设计」（→ [`DESIGN.md`](DESIGN.md)）。
> 它只讲那两份文档里都没有的东西：**现在实际是什么状态，以及怎么在没有上下文的情况下接着干。**

**快照采集时间**：2026-09-25 13:41 CST
下面所有「当前值」都是这一刻在**真实服务器上实测**的，不是设计意图。时间久了请用文末的命令重新采集。

> ⚠️ **本仓库是公开的。** 服务器 IP、用户名、私钥、`.env` 内容**一律不要提交**。
> 本文用 `<占位符>` 表示这类信息，需要时向项目所有者索取。

---

## 0. 三十秒版本

1. 代码在 GitHub：`https://github.com/Erfan817/personal-bot-demo`（**公开仓库**）
2. 代码**跑在服务器上**，服务器目录 2026-09-25 起**也是 git 仓库**（部署 = fetch + reset，可回滚）
3. **真正的运行状态只在服务器上**：记忆数据库、定时任务清单、密钥 —— 本地文件夹里一个都没有
4. 本地跑不了完整测试（`memory.test.mjs` 依赖原生 `better-sqlite3`），**验证必须去服务器**

---

## 1. 最重要的一件事：这个项目的"真相"分两半

| | 本地 `erifane-bot/` | 服务器 `~/erifane-bot/` |
|---|---|---|
| **源码** | ✅ 有，且是 git 仓库 | ✅ 有，且是 git 仓库（2026-09-25 起，remote 指向 GitHub） |
| **git 历史** | ✅ 完整 | ✅ 镜像自 origin/main（部署 = fetch + reset） |
| `.env`（密钥） | ❌ 没有（故意的） | ✅ 有（5 个变量） |
| `data/memory.db`（记忆） | ❌ 没有 | ✅ 有 |
| `data/jobs.json`（任务清单） | ❌ 没有 | ✅ 有 |
| `data/backups/`（备份） | ❌ 没有 | ✅ 有 |
| systemd 单元 | ✅ 模板在 `scripts/` | ✅ 已安装并启用 |

**结论：只拿到本地文件夹 = 只拿到一半。**
另一半（真正跑起来的那一半）必须从服务器取 —— 见 §3。

---

## 2. 服务器

### 2.1 基本信息（2026-09-25 实测）

| 项 | 值 |
|---|---|
| 主机名 | `Erifane` |
| 云 / 区域 | Azure · Korea Central |
| 规格 | `Standard_B2ats_v2` — **2 vCPU / 1 GiB 内存** + 8 GB swap |
| OS | Ubuntu 22.04（内核 `6.8.0-1068-azure`） |
| 磁盘 | 62 GB，已用 12 GB（20%） |
| Node | `v22.23.3` · `/usr/bin/node` |
| 时区 | `Asia/Shanghai` —— **cron 表达式按北京时间算，不是 UTC** |
| 项目目录 | `/home/azureuser/erifane-bot` |
| 登录方式 | **仅 SSH 密钥**（密码登录已关闭） |
| 成本 | $0/月（Azure for Students 免费额度） |

> ⚠️ **只有 1 GiB 内存，这不是笔误。**
> Azure 学生免费套餐里那几个 SKU（B1s / B2pts_v2 / B2ats_v2）**全都是 1 GiB**，没有更大且免费的。
> `npm install`、编译原生 `better-sqlite3` 时会很吃紧 —— 那 8 GB swap 就是为这个准备的。

### 2.2 怎么连

```bash
ssh erifane          # 别名定义在本机 ~/.ssh/config
```

本机 `~/.ssh/config` 里的样子（换机器要重建）：

```
Host erifane
    HostName <服务器公网 IP>
    User <用户名>
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

> 💡 **本机已经有这份 config 的话，公网 IP 和用户名直接就能看到**：
> `Get-Content $env:USERPROFILE\.ssh\config`（Windows）或 `cat ~/.ssh/config`（Linux/macOS）。
> **只有私钥不是"查一下就有"的** —— 见 §6.2。
>
> 📌 `README.md` 的部署示例里写的是 `ssh server` —— 那是**占位别名**。
> 本机实际使用的别名是 `erifane`。看到 `server` 请自行替换。

### 2.3 五个 systemd 单元

| 单元 | 作用 | 触发方式 | 运行身份 |
|---|---|---|---|
| `erifane-bot.service` | 主服务，常驻 | 开机自启 + `Restart=always` | `azureuser` |
| `erifane-healthcheck.timer` | 心跳检查 | 开机 2 分钟后起，之后每 5 分钟 | — |
| `erifane-healthcheck.service` | 心跳检查（单次执行体） | 由上面的 timer 拉起 | root（要重启服务） |
| `erifane-backup.timer` | 备份 | 每天 04:00，`Persistent=true` | — |
| `erifane-backup.service` | 备份（单次执行体） | 由上面的 timer 拉起 | `azureuser` |

模板都在 `scripts/`，安装方式见 `README.md` 的「运维」一节。

**当前状态：三个单元全部 `active` + `enabled`。**

**用户 crontab 是空的** —— 已经全部迁移到 systemd timer（原因见 README「运维」）。

### 2.4 主服务的实际启动配置（实测）

```
WorkingDirectory = /home/azureuser/erifane-bot
ExecStart        = /usr/bin/node src/index.mjs
Restart          = always
```

---

## 3. 当前状态快照（2026-09-25 13:41 CST）

| 项 | 实测值 |
|---|---|
| 服务 | `active`，本轮启动于 `2026-09-25 13:23:44 CST` |
| 配置文件 | `.env` 只有 5 个变量（见 §6） |
| **定时任务** | `data/jobs.json` 只有 1 条：**「每日早报」`0 8 * * *`，`enabled: true`** ← 每天早上 8 点会真的推送 |
| 心跳 | 最新一次约 **38 秒前**（阈值 300 秒）→ 正常 |
| 告警 | 无 `data/ALERT`，失败计数 `0` → **健康** |
| 备份 | `~/erifane-backups/`（**项目目录之外**，全部 0600），保留上限 7 |
| 测试 | **90 / 90 通过**（2026-09-25 实测；另外每次 push 由 GitHub Actions 跑全套 —— 数字有凭证） |
| 项目文件数 | 61（不含 `node_modules`） |

`data/` 目录实际内容：

```
data/
├── heartbeat               毫秒时间戳，服务每 60 秒写一次
├── healthcheck-fails       连续失败计数（root 所有，正常是 0）
├── jobs.json               ★ 真实任务清单（本地没有这个文件）
├── scheduler-state.json    调度器触发记录（重启续上 + misfire 定位）
├── usage.json              每日 token/成本累计（成本闸门用）
├── memory.db               记忆库主文件
├── memory.db-shm / -wal    SQLite WAL 模式配套文件
└── （备份已挪到 ~/erifane-backups/ —— 含明文密钥，见 §6）
```

---

## 4. 三个会让人误判的事实

### ① ~~服务器上的目录不是 git 仓库~~ 已解决（2026-09-25）

服务器 `~/erifane-bot` 现在是 git 仓库，remote 指向 GitHub。
部署 = `git fetch origin && git reset --hard origin/main`；
**回滚 = reset 到任意旧 commit**，一条命令。

**随之而来一条新纪律：不要在服务器上直接改文件。**
服务器是仓库的镜像——直接改的东西下次 reset 就被冲掉，
还会制造「说不清跑的是哪个版本」的新混乱。改代码走仓库：
本地改 → push → 服务器 reset。

### ② 真实任务清单只在服务器上

本地 `src/scheduler/jobs.mjs` 里 `defaultJobs` 是 `enabled: false` —— 它**只是首次运行的默认值**。

真实清单是服务器上的 `data/jobs.json`（目前有 1 条已启用的早报任务）。

**如果你只读本地代码，会得出「这个项目没有定时任务」的错误结论。**

### ③ `memory.db` 不能直接 `cp`

SQLite 在 WAL 模式下，主文件和 `-wal` 是配套的。实测：

```
memory.db         36 KB
memory.db-wal    3.6 MB    ← 数据其实大部分在这里
```

**直接复制 `memory.db` 会丢掉绝大部分数据**，而且可能在恢复时损坏。

正确做法是用 `scripts/backup.mjs`（内部走 `better-sqlite3` 的 `db.backup()`，会先做一致性快照）。

---

## 5. 接手后的第一件事：跑通验证链条

```bash
# ⓪ 本机装依赖（node_modules 不在仓库里，默认是空的）
cd <项目目录>
npm install

# ① 连上
ssh erifane

# ② 服务活着吗
systemctl is-active erifane-bot

# ③ 心跳新鲜吗（对比两个数字，差值应小于 300000 毫秒）
cat ~/erifane-bot/data/heartbeat; date +%s%3N

# ④ 有没有告警
ls ~/erifane-bot/data/ALERT        # 报错=没有告警=健康

# ⑤ 测试还过吗（应该是 90/90；CI 每次 push 也跑同一套）
cd ~/erifane-bot && node --test tests/*.test.mjs

# ⑥ 定时任务到底是什么
cat ~/erifane-bot/data/jobs.json

# ⑦ 最近日志
journalctl -u erifane-bot -n 50 --no-pager

# ⑧ 备份还能恢复吗（每周演练一次，不用停服务）
node ~/erifane-bot/scripts/restore.mjs --verify \
  ~/erifane-backups/$(ls -t ~/erifane-backups | grep '^memory-' | head -n 1)
```

**八步全过 = 你有了可复现的基线。**
之后任何改动，都要能重新走完这八步。

---

## 6. 密钥与访问权限

### 6.1 服务器 `.env` 里实际存在的变量（只有这 5 个）

```
DEEPSEEK_API_KEY
FEISHU_APP_ID
FEISHU_APP_SECRET
ALLOWED_USERS          # 逗号分隔的 open_id 白名单；留空 = 拒绝所有人
SCHEDULE_CHAT_ID       # 定时推送目标
```

**其余全部没设**，走 `.env.example` 里的默认值：
`PROVIDER` · `MODEL` · `DB_PATH` · `RATE_*` · `HISTORY_LIMIT` · `BRAVE_API_KEY` · `HEARTBEAT_FILE` · `BACKUP_KEEP`

### 6.2 什么需要「交接」，什么可以自己查

**关键区别：只有私钥是「只能由所有者主动给」的东西，其余全都能自己找到。**

| 东西 | 在哪 | 接手方能自己拿到吗 |
|---|---|---|
| 服务器公网 IP | 本机 `~/.ssh/config`；或 Azure Portal；或在服务器上 `curl -s ifconfig.me` | ✅ 能 |
| 用户名 | 本机 `~/.ssh/config`；或在服务器上 `whoami` | ✅ 能 |
| **`.env` 的 5 个值** | **服务器 `~/erifane-bot/.env`** | ✅ 能 —— 有 SSH 权限就直接 `cat` |
| **SSH 私钥 `id_ed25519`** | **只在本机 `~/.ssh/`**，服务器上**没有** | ❌ **不能 —— 必须所有者主动提供** |

> 实测：服务器 `~/.ssh/` 里**只有 `authorized_keys`（公钥）**，没有私钥。
> 公钥推不出私钥 —— 所以拿不到私钥就进不了服务器。

**由此推出两种交接场景：**

- **接手方在同一台电脑上**（比如只是换一个 Agent 工具）：
  它能自己读 `~/.ssh/config`、能 SSH 上去读 `.env` —— **你什么都不用给。**
- **接手方在另一台机器 / 是另一个人**：
  **只有私钥需要你主动给**，其余它会自己找到。

### 6.3 如果不是在原服务器上部署

照 `.env.example` 自己建 `.env`，值从服务器上取：

```bash
ssh erifane 'cat ~/erifane-bot/.env'
```

### ⚠️ 两个必须避开的泄露路径

| 路径 | 为什么会泄露 |
|---|---|
| 把 `.env` 放进项目文件夹，再把**整个文件夹**交给 Cursor / Claude Code | 这些工具会索引代码并**上传到它们的服务器**做 embedding —— 密钥跟着走，而且你收不到任何提示 |
| 把备份目录整个交出去 | 备份里含 `env-*` = **明文密钥快照**。已挪到 `~/erifane-backups/`（项目之外）+ 全部 0600，但它仍是明文 —— 交出任何东西之前先看一眼 |

### 一个实际踩过的坑

`SCHEDULE_CHAT_ID` 必须是 **`oc_` 开头的 chat_id**。
用 `ou_` 开头的 open_id 会报 `230001 invalid receive_id` —— 两者前缀相似，极易混。

---

## 7. 必须遵守的纪律（这些会**静默**出错）

| 纪律 | 不遵守会怎样 |
|---|---|
| 测试用 `node --test tests/*.test.mjs`（**glob 形式**） | 服务器 Node 22 不认目录形式，报 `Cannot find module '.../tests'`。**本地 Node 24 能跑，所以你不会发现** |
| `memory.test.mjs` 只能去服务器跑 | 本地装不上原生 `better-sqlite3`（编译权限受限） |
| 块注释里的 `*/` 必须写成 `*\/` | `*/` 会提前闭合注释 → `SyntaxError`（项目里踩过两次） |
| 改完代码：本地 push → 服务器 `git fetch && git reset --hard origin/main` → `systemctl restart` | 服务器是仓库镜像；**直接在服务器上改文件会被下次 reset 冲掉** |
| cron 表达式按**北京时间**算 | 服务器时区是 `Asia/Shanghai`，不是 UTC |
| 改完跑 `npm run check`（批量 `node --check`） | 语法错会在服务器上才现形，服务起不来 |

### 本机操作注意（Windows + PowerShell）

这几条是接手时会立刻撞上的：

| 现象 | 原因 | 做法 |
|---|---|---|
| 远程脚本报 `syntax error near unexpected token '('` | PowerShell 传给 `ssh.exe` 时会**吃掉内嵌引号** | 远程脚本里**避免括号和双引号** |
| `sh: 1: ﻿#!/bin/sh: not found` | PowerShell 管道会给 stdin **加 BOM** | 用单引号 here-string 作为**参数**传给 ssh，而不是 stdin 管道 |
| `tail: option used in invalid context` | 这个环境不认 `tail -15` | 用 `tail -n 15` |
| 多行命令粘进 SSH 会话被拆坏 | 终端粘贴限制 | **写成脚本文件**再 `scp` 执行，或 `Get-Content -Raw x.sh \| ssh host "sh -s"` |

---

## 8. 已知不一致 / 待整理

这些不影响运行，但会误导接手的人：

| 位置 | 问题 |
|---|---|
| `README.md` 部署示例 | 用 `ssh server` 占位，本机实际别名是 `erifane` |
| `scripts/healthcheck.sh` | `BASE` 是**硬编码绝对路径** `/home/azureuser/erifane-bot` —— 换用户或换路径必须改 |

---

## 9. 下一步做什么

完整清单在 `README.md` 的「待办 / 下一步」。按依赖关系，建议顺序：

1. **外部告警通道** —— 把 `data/ALERT` 推到飞书/webhook。
   现在告警只写在本机文件里，**人不在电脑前就不知道**。这是当前最大的可靠性缺口。
2. **记忆层语义召回** —— 现在是字面检索，同义改写召不回（见 README「设计决策 3」）。
3. **飞书渠道集成测试** —— 现在只有人工验证。
4. QQ 渠道（OneBot 11 反向 WebSocket）—— 用来验证「协议无关」这个设计到底成不成立。

**但更值得先做的可能是：用几天。**
真实使用暴露的问题，比照着清单加功能准得多。

---

## 附：重新采集现状

状态会过期。重新采集用这段（**作为单引号 here-string 参数传给 ssh**，不要用 stdin 管道）：

```powershell
$remote = @'
echo ===== HEALTH =====
systemctl is-active erifane-bot
cat ~/erifane-bot/data/heartbeat; echo; date +%s%3N
ls ~/erifane-bot/data/ALERT 2>/dev/null || echo "no ALERT -- healthy"
echo ===== JOBS =====
cat ~/erifane-bot/data/jobs.json
echo ===== TIMERS =====
systemctl list-timers 'erifane-*' --no-pager
echo ===== TESTS =====
cd ~/erifane-bot && node --test tests/*.test.mjs 2>&1 | tail -n 12
'@
ssh erifane $remote
```