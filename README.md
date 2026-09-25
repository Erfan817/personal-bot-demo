# Erifane Bot

**一个从零实现的、分层架构的自托管个人 Agent。**
7×24 运行在一台 2 vCPU / 1 GiB 的云服务器上，通过飞书在手机和电脑上派活，有长期记忆，会定时主动推送报告，能联网搜索。

> 不是"部署了一个开源 Agent"，而是**自己写的一套 Agent 网关**。
> 分层设计、能力白名单、协议无关的渠道适配、幂等与限频、心跳自愈运维——每一层都能说清楚为什么在那儿。

### 这是什么，不是什么

**是**：一份**"每一步都能说清为什么这么做"**的工程 demo。
重点不在功能多，而在**每个设计决策的理由**，以及**踩过的坑和怎么定位的**。

**不是**：生产级系统。下面「已知局限」一节把短板都列出来了，包括没有做的部分。

> **要接手这个项目（换人 / 换机器 / 换 Agent）？**
> 先读 [`docs/HANDOFF.md`](docs/HANDOFF.md) —— 它讲的是**当前实际状态和怎么接着干**，和这份 README（讲设计）互补。

---

## 能力（并标清哪部分是自己写的）

**这个项目依赖了 5 个第三方包**，所以有必要说清楚能力边界 ——
**"能连 44 个模型的 provider 集合"是框架给的，不是这个项目实现的。**

| 包 | 版本 | 用来干什么 |
|---|---|---|
| `@earendil-works/pi-ai` | `^0.87.1` | provider 集合（44 个模型） |
| `@earendil-works/pi-agent-core` | `^0.87.1` | Agent 循环 |
| `@larksuiteoapi/node-sdk` | `^1.74.0` | 飞书长连接 |
| `better-sqlite3` | `^13.0.3` | SQLite（含 FTS5 中文分词） |
| `typebox` | `^1.3.34` | 工具参数 schema |

| 能力 | 说明 | 谁实现的 |
|---|---|---|
| **多端派活** | 飞书长连接，手机 / 电脑 / 平板天然同步，会话上下文连续 | 长连接是飞书 SDK 提供；**渠道适配、3 秒约束下的异步化是自己写的** |
| **长期记忆** | SQLite + FTS5 全文检索，跨会话记得住，**能主动去翻旧账** | **自己写的**（含中文分词处理、索引同步） |
| **定时主动推送** | 按 cron 自己推报告，不等你问 | **cron 解析器、调度器、`deliver` 事件都是自己写的** |
| **联网** | 搜索 + 抓网页，会判断信源可靠度、标注出处 | **工具是自己写的**；搜索走 DuckDuckGo HTML 或 Brave API |
| **可换大脑** | 换模型只改 `.env` 一行 | ⚠️ **provider 集合（44 个）来自 `pi-ai`，不是本项目实现的**。本项目做的是"把它接进分层结构" |
| **Agent 循环** | 模型→要工具→执行→回灌→再问 | ⚠️ 循环本身由 `pi-agent-core` 提供。**第 1 步里有一份手写的 60 行版本**（`agent.mjs`）用来对照 |
| **24/7 可靠** | systemd 常驻 + 崩溃重启 + **心跳自愈**（连"假活"也能发现）+ 每日备份 | **运维脚本是自己写的** |
| **安全** | SSH 密钥登录、准入白名单、限频、幂等、工具白名单闸门 | **桥接层和闸门是自己写的**；`beforeToolCall` 钩子是框架提供的挂载点 |

> **一句话**：框架提供了「怎么调模型」和「怎么转循环」；
> **这个项目做的是把它们包进一个有门禁、有记忆、有调度、能被运维的系统里。**

---

## 测试

```bash
npm test        # node --test tests/（Node 内置测试框架，零依赖）
npm run check   # 对所有 .mjs 跑 node --check
```

