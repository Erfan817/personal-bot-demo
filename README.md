# Erifane Bot

**一个从零实现的、分层架构的自托管个人 Agent。**
7×24 运行在一台 2 vCPU / 1 GiB 的云服务器上，通过飞书在手机和电脑上派活，有长期记忆，会定时主动推送报告，能联网搜索。

> 不是"部署了一个开源 Agent"，而是**自己写的一套 Agent 网关**。
> 分层设计、能力白名单、协议无关的渠道适配、幂等与限频、心跳自愈运维——每一层都能说清楚为什么在那儿。

---

## 能力

| 能力 | 说明 |
|---|---|
| **多端派活** | 飞书长连接，手机 / 电脑 / 平板天然同步，同一个会话上下文连续 |
| **长期记忆** | SQLite + FTS5 全文检索。跨会话记得住，**且能主动去翻旧账** |
| **定时主动推送** | 内置 cron，早上 8 点自己推早报——不等你问 |
| **联网** | 搜索 + 抓网页，会判断信源可靠度、标注出处 |
| **可换大脑** | 44 个内置 provider（含 DeepSeek / Kimi / GLM / 通义等国产），改 `.env` 一行 |
| **24/7 可靠** | systemd 常驻 + 崩溃重启 + **心跳自愈**（连"假活"也能发现）+ 每日备份 |
| **安全** | SSH 密钥登录、准入白名单、限频、幂等、工具白名单闸门 |

---

## 架构

```
📱 飞书（手机 / 电脑 / 平板）
     │
     │ ① 长连接（WebSocket，无需公网 IP、无需内网穿透）
     ▼
┌────────────────────────────────────────────────────────────┐
│  channels/          协议层  翻译 + 3 秒约束下的异步化        │
│      │                                                      │
│  gateway/           桥接层  ①准入 ②幂等 ③限频 ④出站切分     │
│      │                                                      │
│  brain/loop.mjs     大脑层  agent 循环（pi-agent-core）      │
│      │                                                      │
│  tools/             工具层  能力白名单 + beforeToolCall 闸门 │
│      │                                                      │
│  memory/            记忆层  SQLite + FTS5 存取与检索         │
│      │                                                      │
│  scheduler/         调度层  cron 到点触发 → deliver 事件     │
│      │                                                      │
│  events.mjs         事件总线  让「大脑」和「渠道」互不认识    │
└────────────────────────────────────────────────────────────┘
     │
     ▼
🖥️ systemd 常驻 · 心跳自愈 · 每日备份 · journald 日志
```

### 各层职责

| 层 | 目录 | 职责 | 一句话 |
|---|---|---|---|
| **协议** | `channels/` | 消息进出的适配 | 换渠道只改 `index.mjs` 一行 |
| **桥接** | `gateway/` | 准入 / 幂等 / 限频 / 出站 | **上线的前提，不是优化** |
| **大脑** | `brain/` | 模型 + agent 循环 | 可换的脑，不变的循环 |
| **工具** | `tools/` | 能力白名单 + 实现 | **加能力只能改一个文件** |
| **记忆** | `memory/` | 会话历史 + 长期检索 | 存、取、检索分离 |
| **调度** | `scheduler/` | 定时触发 + 主动推送 | 从"你问它答"到"它主动找你" |
| **总线** | `events.mjs` | 大脑 ↔ 渠道解耦 | 同一套大脑服务多个渠道 |

---

## 关键设计决策

### 1. 用事件总线解耦「大脑」和「渠道」

**大脑层不打印任何东西，只 `emit` 事件。** 谁订阅、展示到哪，是渠道层的事。

```
                      ┌─→ cli.mjs      （打印到终端）
大脑 emit("answer") ──┤
                      └─→ feishu.mjs   （发到飞书）
```

**实证**：第 4 步把手写循环整个换成 `pi-agent-core` 时，`channels/cli.mjs` 和 `events.mjs` **一行都没改**。加定时推送时，大脑层也一行没改（只加了一个 `deliver` 事件 + 一个订阅者）。

> 分层不是"设计完就冻结"，而是**"在哪一层加东西"变得很清楚**。

### 2. 能力白名单用 `beforeToolCall` 钩子，而不是"不注册工具"

```javascript
beforeToolCall: async ({ toolCall }) => {
  if (!isAllowed(toolCall.name)) {
    return { block: true, reason: `工具 ${toolCall.name} 不在白名单里` };
  }
}
```

**框架级闸门**：无论工具调用从哪条路径发起，都必须先过这里。比在业务代码里到处查表可靠得多。

**更硬的一层**：白名单外的能力**物理上不存在**——agent 根本没有那个"手"。不是"我拦住你"，而是"我没给你"。

### 3. 历史记忆走「检索」，而不是「全塞进上下文」

