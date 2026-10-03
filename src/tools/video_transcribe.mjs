/**
 * 工具 · 视频音频转写（无字幕兜底）
 * ═══════════════════════════════════════════════════
 * B站的 AI 字幕只覆盖一部分视频 —— 没有字幕的视频，总结就只剩
 * 官方简介可用。本工具补上兜底链路：
 *
 *   bvid/链接 → yt-dlp 下载音频（带登录凭证，绕开 412 风控）
 *             → 硅基流动 SenseVoice 语音转文字 → 返回全文
 *
 * 编排原则：总结视频时【先】走 mcp_bili_subtitle（便宜、分句准），
 * 拿不到字幕【再】用本工具（慢、占带宽）—— 这个优先级写进
 * 系统提示词，也写在本工具的 description 里给模型看。
 *
 * 成本与限制：
 *   · 转写走硅基流动 SenseVoice，免费额度；音频须 < maxAudioMb
 *     （超长视频当前直接拒绝并说明，分段转写是后续工作）
 *   · 整条链路耗时可能 1-3 分钟 —— AGENT_TIMEOUT_MS 要留够
 */
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, statSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.mjs";
import {
  resolveBvid,
  buildCookieHeader,
  audioDownloadArgs,
  parseTranscription,
  formatBytes,
} from "./lib/video.mjs";

const execFileAsync = promisify(execFile);
const out = (text) => ({ content: [{ type: "text", text }] });

export default {
  name: "video_transcribe",
  label: "视频转写",

  description:
    "下载B站视频音频并转写成文字 —— 字幕工具的兜底。" +
    "总结B站视频时【必须先用 mcp_bili_subtitle 拿字幕】；" +
    "只有当字幕返回为空、无字幕或报错时，才用本工具把音频转成文字再总结。" +
    "接受 BV 号、完整链接和 b23.tv 短链。" +
    "注意：转写耗时 1-3 分钟属正常；超长视频（音频超限）会明确报错。" +
    "未配置 SILICONFLOW_API_KEY 时本工具不可用，此时如实告诉用户无法获取该视频的语音内容，不要编造。",

  parameters: Type.Object({
    url_or_bvid: Type.String({
      description: "B站视频：BV 号、完整链接或 b23.tv 短链",
    }),
  }),

  async execute(_toolCallId, params) {
    const { siliconflowKey, model, ytdlp, credentialFile, maxAudioMb } = config.transcribe;

    const bvid = await resolveBvid(params.url_or_bvid);
    if (!bvid) {
      throw new Error("没能从输入里解析出 BV 号，确认是一个B站视频链接或 BV 号");
    }

    // ── 1. 下载音频（带凭证：匿名访问会被 B站 412 风控拦下） ──
    let cookie = "";
    if (existsSync(credentialFile)) {
      try {
        cookie = buildCookieHeader(JSON.parse(readFileSync(credentialFile, "utf8")));
      } catch {
        // 凭证文件坏了就匿名下载 —— 部分视频依然可行，让后面的错误说话
      }
    }

    const dir = mkdtempSync(join(tmpdir(), `transcribe-${randomUUID().slice(0, 8)}-`));
    try {
      const args = audioDownloadArgs(bvid, dir);
      if (cookie) args.push("--add-headers", `Cookie: ${cookie}`);
      try {
        await execFileAsync(ytdlp, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (e) {
        throw new Error(`音频下载失败（${bvid}）：${String(e.message).slice(0, 200)}`);
      }

      const files = readdirSync(dir).filter((f) => f.startsWith("audio."));
      if (!files.length) throw new Error("音频下载失败：yt-dlp 没有产出文件");
      const audioPath = join(dir, files[0]);
      const size = statSync(audioPath).size;
      const limit = maxAudioMb * 1024 * 1024;
      if (size > limit) {
        throw new Error(
          `音频 ${formatBytes(size)} 超过转写上限 ${maxAudioMb}MB（视频太长）。` +
            `分段转写尚未实现，只能处理较短的视频`,
        );
      }

      // ── 2. 语音转写（硅基流动 SenseVoice） ──
      if (!siliconflowKey) {
        throw new Error(
          "未配置 SILICONFLOW_API_KEY —— 转写功能不可用。" +
            "在 siliconflow.cn 免费注册拿 key，写进 .env 后重启生效",
        );
      }
      const form = new FormData();
      form.append("file", new Blob([readFileSync(audioPath)]), files[0]);
      form.append("model", model);
      let resp;
      try {
        resp = await fetch("https://api.siliconflow.cn/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${siliconflowKey}` },
          body: form,
        });
      } catch (e) {
        throw new Error(`转写服务请求失败：${e.message}`);
      }
      if (!resp.ok) {
        throw new Error(`转写服务返回 ${resp.status}：${(await resp.text()).slice(0, 200)}`);
      }
      const text = parseTranscription(await resp.json());
      if (!text) throw new Error("转写服务返回了空文本（视频可能全程无语音）");
      return out(`音频转写完成（${formatBytes(size)}，共 ${text.length} 字）：\n${text}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