**为什么这个项目特别需要测试**：踩坑章节里那七八条，
（`*/` 提前闭合注释、中文引号截断字符串、FTS rowid 不对齐、验证页伪装成"0 结果"）
**全都是"肉眼查不出来、只有跑起来才暴露"的类型。** 它们正好是单测最该固化的东西。

覆盖范围：

| 测试文件 | 覆盖 | 备注 |
|---|---|---|
| `cron.test.mjs` | 解析 / 匹配 / 非法输入 | 含「日 vs 周」那个经典陷阱 |
| `gateway.test.mjs` | 准入 / 幂等 / 限频 / **顺序** | 验证「陌生人不消耗你的令牌」 |
| `outbound.test.mjs` | 长回复切分 | 不把句子劈开、内容不丢 |
| `web.test.mjs` | HTML→文本 / 验证页识别 / URL 拆包 / **内网地址拦截** | 含「区分没有数据 vs 拿不到数据」+ SSRF 防护 |
| `events.test.mjs` | 事件总线 | 同步异常与 **async 订阅者的 rejection** 都要被接住 |
| `memory.test.mjs` | 存取 / 索引同步 / 会话隔离 | **含"已知局限"的固化断言** |

> 其中 `memory.test.mjs` 有一组**故意断言"检索不到"**的用例 ——
> 把已知失效场景写成测试，缺陷就变成了**有意的设计取舍**，而不是运行时的惊喜。

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

#### ⚠️ 但要说清它「不准」的那一面

上面那个实测验证的是**"它会去检索"**，**没有验证"检索得准"**。这两件事不一样，必须分开讲：

**这个记忆层是纯字面检索（FTS5 trigram），没有语义召回。** 也就是：

| 场景 | 结果 |
|---|---|
| 你说过「橘猫」，再问「橘猫」 | ✅ 能召回 |
| 你说过「橘猫」，再问「宠物」 | ❌ **召回不了** |
| 你说过「整理会议纪要」，再问「总结记录」 | ❌ **召回不了** |
| 查询词不足 3 字（如「牛奶」） | ⚠️ 降到 `LIKE` 全表扫描，能兜住但数据量大时会慢 |

**换句话说：它记住的是你说过的「字面词」，不是「意思」。**
同义改写、口语换词、跨语言表达，都会漏。

**为什么接受这个取舍**：
语义召回需要 embedding 模型 + 向量库，成本和复杂度都要上一个台阶，
而 `flash` 模型的上下文窗口有 **100 万 token** ——
大多数"日常回忆"场景，靠最近 N 条 + 字面检索已经够用。

**这些边界不是猜的**，`tests/memory.test.mjs` 里有一组**故意断言"检索不到"**的用例把它们钉住了：

```javascript
// 把已知失效场景写成断言，缺陷就变成【有意的设计取舍】
assert.equal(searchHistory("宠物", 5).length, 0,
  "「宠物」召不回「橘猫」—— 这是字面检索的固有局限，不是 bug");
```

**要升级的话**：给 `messages` 加一列 embedding，检索时做 BM25 + 向量的混合排序。
`better-sqlite3` 可以加载向量扩展，或者换成 LanceDB。**那是下一步的事，不是没意识到。**

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

### ⑧ 知道一个坑 ≠ 不会再踩它

写 `scripts/check-syntax.mjs` 的时候（**这个脚本专门用来抓语法错误**），
我在它的文件头注释里写了这句：

```javascript
 *     · */ 在块注释里提前闭合注释     ← 这就是坑本身
```

**脚本自己语法错误了。** 正是它要检测的那个 bug。

改成 `*\/` 之后才通过。

**教训**：
> **把"我记住了"换成"工具会拦住我"。**
> 我在这份 README 里写了这条坑，然后十分钟后又踩了一次 ——
> 所以真正的解法不是记性更好，而是**每次改完都跑 `npm run check`**。

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

**部署在 `/etc/systemd/system/` 下，共三个单元**：

