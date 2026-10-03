/**
 * MCP 桥接层测试
 *
 * 用 pi-mcp 的内存传输伪造一个 MCP 服务器 —— 不拉真进程，离线可跑。
 * 钉住桥接层的三条纪律：
 *   · allow 过滤：清单外的工具根本不注册
 *   · 命名清洗：mcp_ 前缀 + [A-Za-z0-9_-]，永不撞名、不超长
 *   · 结果透传：execute 真的调到 MCP 并转成 LLM 内容
 *
 * 这个文件是纯 JS（不碰 better-sqlite3），本地也能跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  McpClient,
  isJsonRpcRequest,
  LATEST_PROTOCOL_VERSION,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

const { wrapMcpClient, loadMcpTools } = await import("../src/tools/mcp.mjs");

/** 起一个伪造的 MCP 服务器（注册 3 个工具，含怪字符名和写操作工具） */
async function withFakeServer(fn) {
  const pair = createInMemoryTransportPair();
  // send() 要求两端都已 start —— McpClient 只会 start 自己那一侧，
  // 服务器侧必须自己起（第一次跑测试就踩了："peer is not connected"）
  await pair.server.start();

  pair.server.onMessage((msg) => {
    if (!isJsonRpcRequest(msg)) return; // 通知（如 initialized）直接忽略
    const reply = (result) =>
      pair.server.send({ jsonrpc: "2.0", id: msg.id, result });

    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-bili", version: "1.0.0" },
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "bili_subtitle",
              description: "获取视频AI字幕",
              inputSchema: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
              },
            },
            {
              name: "bili_send_dynamic!",
              description: "名字里带怪字符",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "bili_upload_video",
              description: "上传视频（写操作，不该被注册）",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      case "tools/call":
        return reply({
          content: [{ type: "text", text: `called:${msg.params.name}` }],
          isError: false,
        });
      default:
        return reply({});
    }
  });

  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(pair.client);
  return fn(client);
}

test("allow 过滤：清单之外的工具根本不注册", async () => {
  await withFakeServer((client) =>
    wrapMcpClient(client, { name: "bili", allow: ["bili_subtitle"] }).then(
      (tools) => {
        assert.equal(tools.length, 1, "上传/发布这类写操作必须被拦在注册之前");
        assert.equal(tools[0].name, "mcp_bili_subtitle");
        assert.ok(
          tools[0].description.startsWith("[来自 MCP:bili]"),
          "描述要标明来源服务器",
        );
        assert.equal(
          tools[0].parameters.properties.url.type,
          "string",
          "MCP 的参数 schema 要原样保留",
        );
      },
    ),
  );
});

test("命名清洗：怪字符被替换，永远符合 provider 的命名规则", async () => {
  await withFakeServer((client) =>
    wrapMcpClient(client, {
      name: "bili",
      allow: ["bili_subtitle", "bili_send_dynamic!"],
    }).then((tools) => {
      assert.equal(tools.length, 2);
      for (const t of tools) {
        assert.match(t.name, /^[A-Za-z0-9_-]{1,64}$/);
      }
      assert.equal(tools[1].name, "mcp_bili_send_dynamic_");
    }),
  );
});

test("结果透传：execute 真的调到 MCP 并转成 LLM 内容", async () => {
  await withFakeServer((client) =>
    wrapMcpClient(client, { name: "bili", allow: ["bili_subtitle"] }).then(
      async (tools) => {
        const r = await tools[0].execute("id-1", { url: "BV1xx" });
        assert.equal(r.isError, false);
        assert.deepEqual(r.content, [
          { type: "text", text: "called:bili_subtitle" },
        ]);
      },
    ),
  );
});

test("allow 留空 = 全部注册（默认开放，由调用方决定要不要给白名单）", async () => {
  await withFakeServer((client) =>
    wrapMcpClient(client, { name: "bili", allow: [] }).then((tools) => {
      assert.equal(tools.length, 3);
    }),
  );
});

test("未配置 MCP_SERVERS 时安全返回空数组，不炸启动", async () => {
  const tools = await loadMcpTools();
  assert.deepEqual(tools, []);
});
