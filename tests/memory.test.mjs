/**
 * 记忆层测试
 *
 * 两类：
 *   A. 正确性 —— 存取、FTS 与主表 id 对齐、中文分词、会话隔离
 *   B. ★ 已知局限 —— 把「检索得准不准」的边界也钉住
 *
 * 关于 B：一个只测"能跑"的测试套件，会把缺陷留成惊喜。
 *        把已知的失效场景写成断言，缺陷就变成了【有意的设计取舍】。
 *
 * 注意：这个文件需要 better-sqlite3，跑之前先 npm install。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// 必须在 import 记忆层之前指定库文件，否则会写到项目的 data/ 里
const dbFile = join(
  tmpdir(),
  `erifane-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);
process.env.DB_PATH = dbFile;

const { saveMessage, loadRecent, searchHistory, clearChat, countAll } =
  await import("../src/memory/index.mjs");

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbFile + suffix, { force: true });
  }
});

let seq = 0;
const uniq = (p) => `${p}-${seq++}`;

/* ══════════════════ A. 正确性 ══════════════════ */

test("存取：最近消息按时间正序返回", () => {
  const chat = uniq("chat");
  saveMessage(chat, "user", "第一句");
  saveMessage(chat, "assistant", "第二句");
  saveMessage(chat, "user", "第三句");

  const rows = loadRecent(chat, 10);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.content),
    ["第一句", "第二句", "第三句"],
    "必须正序，才能直接喂给模型",
  );
});

test("存取：limit 取的是【最近】N 条，不是最早的 N 条", () => {
  const chat = uniq("chat");
  for (let i = 1; i <= 10; i++) saveMessage(chat, "user", `第${i}句`);

  const rows = loadRecent(chat, 3);
  assert.deepEqual(
    rows.map((r) => r.content),
    ["第8句", "第9句", "第10句"],
  );
});

test("会话隔离：不同 chatId 互不串", () => {
  const a = uniq("chat-a");
  const b = uniq("chat-b");
  saveMessage(a, "user", "A 的内容");
  saveMessage(b, "user", "B 的内容");

  assert.equal(loadRecent(a, 10).length, 1);
  assert.equal(loadRecent(a, 10)[0].content, "A 的内容");
  assert.equal(loadRecent(b, 10)[0].content, "B 的内容");
});

test("★ FTS 与主表 rowid 对齐：刚存的内容必须能搜到", () => {
  // 这条测试专门守一个真实踩过的坑：
  // FTS5 表是独立表，它的 rowid 和主表 id 默认毫无关系。
  // 如果插入时不显式指定 rowid，检索会返回错行或者返回空。
  const chat = uniq("fts");
  const marker = `紫色大象${Date.now()}`;
  saveMessage(chat, "user", `我喜欢的动物是${marker}`);

  const hits = searchHistory(marker, 5);
  assert.equal(hits.length, 1, "刚写进去的内容必须立刻能检索到");
  assert.match(hits[0].content, new RegExp(marker));
});

test("中文子串检索：trigram 分词生效", () => {
  const chat = uniq("zh");
  saveMessage(chat, "user", "我的生日是三月十五号，别忘了");

  const hits = searchHistory("生日是三月", 5);
  assert.ok(hits.length >= 1, "中文子串应该能检索到（trigram 分词的作用）");
});

test("短查询（<3 字）降级到 LIKE 兜底", () => {
  const chat = uniq("short");
  saveMessage(chat, "user", "记得买牛奶和鸡蛋");

  // 「牛奶」只有 2 个字，走不到 FTS（trigram 要求 ≥3），必须靠 LIKE
  const hits = searchHistory("牛奶", 5);
  assert.ok(hits.length >= 1, "2 字查询必须能用 LIKE 兜住");
});

test("检索：空查询返回空，不炸", () => {
  assert.deepEqual(searchHistory(""), []);
  assert.deepEqual(searchHistory("   "), []);
  assert.deepEqual(searchHistory(null), []);
});

test("clearChat 只清指定会话", () => {
  const a = uniq("clear-a");
  const b = uniq("clear-b");
  saveMessage(a, "user", "要清掉的");
  saveMessage(b, "user", "要保留的");

  const removed = clearChat(a);
  assert.equal(removed, 1);
  assert.equal(loadRecent(a, 10).length, 0);
  assert.equal(loadRecent(b, 10).length, 1, "别的会话不能被误删");
});

test("clearChat 也要清掉全文索引（否则会搜到已删内容）", () => {
  const chat = uniq("clear-fts");
  const marker = `幽灵内容${Date.now()}`;
  saveMessage(chat, "user", marker);
  assert.equal(searchHistory(marker, 5).length, 1, "删除前应该能搜到");

  clearChat(chat);
  assert.equal(
    searchHistory(marker, 5).length,
    0,
    "删除后不该还能搜到 —— 索引和主表必须同步",
  );
});

test("countAll 返回的是总数", () => {
  const before = countAll();
  const chat = uniq("count");
  saveMessage(chat, "user", "一");
  saveMessage(chat, "user", "二");
  assert.equal(countAll(), before + 2);
});

/* ══════════════════ B. 已知局限（把边界钉住） ══════════════════ */

test("★ 局限：检索是【字面】的，同义改写召不回", () => {
  // 这是我们明确接受的取舍：纯 FTS5 全文检索，没有语义召回。
  // 把它写成断言，是为了让"它能做什么/不能做什么"永远清楚，
  // 而不是等用户问了才在运行时发现。
  const chat = uniq("synonym");
  saveMessage(chat, "user", "我养了一只橘猫");

  // 字面命中：可以
  assert.ok(searchHistory("橘猫", 5).length >= 1, "字面词应该能召回");

  // 同义改写：不行
  assert.equal(
    searchHistory("宠物", 5).length,
    0,
    "「宠物」召不回「橘猫」—— 这是字面检索的固有局限，不是 bug",
  );
});

test("★ 局限：口语换词也召不回", () => {
  const chat = uniq("paraphrase");
  saveMessage(chat, "user", "帮我把会议纪要整理一下");

  assert.equal(
    searchHistory("总结记录", 5).length,
    0,
    "换一种说法就召不回 —— 需要语义检索才能解决",
  );
});

test("★ 局限：trigram 的 3 字下限会漏掉 1-2 字的精确查询", () => {
  const chat = uniq("shortlimit");
  saveMessage(chat, "user", "今天天气不错适合出门散步");

  // 「散步」2 字：靠 LIKE 能兜住
  assert.ok(searchHistory("散步", 5).length >= 1, "2 字走 LIKE，能兜住");

  // 但如果是英文/数字的 1-2 字符精确匹配，LIKE 会扫全表（性能问题，
  // 数据量大时会慢）—— 这里只记录语义，不做性能断言
  assert.ok(searchHistory("散步", 5).length >= 1);
});