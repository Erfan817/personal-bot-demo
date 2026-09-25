/**
 * 桥接层测试
 *
 * 最重要的一条：验证「准入 → 幂等 → 限频」的顺序真的按设计生效。
 * 特别是「陌生人不该消耗白名单用户的限频令牌」——
 * 这是 README 里声称的设计决策，必须有测试兜着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../src/config.mjs");

// 测试期间接管配置
config.gateway.allowedUsers = ["ou_always_allowed"];
config.gateway.rateCapacity = 100; // 默认给足
config.gateway.rateRefillPerMin = 60;

const { admit } = await import("../src/gateway/index.mjs");
const { checkRate } = await import("../src/gateway/ratelimit.mjs");
const { alreadySeen } = await import("../src/gateway/dedupe.mjs");

/** 测试用的固定白名单用户（跨测试共用，注意令牌会累积消耗） */
const ALLOWED = "ou_always_allowed";

let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${seq++}`;

/**
 * 造一个「在白名单里的」测试用户。
 *
 * ⚠️ 这个 helper 是必要的：限频测试里如果用随机 id，
 *    admit 会在第 ① 步（准入）就把请求拒掉，根本走不到限频 ——
 *    我第一次就踩了这个坑，测试失败暴露的是测试写错了，不是代码错了。
 */
function allowedUser(prefix = "ou_u") {
  const id = uniq(prefix);
  config.gateway.allowedUsers.push(id);
  return id;
}

/** 临时改限频参数，跑完自动还原 */
async function withRate(capacity, refillPerMin, fn) {
  const oldCap = config.gateway.rateCapacity;
  const oldRefill = config.gateway.rateRefillPerMin;
  config.gateway.rateCapacity = capacity;
  config.gateway.rateRefillPerMin = refillPerMin;
  try {
    return await fn();
  } finally {
    config.gateway.rateCapacity = oldCap;
    config.gateway.rateRefillPerMin = oldRefill;
  }
}

/* ══════════════════ 准入 ══════════════════ */

test("准入：不在白名单 -> 拒绝且静默", () => {
  const v = admit({ senderId: uniq("ou_stranger"), messageId: uniq("m") });
  assert.equal(v.ok, false);
  assert.equal(v.silent, true, "陌生人应该被静默丢弃，不回复");
  assert.match(v.reason, /白名单/);
});

test("准入：白名单里 -> 通过", () => {
  const v = admit({ senderId: allowedUser(), messageId: uniq("m") });
  assert.equal(v.ok, true);
});

test("★ 准入在最前面：不在白名单的消息，连幂等表都不会进", () => {
  // 这意味着陌生人的 messageId 不会污染去重表
  const id = uniq("m");
  const stranger = uniq("ou_stranger");

  admit({ senderId: stranger, messageId: id });

  // 同一个 id 换成一个合法用户，应该【能通过】——
  // 证明上一条在准入就被拦了，没写进去重表
  const v = admit({ senderId: allowedUser(), messageId: id });
  assert.equal(v.ok, true, "陌生人的 id 不该占用去重表");
});

/* ══════════════════ 幂等 ══════════════════ */

test("幂等：同一个 messageId 只通过一次，且第二次静默", () => {
  const id = uniq("m");
  const user = allowedUser();

  const first = admit({ senderId: user, messageId: id });
  const second = admit({ senderId: user, messageId: id });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.silent, true, "重复消息应静默，不能重复回答");
  assert.match(second.reason, /重复/);
});

test("幂等：已记录过的 id 直接返回 true", () => {
  const id = uniq("m");
  assert.equal(alreadySeen(id), false, "第一次没见过");
  assert.equal(alreadySeen(id), true, "第二次见过");
});

test("幂等：空 id 不参与去重（避免把 undefined 当成同一条）", () => {
  assert.equal(alreadySeen(undefined), false);
  assert.equal(alreadySeen(undefined), false, "空 id 不该被记住");
  assert.equal(alreadySeen(""), false);
  assert.equal(alreadySeen(""), false);
});

/* ══════════════════ 限频 ══════════════════ */

test("限频：令牌耗尽后拒绝，且【不静默】（要告诉用户）", async () => {
  await withRate(2, 0, () => {
    const user = allowedUser("ou_rate");

    assert.equal(admit({ senderId: user, messageId: uniq("m") }).ok, true);
    assert.equal(admit({ senderId: user, messageId: uniq("m") }).ok, true);

    const third = admit({ senderId: user, messageId: uniq("m") });
    assert.equal(third.ok, false, "第 3 条应该被限频");
    assert.equal(third.silent, false, "限频是给自己人的，必须回复提示");
    assert.match(third.reason, /频繁/, "提示语要能看懂");
  });
});

test("限频：不同用户各自独立计数", async () => {
  await withRate(1, 0, () => {
    const a = allowedUser("ou_a");
    const b = allowedUser("ou_b");

    assert.equal(admit({ senderId: a, messageId: uniq("m") }).ok, true);
    assert.equal(
      admit({ senderId: a, messageId: uniq("m") }).ok,
      false,
      "a 的桶应该已耗尽",
    );
    assert.equal(
      admit({ senderId: b, messageId: uniq("m") }).ok,
      true,
      "b 有自己的桶，不该受影响",
    );
  });
});

test("★ 顺序：陌生人的消息不该消耗限频令牌", async () => {
  await withRate(1, 0, () => {
    // 陌生人狂发 5 条 —— 全在第 ① 步被拦
    for (let i = 0; i < 5; i++) {
      const v = admit({ senderId: uniq("ou_stranger"), messageId: uniq("m") });
      assert.equal(v.ok, false, "陌生人应被准入拦住");
    }

    // 合法用户的令牌应该完好无损
    const v = admit({ senderId: allowedUser("ou_victim"), messageId: uniq("m") });
    assert.equal(v.ok, true, "陌生人不该消耗白名单用户的令牌");
  });
});

test("限频：令牌会随时间补充", async () => {
  await withRate(1, 6000, async () => {
    // refillPerMin = 6000 -> 100 个/秒
    const user = uniq("ou_refill"); // 这里直接测 checkRate，不经过准入

    assert.equal(checkRate(user).ok, true, "第一个应该拿到");
    assert.equal(checkRate(user).ok, false, "立刻再来应该没有");

    await new Promise((r) => setTimeout(r, 60)); // 60ms -> 约 6 个令牌
    assert.equal(checkRate(user).ok, true, "等一会儿应该补回来");
  });
});

test("限频：桶容量是【创建时】定的（之后改配置不影响已存在的桶）", async () => {
  const user = uniq("ou_fixed");

  await withRate(3, 0, () => {
    assert.equal(checkRate(user).ok, true);
  });

  // 换成很小的容量，但 user 的桶已经按 3 建好了
  await withRate(0.5, 0, () => {
    assert.equal(
      checkRate(user).ok,
      true,
      "已存在的桶不受新配置影响（这是有意的：避免运行中改配置导致状态跳变）",
    );
  });
});