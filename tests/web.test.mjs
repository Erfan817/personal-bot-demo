/**
 * 联网工具测试
 *
 * 覆盖三个「肉眼查不出来」的地方：
 *   1. HTML → 纯文本的剥离规则（脚本/样式残留、实体没解码）
 *   2. DuckDuckGo 的「验证页」识别（不识别就会误报"没搜到"）
 *   3. 内网地址拦截（SSRF —— 拦不住，agent 就能被网页内容诱导着摸内网）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, truncate } from "../src/tools/lib/html.mjs";
import {
  isDdgBlocked,
  unwrapDdg,
  parseDdg,
} from "../src/tools/lib/search-parse.mjs";
import {
  isPrivateIp,
  isPrivateHostname,
  assertPublicUrl,
} from "../src/tools/lib/net.mjs";

/* ══════════════════ web_fetch · htmlToText ══════════════════ */

test("剥掉 script 和 style（内容不能漏进正文）", () => {
  const html = `
    <html><head>
      <style>body { color: red; }</style>
      <script>var secret = "不该出现";</script>
    </head><body><p>正文在这里</p></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /正文在这里/);
  assert.doesNotMatch(text, /secret/, "script 内容不该出现");
  assert.doesNotMatch(text, /color: red/, "style 内容不该出现");
});

test("剥掉 HTML 注释", () => {
  const text = htmlToText("<p>可见</p><!-- 隐藏的注释 -->");
  assert.match(text, /可见/);
  assert.doesNotMatch(text, /隐藏的注释/);
});

test("块级标签结束处补换行，保住段落", () => {
  const text = htmlToText("<p>第一段</p><p>第二段</p>");
  assert.match(text, /第一段\n第二段/, "段落之间应该有换行");
});

test("常见 HTML 实体要解码", () => {
  const text = htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>");
  assert.match(text, /a & b <c> "d" 'e'/);
});

test("中文内容原样保留", () => {
  const text = htmlToText("<div><h1>标题</h1><p>这是一段中文。</p></div>");
  assert.match(text, /标题/);
  assert.match(text, /这是一段中文。/);
});

test("空输入不炸", () => {
  assert.equal(htmlToText(""), "");
});

test("truncate：短文本不动，长文本截断并说明", () => {
  assert.equal(truncate("abc"), "abc");
  const long = "x".repeat(9000);
  const out = truncate(long);
  assert.ok(out.length < long.length, "应该被截断");
  assert.match(out, /已截断/, "要告诉调用方被截断了");
  assert.match(out, /9000/, "要说明原始长度");
});

/* ══════════════════ web_search · 验证页识别 ══════════════════ */

test("★ 识别 DuckDuckGo 验证页（三种特征）", () => {
  assert.equal(isDdgBlocked('<div class="anomaly-modal">...</div>'), true);
  assert.equal(isDdgBlocked("Unfortunately, bots use DuckDuckGo too."), true);
  assert.equal(isDdgBlocked("We detected unusual traffic from your network"), true);
});

test("正常结果页不该被误判成验证页", () => {
  const normal = `
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
      <a class="result__snippet">摘要</a>
    </div>`;
  assert.equal(isDdgBlocked(normal), false, "正常页面不能被误判");
});

test("空输入不误判", () => {
  assert.equal(isDdgBlocked(""), false);
  assert.equal(isDdgBlocked(null), false);
  assert.equal(isDdgBlocked(undefined), false);
});

/* ══════════════════ web_search · URL 拆包 ══════════════════ */

test("拆开 DuckDuckGo 的跳转链接", () => {
  const wrapped =
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1&rut=abc";
  assert.equal(unwrapDdg(wrapped), "https://example.com/path?a=1");
});

test("不是跳转链接就原样返回", () => {
  assert.equal(unwrapDdg("https://example.com/direct"), "https://example.com/direct");
  assert.equal(unwrapDdg(""), "");
  assert.equal(unwrapDdg("这不是网址"), "这不是网址", "解析不了也不能炸");
});

/* ══════════════════ web_search · 结果解析 ══════════════════ */

test("解析搜索结果：标题 / 链接 / 摘要能对上", () => {
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com&rut=1">标题一</a>
    <a class="result__snippet" href="x">摘要一</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com&rut=2">标题二</a>
    <a class="result__snippet" href="y">摘要二</a>
  `;
  const items = parseDdg(html, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "标题一");
  assert.equal(items[0].url, "https://a.com");
  assert.equal(items[0].snippet, "摘要一", "摘要要按顺序对上");
  assert.equal(items[1].title, "标题二");
  assert.equal(items[1].url, "https://b.com");
});

