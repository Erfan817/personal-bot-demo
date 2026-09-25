/**
 * 配置层 —— 所有环境变量只在这里读
 */
import { join } from "node:path";

// .env 固定在「项目根目录」—— 不管你从哪个目录启动都能找到
const PROJECT_ROOT = join(import.meta.dirname, "..");

try {
  process.loadEnvFile(join(PROJECT_ROOT, ".env"));
} catch {
  // 没有 .env 就用系统环境变量，不算错
}

export const config = {
  model: {
    provider: process.env.PROVIDER ?? "deepseek",
    name: process.env.MODEL ?? "deepseek-flash",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  },

  agent: {
    maxSteps: Number(process.env.MAX_STEPS ?? 5),
    // 单轮问答的整体超时：模型挂住时中止本轮。
    // 没有它，串行队列会被一次挂起的调用永久堵死，
    // 而心跳是独立定时器，照样在写 —— healthcheck 探测不到这种"队列假活"。
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 120_000),
    systemPrompt:
      process.env.SYSTEM_PROMPT ??
      "你是一个简洁、直接的中文助手。需要计算、查时间或回忆过去对话时必须调用工具，不要凭记忆猜。",
  },

  // 协议层用哪个渠道：cli（命令行）或 feishu（飞书）
  channel: process.env.CHANNEL ?? "cli",

  feishu: {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
  },

  // ── 桥接层策略 ──
  gateway: {
    allowedUsers: (process.env.ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rateCapacity: Number(process.env.RATE_CAPACITY ?? 5),
    rateRefillPerMin: Number(process.env.RATE_REFILL_PER_MIN ?? 10),
  },

  // ── 记忆层 ──
  memory: {
    dbPath: process.env.DB_PATH ?? join(PROJECT_ROOT, "data", "memory.db"),
    historyLimit: Number(process.env.HISTORY_LIMIT ?? 20),
  },

  // ── 运维 ──
  // 心跳文件：由进程每分钟写一次，外部脚本据此判断是否卡死
  heartbeatFile:
    process.env.HEARTBEAT_FILE ?? join(PROJECT_ROOT, "data", "heartbeat"),

  // ── 调度层 ──
  scheduler: {
    // 定时任务推送到哪个会话
    // ⚠️ 必须是 chat_id（oc_ 开头），不是 open_id（ou_ 开头）
    defaultChatId: (process.env.SCHEDULE_CHAT_ID ?? "").trim(),

    // 任务清单：运行时配置，改完不用重启（支持热重载）
    jobsFile:
      process.env.JOBS_FILE ?? join(PROJECT_ROOT, "data", "jobs.json"),
  },
};