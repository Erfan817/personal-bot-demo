/**
 * 全局串行队列测试
 *
 * 之前队列内联在 feishu.mjs 里、调度器绕过它直接 await runAgent ——
 * 两条 agent 循环在 1 GiB 的机器上并发跑。队列上收到 brain 层后，
 * 「任何时刻最多一个 agent 循环」这个约束必须被测试钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueAgentJob, setRunner } from "../src/brain/queue.mjs";

test("★ 串行：按入队顺序完成，同一时刻最多一个在跑", async () => {
  let active = 0;
  let maxActive = 0;

  setRunner(async (text) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return { answer: `done:${text}` };
  });

  const done = [];
  const ps = ["a", "b", "c"].map(
    (t) =>
      new Promise((res) =>
        enqueueAgentJob({
          chatId: "test",
          text: t,
          onDone: ({ answer }) => {
            done.push(answer);
            res();
          },
        }),
      ),
  );
  await Promise.all(ps);

  assert.deepEqual(done, ["done:a", "done:b", "done:c"], "顺序不能乱");
  assert.equal(maxActive, 1, "并发必须为 1 —— 这是队列存在的意义");
});

test("onError 接住异常，队列不被卡死，后面的任务照常跑", async () => {
  setRunner(async (text) => {
    if (text === "boom") throw new Error("炸了");
    return { answer: `ok:${text}` };
  });

  const errors = [];
  const done = [];
  const ps = [
    new Promise((res) =>
      enqueueAgentJob({
        chatId: "test",
        text: "boom",
        onError: (e) => {
          errors.push(e.message);
          res();
        },
      }),
    ),
    new Promise((res) =>
      enqueueAgentJob({
        chatId: "test",
        text: "after",
        onDone: ({ answer }) => {
          done.push(answer);
          res();
        },
      }),
    ),
  ];
  await Promise.all(ps);

  assert.deepEqual(errors, ["炸了"]);
  assert.deepEqual(done, ["ok:after"], "前面的任务炸了不能堵住后面的");
});

test("announce / chatId 原样传给 runner", async () => {
  let seen;
  setRunner(async (text, opts) => {
    seen = opts;
    return { answer: "" };
  });
  await new Promise((res) =>
    enqueueAgentJob({
      chatId: "chat-x",
      text: "hi",
      announce: false,
      onDone: res,
    }),
  );
  assert.equal(seen.chatId, "chat-x");
  assert.equal(seen.announce, false);
});