test("limit 生效", () => {
  const one = `<a class="result__a" href="https://a.com">A</a>`;
  const items = parseDdg(one.repeat(10), 3);
  assert.equal(items.length, 3);
});

test("没有结果时返回空数组（由上层决定怎么报错）", () => {
  assert.deepEqual(parseDdg("<html>什么都没有</html>", 5), []);
});

/* ══════════════════ web_fetch · 内网地址拦截（SSRF） ══════════════════ */

test("★ 私网/环回 IPv4 一律拦截", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("127.8.8.8"), true, "整个 127/8 都是环回");
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true, "云元数据必须在拦截范围");
  assert.equal(isPrivateIp("0.1.2.3"), true, "0/8 未指定段");
  assert.equal(isPrivateIp("224.0.0.1"), true, "组播段");
});

test("公网 IPv4 不误伤", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false, "172.32 已出 172.16/12 范围");
  assert.equal(isPrivateIp("169.253.1.1"), false, "差一段就是链路本地，不能拦");
});

test("IPv6：环回 / 链路本地 / unique-local / IPv4-mapped 拦截", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true, "IPv4-mapped 要转回 v4 判");
  assert.equal(isPrivateIp("2606:4700::1111"), false, "公网 v6 不误伤");
});

test("主机名判断：localhost 和裸私网 IP 直接拦，域名交给 DNS 阶段", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("LOCALHOST"), true);
  assert.equal(isPrivateHostname("[::1]"), true, "URL.hostname 对 IPv6 带方括号，要剥掉");
  assert.equal(isPrivateHostname("192.168.0.1"), true);
  assert.equal(isPrivateHostname("example.com"), false, "false 只代表『走 DNS 再判』");
});

test("assertPublicUrl：非 http(s) 协议拒绝", async () => {
  await assert.rejects(
    () => assertPublicUrl("ftp://example.com/file"),
    /http/,
  );
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /http/);
});

test("assertPublicUrl：显式内网地址拒绝", async () => {
  await assert.rejects(
    () => assertPublicUrl("http://127.0.0.1:8080/admin"),
    /内网|127\.0\.0\.1/,
  );
  await assert.rejects(
    () => assertPublicUrl("http://169.254.169.254/metadata/instance"),
    /内网|169\.254/,
  );
  await assert.rejects(
    () => assertPublicUrl("http://localhost:3000/"),
    /内网|localhost/,
  );
});

test("assertPublicUrl：域名解析出私网 IP 也要拦（DNS 阶段检查）", async () => {
  // 注入假 DNS：域名表面是公网，解析出来却指向内网 —— 必须拦
  const fake = async () => [{ address: "10.0.0.5", family: 4 }];
  await assert.rejects(
    () => assertPublicUrl("http://evil.example/", { lookupFn: fake }),
    /10\.0\.0\.5/,
  );
});

test("assertPublicUrl：解析出公网 IP 放行（注入假 DNS，离线可测）", async () => {
  const fake = async () => [{ address: "93.184.216.34", family: 4 }];
  const u = await assertPublicUrl("https://example.com/path", { lookupFn: fake });
  assert.equal(u.hostname, "example.com");
});

test("assertPublicUrl：解析失败也拒绝（别让 fetch 自己去撞运气）", async () => {
  const fake = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(
    () => assertPublicUrl("http://nope.example/", { lookupFn: fake }),
    /解析失败/,
  );
});