| 单元 | 作用 | 身份 |
|---|---|---|
| `erifane-bot.service` | 主服务，常驻 | `azureuser`（不用 root） |
| `erifane-healthcheck.timer` | 每 5 分钟心跳检查 | root（需要重启服务的权限） |
| `erifane-backup.timer` | 每天 04:00 备份 | `azureuser` |

```bash
sudo cp scripts/erifane-*.service scripts/erifane-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erifane-bot erifane-healthcheck.timer erifane-backup.timer
```

**为什么不直接用 cron 跑心跳和备份**：

| | cron | **systemd timer** |
|---|---|---|
| 脚本自己挂了 | ❌ 没人知道 | ✅ `systemctl list-timers` 可见 |
| 执行记录 | ❌ 靠邮件/无 | ✅ 进 journal，`journalctl -u` 可查 |
| 关机错过的任务 | ❌ 就错过了 | ✅ `Persistent=true` 开机补跑（备份用了这个） |
| 失败后续动作 | ❌ 没有 | ✅ 可挂 `OnFailure=` |

**看定时器状态**：

```bash
systemctl list-timers 'erifane-*'
journalctl -u erifane-healthcheck -n 20 --no-pager
```

**心跳自愈的告警阈值**（`scripts/healthcheck.sh`）：

```
第 1 次异常  -> 重启服务
第 2 次异常  -> 重启服务
第 3 次异常  -> 【停止自动重启】+ 写 data/ALERT + 打日志
               （避免重启风暴掩盖真正原因）
心跳恢复     -> 计数自动复位、告警自动清除
```

**告警文件长这样**（`~/erifane-bot/data/ALERT`）：

```
═══ Erifane Bot 告警 ═══
时间        : 2026-09-25 14:03:12
原因        : 心跳已 412s 未更新（阈值 300s）
连续失败次数: 3
处置        : 已【停止自动重启】，等待人工介入
```

**还没做的**：这是**本机告警**，不是**外部告警**。真要"出事时人不在电脑前也能知道"，
得把 `ALERT` 推到飞书/邮件/webhook —— 那是待办里的「外部告警通道」。

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
├── .env.example                    配置模板
├── agent.mjs                       第 1 步的单文件版本（教学对照用）
├── experiments/                    框架 API 探路脚本
│   ├── pi-minimal.mjs
│   └── cron-selftest.mjs
├── scripts/
│   ├── erifane-bot.service         主服务
│   ├── erifane-healthcheck.service 心跳检查（单次）
│   ├── erifane-healthcheck.timer   心跳检查（每 5 分钟）
│   ├── erifane-backup.service      备份（单次）
│   ├── erifane-backup.timer        备份（每天 04:00）
│   ├── healthcheck.sh              心跳自愈 + 告警阈值
│   ├── backup.mjs                  数据库 + 配置备份
│   └── check-syntax.mjs            批量 node --check
├── tests/                          node:test，零依赖
│   ├── cron.test.mjs
│   ├── gateway.test.mjs
│   ├── outbound.test.mjs
│   ├── web.test.mjs
│   └── memory.test.mjs             含"已知局限"的固化断言
├── src/
│   ├── index.mjs                   组装（唯一知道用哪个渠道的地方）
│   ├── config.mjs                  所有环境变量只在这里读
│   ├── events.mjs                  事件总线
│   ├── heartbeat.mjs               心跳
│   ├── brain/
│   │   ├── models.mjs              provider 集合（pi-ai 提供）
│   │   └── loop.mjs                agent 循环 + 白名单闸门
│   ├── channels/
│   │   ├── cli.mjs                 命令行渠道
│   │   └── feishu.mjs              飞书渠道
│   ├── gateway/
│   │   ├── index.mjs               入站闸门（准入→幂等→限频）
│   │   ├── access.mjs              准入白名单
│   │   ├── ratelimit.mjs           令牌桶
│   │   ├── dedupe.mjs              幂等去重
│   │   └── outbound.mjs            长回复切分
│   ├── tools/
│   │   ├── index.mjs               ★ 白名单唯一入口
│   │   ├── calc.mjs
│   │   ├── now.mjs
│   │   ├── history_search.mjs
│   │   ├── web_search.mjs          只负责发请求 + 选通道
│   │   ├── web_fetch.mjs           只负责发请求
│   │   └── lib/                    ★ 纯函数（不依赖 typebox，可离线单测）
│   │       ├── html.mjs            HTML → 文本
│   │       └── search-parse.mjs    结果解析 + 验证页识别
│   ├── memory/
│   │   ├── db.mjs                  SQLite + FTS5
│   │   ├── messages.mjs            会话历史
│   │   └── search.mjs              长期检索
│   └── scheduler/
│       ├── cron.mjs                自己写的 cron 解析器
│       ├── jobs.mjs                内置默认任务
│       └── index.mjs               定时器 + jobs.json 热重载
└── docs/
    ├── DESIGN.md                   更详细的设计笔记
    └── HANDOFF.md                  ★ 交接：当前状态 + 接手怎么做