| | 全塞进上下文 | **存库 + 检索** |
|---|---|---|
| 成本 | 随历史线性增长 | 恒定 |
| 上限 | 有硬上限 | 无 |
| 可控性 | 不可控 | 想删就删、想改就改 |

**上下文里只放最近 N 条**（保证对话连贯），**更早的内容交给 `history_search` 工具自己去翻**。

实测：把 `HISTORY_LIMIT=2`（装不下答案）时，它**没有说"我不知道"，而是自己去检索了历史**。

### 4. 入站闸门的顺序有讲究：准入 → 幂等 → 限频

```
① 准入   纯判断，无副作用    ← 陌生人的消息，不该污染去重表
② 幂等   会记录 message_id
③ 限频   会消耗令牌          ← 也不该为陌生人的消息消耗你的令牌
```

**便宜、无副作用的检查放前面**——这是通用原则。

### 5. 幂等不是设计洁癖，是被平台规则逼出来的

```
飞书要求事件回调 3 秒内返回
        ↓
agent 跑一轮要好几秒 → 必须异步
        ↓
异步 + 超时重推 → 同一条消息会来两次
        ↓
【必须幂等去重】
```

**看明白这条因果链，就明白了为什么真实系统里会有那么多"看起来多余"的防御。**

### 6. 协议无关的渠道适配

新增一个渠道 = **新增一个文件**（实现「收消息」和「发消息」两件事），其余六层一行不改。

`cli.mjs` 和 `feishu.mjs` 结构完全一样，差别只在：
- 一个从 `argv` 取输入，一个从 WebSocket 事件取
- 一个 `console.log`，一个调飞书 API

### 7. 模型层可替换

走 OpenAI 兼容协议 + pi-ai 的 provider 集合，**换模型只改 `.env`**：

```bash
PROVIDER=deepseek          # 或 moonshotai-cn / zai-coding-cn / openai ...
MODEL=deepseek-flash
```

---

## 踩过的坑（这一节比代码更值钱）

一个真实项目里，**让人半夜爬起来的不是"怎么写 agent 循环"，而是这些**：

### ① `*/` 在块注释里就是注释结束符

```javascript
/*
 * 我想说「*/n 表示步长」      ← 注释在这里就结束了！后面变成代码 → 语法错误
 */
```

**教训**：注释里出现语法符号要转义（`*\/`）。**而且别靠眼睛查——用 `node --check`。**

### ② FTS 表和主表的 `rowid` 默认毫无关系

SQLite 的 FTS5 表是独立表，它自己的 `rowid` 和主表的 `id` 默认**没有任何对应关系**。

**修法**：插入时显式指定 `rowid = 消息 id`。

**教训**：任何「主表 + 索引表」的设计，都要想清楚这个对应关系。

### ③ 跨边界传数据，别用你不完全了解的第三方内部格式

把历史消息"塞回框架"看起来最自然，但框架内部的 assistant 消息除 `role/content` 外还有 `provider/model/usage/stopReason` 等字段。格式不匹配时框架**静默丢弃**，结果是发给模型的出现「连续两条 user 消息」，API 直接拒绝——**表现是"回答是空的"，而且不报错**。

**修法**：改成把历史拼进 system prompt，完全不依赖框架内部格式。

**教训**：
- **能不能用，和该不该用，是两件事。** 用对方官方的序列化方式是唯一稳妥的做法。
- **任何跨层调用都要留一条错误通道**——否则你只看到现象，看不到原因。

### ④ 中文引号会提前闭合 JS 字符串

```javascript
"这不是"没搜到"，而是..."     ❌ 内层是 ASCII 的 "，字符串提前闭合
"这不是「没搜到」，而是..."     ✅ 用「」，永不冲突
```

**教训**：写中文代码时，字符串里用「」或单引号。

### ⑤ 「没有数据」和「拿不到数据」必须区分

DuckDuckGo 对数据中心 IP 会返回人机验证页，**而页面里没有结果**。不识别的话，会误报成"没搜到相关信息"——**给用户的建议完全不同**（"换个词搜" vs "搜索通道被拦了"）。

**修法**：显式检测验证页特征，抛出明确的错误。

### ⑥ `Restart=always` 处理不了「假活」

systemd 的 `Restart=always` **只能处理进程退出**。进程活着但事件循环卡住时，`systemctl status` 显示绿色 running，日志没报错，**但消息就是没反应**。

**修法**：进程每分钟写一次心跳文件，外部脚本检查时效性，超时则重启。

**教训**：**用状态/日志判断健康是不可靠的——只有"它自己还在证明自己活着"才可靠。**

### ⑦ 平台侧配置和代码侧连接是两件事

飞书长连接 `ws client ready` ≠ 飞书会把消息推给你。**还必须去开发者后台把"订阅方式"设成长连接。**

而且飞书要求**先有客户端连上，才能保存这个选项**——顺序反了会卡住。

---

## 技术栈

