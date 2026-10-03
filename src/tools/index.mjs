/**
 * 工具层 —— 白名单注册表
 * ═══════════════════════════════════════════════════
 * 这是整个系统的「能力白名单」唯一入口。
 *
 *   想给 agent 加能力  ->  只能在这里 import 一个工具
 *   不在这个列表里的   ->  beforeToolCall 钩子会拦下
 */
import calc from "./calc.mjs";
import now from "./now.mjs";
import historySearch from "./history_search.mjs";
import webSearch from "./web_search.mjs";
import webFetch from "./web_fetch.mjs";
import remindMe from "./remind_me.mjs";
import memory from "./memory.mjs";
import videoTranscribe from "./video_transcribe.mjs";
import { loadMcpTools } from "./mcp.mjs";

const REGISTRY = [calc, now, historySearch, webSearch, webFetch, remindMe, memory, videoTranscribe];

// MCP 桥接工具在进程启动时拉起（起不来只降级，不影响原生工具）
const mcpTools = await loadMcpTools();
const ALL_TOOLS = [...REGISTRY, ...mcpTools];

/** 交给框架的工具数组（AgentTool 格式） */
export const agentTools = ALL_TOOLS;

/**
 * 白名单检查 —— 由 brain/loop.mjs 的 beforeToolCall 钩子调用。
 * 这是「框架级」的闸门：无论工具从哪条路径发起，都必须先过这里。
 */
export function isAllowed(name) {
  return ALL_TOOLS.some((t) => t.name === name);
}

/** 列出白名单里所有工具名（日志 / 自检用） */
export function toolNames() {
  return ALL_TOOLS.map((t) => t.name);
}