```

---

## 加一个新工具的完整流程

**只改两个文件：**

1. 新建 `src/tools/你的工具.mjs`，导出 `{ name, label, description, parameters, execute }`
2. 在 `src/tools/index.mjs` 的 `REGISTRY` 数组里加一行

**其余六层一行不改。** 白名单闸门、事件推送、渠道展示、记忆落盘全部自动生效。

> `description` 的写法很关键——**模型靠它决定什么时候调用**。要写清楚"什么情况下该用它"。

---

## 已知局限

**这一节是刻意写全的。** 一个只讲优点、把短板留给别人踩的 demo，
比一个功能少但边界清楚的 demo 差得多。

| 局限 | 影响 | 现在怎么办 |
|---|---|---|
| **记忆是字面检索，无语义召回** | 同义改写、口语换词召不回 | 详见「设计决策 3」；测试里已固化边界 |
| **多用户共享一个 Agent** | 所有人共用同一套工具权限 | 单用户信任模型；敌对用户要拆成独立实例 |
| **消息串行处理** | 一次只能跑一个任务，后面排队 | 个人使用够；要并发得按 chatId 分队列 |
| **无流式输出** | 要等全部生成完才看到回复 | 框架有 `message_update` 事件，接上即可 |
| **记忆不会衰减** | 库会无限增长，检索质量随量下降 | 需要时间衰减 + 容量上限 |
| **告警只在本机** | 出事时人不在电脑前不知道 | `data/ALERT` 文件 + journal；外部告警通道待做 |
| **搜索依赖 DuckDuckGo** | 数据中心 IP 可能被人机验证拦 | 检测已做（不会误报"没搜到"）；可配 `BRAVE_API_KEY` 切换 |
| **单机无冗余** | 服务器挂了服务就断 | 个人用途，接受 |
| **未做端到端集成测试** | 飞书通道靠人工验证 | 单元测试覆盖了纯逻辑层；集成测试待补 |

---

## 待办 / 下一步

- [ ] 外部告警通道（把 `data/ALERT` 推到飞书/webhook）
- [ ] 记忆层加语义召回（embedding + 混合排序）—— 见「设计决策 3」
- [ ] 飞书渠道的集成测试（现在只有人工验证）
- [ ] QQ 渠道（OneBot 11 反向 WebSocket）—— 验证协议无关设计
- [ ] 流式输出接到飞书（打字机效果）
- [ ] 用量统计与成本看板
- [ ] 多用户（当前是单用户信任模型）

---

## 定位

**这是一个 demo，不是生产系统。**

它的价值不在功能数量（QQ、流式、多用户都还空着），而在于：

- **每一层为什么在那儿**，都说得出理由
- **踩过的坑和排查过程**都是真的（不是抄来的"最佳实践"）
- **已知的短板**写在明处，而且部分被测试固化了
- **哪块是框架给的、哪块是自己写的**，分得清清楚楚

按这个口径讲就行 —— **别让文档的工整度替代系统的完成度。**