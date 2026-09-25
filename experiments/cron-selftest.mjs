// 临时的 cron 逻辑自测（不是项目文件，测完可删）
import { parseCron, matches } from "../src/scheduler/cron.mjs";

const tests = [
  ["0 8 * * *", "2026-09-25T08:00:00", true],
  ["0 8 * * *", "2026-09-25T08:01:00", false],
  ["0 17 * * 5", "2026-09-25T17:00:00", true], // 周五
  ["0 17 * * 5", "2026-09-26T17:00:00", false], // 周六
  ["0 9 15 * *", "2026-09-15T09:00:00", true],
  ["0 9 15 * *", "2026-09-16T09:00:00", false],
  ["*/30 * * * *", "2026-09-25T10:30:00", true],
  ["*/30 * * * *", "2026-09-25T10:31:00", false],
  ["0 10,15 * * *", "2026-09-25T15:00:00", true],
  ["0 10,15 * * *", "2026-09-25T11:00:00", false],
];

let bad = 0;
for (const [cron, iso, want] of tests) {
  const got = matches(parseCron(cron), new Date(iso));
  if (got !== want) {
    bad++;
    console.log(`FAIL  ${cron}  ${iso}  want=${want} got=${got}`);
  }
}
console.log(
  bad === 0
    ? `✅ cron 逻辑全部正确（${tests.length}/${tests.length}）`
    : `❌ ${bad} 个用例失败`,
);