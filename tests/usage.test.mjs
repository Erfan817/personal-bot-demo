/**
 * 用量与日额度测试
 *
 * 闸门的语义要钉死：累计正确、跨天开新账、limit<=0 不限额、
 * 告警文件当天只写一次。全部用临时目录，不碰真实 data/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRun, usedTokens, overLimit, noteBlocked, useStore } from "../src/brain/usage.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "erifane-usage-"));
  const file = join(dir, "usage.json");
  useStore(file);
  return { file, alert: join(dir, "COST_ALERT") };
}

test("recordRun 累计 tokens 与成本，usedTokens 是输入+输出", () => {
  const { file } = freshStore();
  recordRun({ input: 100, output: 50, cost: 0.01 });
  recordRun({ input: 30, output: 20, cost: 0.02 });
  assert.equal(usedTokens(), 200);
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(s.runs, 2);
  assert.ok(Math.abs(s.cost - 0.03) < 1e-9);
});

test("跨天自动开新账（旧日期的存档不作数）", () => {
  const { file } = freshStore();
  writeFileSync(
    file,
    JSON.stringify({ date: "2000-01-01", input: 99999, output: 99999, runs: 5, alerted: true }),
  );
  assert.equal(usedTokens(), 0, "昨天的账不能算到今天头上");
});

test("overLimit：limit<=0 / NaN 视为不限额", () => {
  freshStore();
  recordRun({ input: 1000, output: 1000 });
  assert.equal(overLimit(0), false);
  assert.equal(overLimit(-1), false);
  assert.equal(overLimit(NaN), false);
  assert.equal(overLimit(2000), true, "达到上限就该拦");
  assert.equal(overLimit(2001), false, "没到上限不拦");
});

test("noteBlocked：告警文件当天只写一次", () => {
  const { alert } = freshStore();
  recordRun({ input: 5000, output: 5000 });
  noteBlocked();
  assert.equal(existsSync(alert), true);
  const first = readFileSync(alert, "utf8");
  noteBlocked();
  assert.equal(readFileSync(alert, "utf8"), first, "第二次调用不能重写");
});