| | |
|---|---|
| 运行时 | Node.js 22（原生 `fetch`、`loadEnvFile`，零构建步骤） |
| Agent 框架 | `@earendil-works/pi-agent-core` + `pi-ai` |
| 渠道 | `@larksuiteoapi/node-sdk`（飞书长连接） |
| 存储 | `better-sqlite3`（WAL 模式 + FTS5 trigram 分词） |
| 参数校验 | `typebox` |
| 运维 | systemd + cron + journald |
| 基础设施 | Azure（Korea Central）· Ubuntu 22.04 · 2 vCPU / 1 GiB + 8 GB swap |

**依赖总数：4 个。** 没有构建步骤、没有 Docker、没有数据库服务。

---

## 快速开始

```bash
# 1. 装依赖
npm install

# 2. 配置
cp .env.example .env
# 编辑 .env，至少填 DEEPSEEK_API_KEY

# 3. 命令行试一下（不需要飞书）
node src/index.mjs "现在几点了？"

# 4. 起飞书渠道
CHANNEL=feishu node src/index.mjs
```

**第一次跑飞书时白名单是空的**——所有人都会被拒绝。给机器人发一条消息，日志里会打印你的 `open_id`，把它写进 `.env` 的 `ALLOWED_USERS`。

> **「空名单 = 拒绝所有人」是故意的**：安全默认 + 从日志里自助引导，不用去后台查 ID。

---

## 运维

```bash
systemctl status erifane-bot          # 看状态
journalctl -u erifane-bot -f          # 实时日志（Ctrl+C 退）
sudo systemctl restart erifane-bot    # 重启
journalctl -u erifane-bot -n 100 --no-pager   # 看最近 100 行
```

**部署在 `/etc/systemd/system/erifane-bot.service`**，用普通用户运行（不用 root）。

**cron**（root）：

```cron
*/5 * * * * /home/azureuser/erifane-bot/scripts/healthcheck.sh
0 4 * * *   /usr/bin/node /home/azureuser/erifane-bot/scripts/backup.mjs
```

**改完代码的部署流程**：

```bash
scp -r src/ server:~/erifane-bot/        # 推代码
ssh server 'sudo systemctl restart erifane-bot'
ssh server 'journalctl -u erifane-bot -f' # 看结果
```

---

## 目录结构

```
erifane-bot/
├── package.json
├── .env.example              配置模板
├── agent.mjs                 第 1 步的单文件版本（教学对照用）
├── experiments/              框架 API 探路脚本
├── scripts/
│   ├── erifane-bot.service   systemd 单元
│   ├── healthcheck.sh        心跳自愈
│   └── backup.mjs            数据库 + 配置备份
├── src/
│   ├── index.mjs             组装（唯一知道用哪个渠道的地方）
│   ├── config.mjs            所有环境变量只在这里读
│   ├── events.mjs            事件总线
│   ├── heartbeat.mjs         心跳
│   ├── brain/
│   │   ├── models.mjs        provider 集合
│   │   └── loop.mjs          agent 循环 + 白名单闸门
│   ├── channels/
│   │   ├── cli.mjs           命令行渠道
│   │   └── feishu.mjs        飞书渠道
│   ├── gateway/
│   │   ├── index.mjs         入站闸门（准入→幂等→限频）
│   │   ├── access.mjs        准入白名单
│   │   ├── ratelimit.mjs     令牌桶
│   │   ├── dedupe.mjs        幂等去重
│   │   └── outbound.mjs      长回复切分
│   ├── tools/
│   │   ├── index.mjs         ★ 白名单唯一入口
│   │   ├── calc.mjs
│   │   ├── now.mjs
│   │   ├── history_search.mjs
│   │   ├── web_search.mjs
│   │   └── web_fetch.mjs
│   ├── memory/
│   │   ├── db.mjs            SQLite + FTS5
│   │   ├── messages.mjs      会话历史
│   │   └── search.mjs        长期检索
│   └── scheduler/
│       ├── cron.mjs          自己写的 cron 解析器
│       ├── jobs.mjs          ★ 任务清单
│       └── index.mjs         定时器
└── docs/
    └── DESIGN.md             更详细的设计笔记
```

---

## 加一个新工具的完整流程

**只改两个文件：**

1. 新建 `src/tools/你的工具.mjs`，导出 `{ name, label, description, parameters, execute }`
2. 在 `src/tools/index.mjs` 的 `REGISTRY` 数组里加一行

**其余六层一行不改。** 白名单闸门、事件推送、渠道展示、记忆落盘全部自动生效。

> `description` 的写法很关键——**模型靠它决定什么时候调用**。要写清楚"什么情况下该用它"。

---

## 待办 / 下一步

- [ ] QQ 渠道（OneBot 11 反向 WebSocket）—— 验证协议无关设计
- [ ] 流式输出接到飞书（打字机效果）
- [ ] 用量统计与成本看板
- [ ] 多用户（当前是单用户信任模型）