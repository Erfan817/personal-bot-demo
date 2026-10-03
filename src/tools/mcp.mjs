/**
 * 工具层 · MCP 桥
 * ═══════════════════════════════════════════════════
 * 把外部 MCP 服务器的工具桥接进本项目的工具白名单。
 *
 * 为什么走 MCP 而不是每个平台手写工具：字幕、评论、搜索这类能力
 * 社区已有成熟实现（如 bilibili-mcp，连扫码登录都自带），桥一层
 * 就能全部复用；以后接新平台 = 改一行 .env，代码零改动。
 * 桥接写法来自 pi-mcp 官方 README 的 AgentTool 模板 —— 厂商背书，
 * 不是自己发明。
 *
 * 三条纪律：
 *   · allow 清单之外的 MCP 工具【根本不注册】—— 物理上不存在
 *   · MCP 服务器起不来只降级（少几个工具），不炸主服务
 *   · 工具名强制 mcp_ 前缀并清洗 —— 永远不和原生工具撞名
 *     （provider 要求 ≤64 字符的 [A-Za-z0-9_-]）
 */
import { Type } from "typebox";
import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { config } from "../config.mjs";

/** 把一个已连接的 MCP client 里的工具包装成本项目的 AgentTool */
export async function wrapMcpClient(client, { name, allow = [] }) {
  const all = await client.listTools();
  const picked = allow.length
    ? all.filter((t) => allow.includes(t.name))
    : all;

  return picked.map((tool) => ({
    name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    label: tool.title ?? tool.name,
    description: `[来自 MCP:${name}] ${tool.description ?? tool.name}`,
    // MCP 的 inputSchema 是裸 JSON Schema；TypeBox 本身就是 JSON Schema，
    // 用 Type.Unsafe 包一层并兜底 properties（部分 provider 拒绝空 schema）
    parameters: Type.Unsafe({
      ...(tool.inputSchema ?? {}),
      type: "object",
      properties: tool.inputSchema?.properties ?? {},
    }),
    execute: async (_toolCallId, params, signal) => {
      // MCP 把工具失败放在结果里而不是协议层 —— 原样透传 isError
      const result = await client.callTool(tool.name, params, { signal });
      return { content: toLlmContent(result), isError: result.isError === true };
    },
  }));
}

/** 按配置拉起所有 MCP 服务器并返回桥接工具 */
export async function loadMcpTools() {
  const tools = [];
  for (const srv of config.mcp.servers) {
    try {
      const client = new McpClient({ name: "erifane-bot", version: "0.4.0" });
      await client.connect(
        new StdioTransport({ command: srv.command, args: srv.args }),
      );
      const wrapped = await wrapMcpClient(client, srv);
      tools.push(...wrapped);
      console.log(`[mcp] ${srv.name}: 注册 ${wrapped.length} 个工具`);
    } catch (e) {
      console.error(
        `[mcp] ${srv.name} 启动失败（降级为无此工具）:`,
        e?.message ?? e,
      );
    }
  }
  return tools;
}
