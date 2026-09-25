/**
 * 纯函数 + DNS 查询：拦住「指向内网/本机」的 URL（SSRF 防护）
 * ═══════════════════════════════════════════════════
 * web_fetch 会抓任意 URL，而 agent 会听网页内容的话（提示注入）——
 * 经典攻击链是：诱导 agent 抓一个恶意页面，页面文本再让它去访问内网。
 * 所以必须在工具层挡掉这些目标：
 *
 *   · 127.0.0.0/8、localhost       本机服务
 *   · 10/8、172.16/12、192.168/16  内网
 *   · 169.254.0.0/16               链路本地（云元数据 169.254.169.254 在这）
 *   · 0.0.0.0/8、224/4 以上        未指定 / 组播 / 保留
 *   · ::1、fc00::/7、fe80::/10     IPv6 对应范围
 *
 * 两道检查（lib 其余部分一样：不发请求、可离线单测）：
 *   ① 主机名本身是 IP 或 localhost —— 直接判，快，覆盖显式写法
 *   ② 是域名 —— 先 DNS 解析，对解析出的每个 IP 再判一遍
 *      （顺带堵住 2130706433 这种十进制 IP 的绕过写法：
 *       它解析出来就是 127.0.0.1，②会拦住；解析不了也会被拒）
 *
 * 已知残余风险：DNS rebinding（两次解析结果不同）没防 ——
 * 那需要把解析结果钉进请求本身，对个人 bot 是过度设计，接受。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 一个 IP 是否落在私网 / 环回 / 链路本地等「不该让 agent 摸到」的范围 */
export function isPrivateIp(ip) {
  const s = String(ip ?? "").trim();

  // ── IPv4 ──
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // 0.0.0.0/8 未指定
    if (a === 10) return true; // 10/8 内网
    if (a === 127) return true; // 环回
    if (a === 169 && b === 254) return true; // 链路本地（云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 内网
    if (a === 192 && b === 168) return true; // 192.168/16 内网
    if (a >= 224) return true; // 组播 + 保留段
    return false;
  }

  // ── IPv6 ──
  const v6 = s.toLowerCase();
  // IPv4-mapped（::ffff:10.0.0.1）先转回 IPv4 再判
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]);
  if (v6 === "::" || v6 === "::1") return true; // 未指定 / 环回
  if (v6.startsWith("f")) return true; // fe80::/10 链路本地、fc00::/7 unique-local、ff00::/8 组播
  return false;
}

/**
 * 主机名能不能直接判「内网」？
 * 返回 false 不代表公网 —— 只说明「是域名，要走 DNS 解析后再判」。
 */
export function isPrivateHostname(hostname) {
  // WHATWG URL 的 hostname 对 IPv6 保留方括号（"[::1]"），先剥掉
  const h = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h)) return isPrivateIp(h);
  return false;
}

/**
 * 校验一个 URL 可以安全外发：协议 + 主机 + 解析结果三关。
 * 通过返回 URL 对象（可直接喂给 fetch），不通过就 throw 明确的错误。
 *
 * @param {string} url
 * @param {{lookupFn?: typeof lookup}} opts lookupFn 供测试注入假 DNS
 */
export async function assertPublicUrl(url, { lookupFn = lookup } = {}) {
  let u;
  try {
    u = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("网址格式不对");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("网址必须以 http:// 或 https:// 开头");
  }

  const host = u.hostname;
  if (isPrivateHostname(host)) {
    throw new Error(`禁止访问内网/本机地址：${host}`);
  }

  let addrs;
  try {
    addrs = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`域名解析失败：${host}`);
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error(`域名解析失败：${host}`);
  }
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) {
    throw new Error(`禁止访问内网地址：${host} → ${bad.address}`);
  }
  return u;
}
