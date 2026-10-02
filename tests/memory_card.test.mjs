/**
 * 记忆卡（结构化长期记忆）测试
 *
 * 三类：
 *   A. 正确性 —— 存卡、检索、FTS rowid 对齐、去重更新、删除同步索引
 *   B. 主题卡 —— 「聊健身就从健身卡里说」的核心场景
 *   C. ★ 与档案层的对照 —— messages 层钉死的"同义召不回"局限，
 *      在记忆卡层靠 keywords 治好了：同一个场景，两个断言一反一正。
 *
 * ⚠️ 写断言前想清楚 FTS 的语义：短语查询是【包含即命中】——
 *    新内容若包含旧内容，两行都能被搜到。断言"旧内容归零"时，
 *    要么让新内容替换旧内容（走更新路径），要么换唯一标记。
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
  `erifane-memcard-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);
process.env.DB_PATH = dbFile;

const {
  addMemory,
  searchMemories,
  listMemories,
  topicsSummary,
  coreMemories,
  getMemory,
  archiveMemory,
  removeMemory,
  countMemories,
} = await import("../src/memory/index.mjs");

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbFile + suffix, { force: true });
  }
});

/* ══════════════════ A. 正确性 ══════════════════ */

test("存卡后立刻能检索到 —— FTS rowid 必须与主表 id 显式对齐", () => {
  const marker = `深蹲${Date.now()}`;
  const r = addMemory({ chatId: "test", topic: "健身", content: `我的${marker}重量是80公斤` });

  assert.ok(r.id > 0);
  assert.equal(r.updated, false);
  const hits = searchMemories(marker);
  assert.equal(hits.length, 1, "刚写的卡必须立刻能搜到");
  assert.equal(hits[0].topic, "健身");
});

test("add 去重：同内容的活跃卡只更新，不重复开卡", () => {
  const before = countMemories();
  const content = `瑞士卷要用动物奶油${Date.now()}`;
  const first = addMemory({ chatId: "test", topic: "饮食", content, importance: 2 });
  const second = addMemory({ chatId: "test", topic: "饮食", content, importance: 4 });

  assert.equal(second.id, first.id, "同内容必须命中同一张卡");
  assert.equal(second.updated, true, "第二次写入应标记为更新");
  assert.equal(countMemories(), before + 1, "不能多出一张卡");

  const row = getMemory(first.id);
  assert.equal(row.importance, 4, "重要度应被更新");
});

test("去重更新同步 FTS：被覆盖的内容和旧关键词都不留幽灵", () => {
  const stamp = Date.now();
  // 时间戳放最前面：让「新内容」成为「旧内容」的【前缀】——
  // FTS 短语是按连续字符匹配的，前缀才能命中旧卡、走【更新】路径
  const longC = `${stamp} 晨跑并记录配速`;
  const shortC = `${stamp} 晨跑`;
  const r1 = addMemory({ chatId: "test", topic: "健身", content: longC, keywords: "配速记录" });
  const r2 = addMemory({ chatId: "test", topic: "健身", content: shortC, keywords: "跑步习惯" });

  assert.equal(r2.id, r1.id, "子串命中同一张卡");
  assert.equal(r2.updated, true);

  assert.equal(searchMemories(longC).length, 0, "被覆盖的旧内容不能留幽灵索引");
  assert.equal(searchMemories(shortC).length, 1, "新内容必须能搜到");
  assert.equal(searchMemories("配速记录").length, 0, "旧关键词不能留幽灵");
  assert.equal(searchMemories("跑步习惯").length, 1, "新关键词必须进索引");
});

test("remove 同步删索引，不留幽灵卡", () => {
  const marker = `幽灵卡片${Date.now()}`;
  const r = addMemory({ chatId: "test", topic: "日常", content: marker });

  assert.equal(searchMemories(marker).length, 1);
  assert.equal(removeMemory(r.id), true);
  assert.equal(searchMemories(marker).length, 0, "删除后不能再搜到");
  assert.equal(getMemory(r.id), null);
  assert.equal(removeMemory(r.id), false, "重复删除返回 false，不炸");
});

test("短查询（<3 字）降级 LIKE 兜底", () => {
  addMemory({ chatId: "test", topic: "饮食", content: "早上只喝美式咖啡", keywords: "咖啡因" });

  const hits = searchMemories("美式"); // 2 字，走不到 FTS
  assert.ok(hits.length >= 1, "2 字查询必须能用 LIKE 兜住");
});

test("空查询和空内容都是安全边界，不炸", () => {
  assert.deepEqual(searchMemories(""), []);
  assert.deepEqual(searchMemories(null), []);
  assert.throws(() => addMemory({ content: "   " }), /不能为空/);
});

