/**
 * 视频转写 · 纯函数库（离线可单测）
 *
 * 管线定位：mcp_bili_subtitle 依赖 B站 AI 字幕，很多视频没有；
 * 本模块支撑 video_transcribe 工具的兜底链路 —— 下载音频 → 语音转写。
 * 网络与子进程的薄壳在 video_transcribe.mjs，可测的逻辑都在这里。
 */

/** 从任意输入（裸 BV 号 / 完整链接 / 含 BV 的文本）里提取 bvid */
export function parseBvid(input) {
  const m = String(input ?? "").match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

/**
 * 解析 bvid：直接可提取就直接给；b23.tv 短链里没有 BV，
 * 需要跟随跳转后从最终 URL 里拿。fetchImpl 可注入（测试用）。
 */
export async function resolveBvid(input, fetchImpl = fetch) {
  const direct = parseBvid(input);
  if (direct) return direct;
  const s = String(input ?? "").trim();
  if (!/^https?:\/\//.test(s)) return null;
  try {
    const resp = await fetchImpl(s, { redirect: "follow" });
    return parseBvid(resp.url || "");
  } catch {
    return null;
  }
}

/** 由凭证对象拼 B站 Cookie 头；buvid3 缺失时生成一个（B站用它做设备指纹，412 防御相关） */
export function buildCookieHeader(cred = {}) {
  const buvid3 = cred.buvid3 || `${crypto.randomUUID()}infoc`;
  const parts = [];
  if (cred.sessdata) parts.push(`SESSDATA=${cred.sessdata}`);
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`);
  if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`);
  parts.push(`buvid3=${buvid3}`);
  return parts.join("; ");
}

/** yt-dlp 参数：最优纯音频、不进分P列表、输出到指定目录 */
export function audioDownloadArgs(bvid, outDir) {
  return [
    "-f", "ba/b",
    "--no-playlist",
    "--no-warnings",
    "--add-headers", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-headers", "Referer: https://www.bilibili.com/",
    "-o", `${outDir}/audio.%(ext)s`,
    `https://www.bilibili.com/video/${bvid}`,
  ];
}

/** 从 SiliconFlow 转写响应里取文本 */
export function parseTranscription(json) {
  const text = String(json?.text ?? "").trim();
  return text;
}

/** 字节数 → 人话大小 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}
