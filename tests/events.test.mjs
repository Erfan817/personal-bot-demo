/**
 * 事件总线测试
 *
 * emit 的 try/catch 只能接住订阅者的【同步】异常。
 * 订阅 async 函数时它返回 Promise，rejection 必须被单独接住 ——
 * 否则就是 unhandledRejection：静默、且有带崩进程的风险。
 * 这里把「async 订阅者炸了也要被记进日志」钉成断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { on, emit } from "../src/events.mjs";

/** 临时替换 console.error 收集日志，测完还原（listeners 是模块级的，事件名各测试错开） */
async function captureErrors(fn) {
  const seen = [];
  const orig = console.error;
  console.error = (...args) => seen.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return seen;
}

test("同步抛错：不影响其他订阅者，也不炸 emit", async () => {
  const seen = await captureErrors(async () => {
    const got = [];
    on("e1-sync-throw", () => {
      throw new Error("同步炸了");
    });
    on("e1-sync-throw", (p) => got.push(p));
    emit("e1-sync-throw", { n: 1 });
    assert.deepEqual(got, [{ n: 1 }], "后面的订阅者要照常收到事件");
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.ok(
    seen.some((s) => s.includes("同步炸了")),
    `错误要被记进日志，实际: ${seen}`,
  );
});

test("★ async 订阅者的 rejection 会被接住，不变成 unhandledRejection", async () => {
  const seen = await captureErrors(async () => {
    on("e2-async-reject", async () => {
      throw new Error("异步炸了");
    });
    emit("e2-async-reject", {});
    // 给微任务/定时器留时间，让 rejection 真的发生
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.ok(
    seen.some((s) => s.includes("异步炸了")),
    `async 订阅者的错误必须被接住并记录，实际: ${seen}`,
  );
});

test("async 订阅者正常完成不产生错误日志", async () => {
  const seen = await captureErrors(async () => {
    on("e3-async-ok", async () => {
      /* 正常完成 */
    });
    emit("e3-async-ok", {});
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(seen.length, 0, `不该有错误日志，实际: ${seen}`);
});