test("重要度越界会被夹回 1~5", () => {
  const r = addMemory({ chatId: "test", topic: "测试", content: `越界夹取${Date.now()}`, importance: 99 });
  assert.equal(getMemory(r.id).importance, 5);
});

/* ══════════════════ B. 主题卡 ══════════════════ */

test("按主题检索：聊健身就从健身卡里说，不串到别的卡", () => {
  addMemory({ chatId: "test", topic: "学习", content: "主人在准备十二月的数据分析师考试" });
  addMemory({ chatId: "test", topic: "健身", content: "主人每周一三五练胸背，二四练腿" });

  const fitness = searchMemories("健身"); // 主题进了 keywords，必然命中
  assert.ok(fitness.length >= 1);
  assert.ok(
    fitness.every((m) => m.topic === "健身"),
    "搜「健身」召回的每一张都必须是健身卡",
  );

  const study = searchMemories("数据分析师");
  assert.equal(study.length, 1);
  assert.equal(study[0].topic, "学习");
});

test("topicFilter：同主题过滤不影响其他主题", () => {
  const rows = searchMemories("胸背", { topic: "健身" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, "健身");
});

test("topicsSummary 按主题给出卡数概览", () => {
  const topics = topicsSummary().map((t) => t.topic);
  assert.ok(topics.includes("健身"));
  assert.ok(topics.includes("学习"));
  assert.ok(topics.includes("饮食"));
});

test("检索命中会刷新 last_used_at（定期整理的衰减依据）", () => {
  const r = addMemory({ chatId: "test", topic: "日常", content: `冷门偏好香芹籽${Date.now()}` });
  assert.equal(getMemory(r.id).last_used_at, null, "没被检索过时是空的");

  searchMemories("冷门偏好香芹籽");
  assert.ok(getMemory(r.id).last_used_at > 0, "命中一次就该记一次");
});

/* ══════════════════ C. ★ 与档案层的对照 ══════════════════ */

test("★ 对照档案层的已知局限：keywords 让「宠物」能召回「橘猫」了", () => {
  // messages 层的 memory.test.mjs 把这个场景钉成断言：
  //   存"我养了一只橘猫"，搜"宠物" → 0 条（字面检索的固有局限）。
  // 记忆卡的解法：检索还是字面的，但「写入时把同义词写进 keywords」
  // 把同义关系提前补齐了 —— 缺陷被结构吸收，而不是靠更聪明的检索。
  addMemory({
    chatId: "test",
    topic: "宠物",
    content: "主人养了一只橘猫，叫煤球",
    keywords: "宠物 猫 动物 煤球",
  });

  const hits = searchMemories("宠物"); // 2 字走 LIKE，命中 keywords 列
  assert.ok(
    hits.length >= 1,
    "同一个场景，档案层召回 0 条，记忆卡层必须 ≥1 —— 这是分层的意义",
  );
  assert.ok(
    hits.some((h) => /橘猫/.test(h.content)),
    "「宠物」必须能召回写着「橘猫」的那张卡",
  );
});

test("★ 3 字以上的关键词走 FTS 路径也能跨词召回", () => {
  addMemory({
    chatId: "test",
    topic: "宠物",
    content: "煤球不爱吃鱼",
    keywords: "动物世界 喂食习惯",
  });

  const hits = searchMemories("动物世界"); // 4 字，走 FTS
  assert.ok(hits.length >= 1, "keywords 列必须和 content 一样进 FTS 索引");
});

/* ══════════════════ 核心记忆注入 ══════════════════ */

test("coreMemories：重要度优先，归档的不出现", () => {
  const lo = addMemory({ chatId: "test", topic: "测试注入", content: `低重要度条目${Date.now()}`, importance: 1 });
  const hi = addMemory({ chatId: "test", topic: "测试注入", content: `身份信息条目${Date.now()}`, importance: 5 });

  const core = coreMemories(50);
  const pos = (id) => core.findIndex((m) => m.content === getMemory(id).content);
  assert.ok(pos(hi.id) >= 0, "高重要度必须在场");
  assert.ok(pos(hi.id) < pos(lo.id), "重要度高的必须排在前面");

  assert.equal(archiveMemory(lo.id), true);
  const afterArchive = coreMemories(50).map((m) => m.content);
  assert.ok(!afterArchive.some((c) => c.startsWith("低重要度条目")), "归档卡不能进核心记忆");
});

test("coreMemories 尊重 limit", () => {
  assert.equal(coreMemories(2).length, 2);
});
