/**
 * 视频转写纯函数库测试
 *
 * 覆盖：BV 解析（裸号/链接/短链跳转/失败）、Cookie 头拼装
 * （含 buvid3 生成的 412 防御）、下载参数、转写响应解析。
 * 短链跳转用注入的假 fetch 测，不碰真网络。纯 JS，本地可跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBvid,
  resolveBvid,
  buildCookieHeader,
  audioDownloadArgs,
  parseTranscription,
  formatBytes,
} from "../src/tools/lib/video.mjs";

test("parseBvid：裸号、完整链接、混在文本里都能提取", () => {
  assert.equal(parseBvid("BV1apar6nE7Y"), "BV1apar6nE7Y");
  assert.equal(
    parseBvid("https://www.bilibili.com/video/BV1134y1d72L/?p=2"),
    "BV1134y1d72L",
  );
  assert.equal(parseBvid("帮我总结这个视频 BV1TbaD6MEMA 谢谢"), "BV1TbaD6MEMA");
  assert.equal(parseBvid("https://example.com/nothing"), null);
  assert.equal(parseBvid(""), null);
  assert.equal(parseBvid(null), null);
});

test("resolveBvid：直接命中不发起网络请求", async () => {
  let called = false;
  const bvid = await resolveBvid("https://b.bili.com/video/BV1apar6nE7Y", () => {
    called = true;
    throw new Error("不该被调用");
  });
  assert.equal(bvid, "BV1apar6nE7Y");
  assert.equal(called, false, "能直接提取时绝不应走网络");
});

test("resolveBvid：b23.tv 短链跟随跳转后从最终 URL 提取", async () => {
  const fakeFetch = async (url) => {
    assert.ok(url.startsWith("https://b23.tv/"), "应请求原始短链");
    return { url: "https://www.bilibili.com/video/BV1TbaD6MEMA?share_source=xx" };
  };
  assert.equal(await resolveBvid("https://b23.tv/ApniirB", fakeFetch), "BV1TbaD6MEMA");
});

test("resolveBvid：网络失败和纯文本都安全返回 null", async () => {
  assert.equal(await resolveBvid("https://b23.tv/broken", async () => {
    throw new Error("网络炸了");
  }), null);
  assert.equal(await resolveBvid("不是链接"), null);
});

test("buildCookieHeader：完整凭证、缺 buvid3 自动生成、空凭证", () => {
  const full = buildCookieHeader({
    sessdata: "abc",
    bili_jct: "def",
    dedeuserid: "123",
    buvid3: "xyz",
  });
  assert.equal(full, "SESSDATA=abc; bili_jct=def; DedeUserID=123; buvid3=xyz");

  const generated = buildCookieHeader({ sessdata: "abc" });
  assert.ok(generated.includes("SESSDATA=abc"));
  assert.match(generated, /buvid3=.+infoc$/, "buvid3 缺失时应生成一个（412 防御）");

  const empty = buildCookieHeader({});
  assert.match(empty, /^buvid3=/, "空凭证也至少要有设备指纹");
});

test("audioDownloadArgs：最优音频、目标 URL 带 bvid", () => {
  const args = audioDownloadArgs("BV1apar6nE7Y", "/tmp/x");
  assert.ok(args.includes("ba/b"));
  assert.ok(args.includes("https://www.bilibili.com/video/BV1apar6nE7Y"));
  assert.ok(args.includes("/tmp/x/audio.%(ext)s"));
});

test("parseTranscription：取 text 字段，缺省为空串", () => {
  assert.equal(parseTranscription({ text: " 你好 " }), "你好");
  assert.equal(parseTranscription({}), "");
  assert.equal(parseTranscription(null), "");
});

test("formatBytes：单位换算", () => {
  assert.equal(formatBytes(7.47 * 1024 * 1024), "7.5MB");
  assert.equal(formatBytes(500), "500B");
  assert.equal(formatBytes(2048), "2KB");
});
