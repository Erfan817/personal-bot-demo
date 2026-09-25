/**
 * 大脑层 · 模型集合
 * ═══════════════════════════════════════════════════
 * pi-ai 0.87 的新模型：不再有全局 getModel()，
 * 而是先建一个「provider 集合」，再从集合里查模型。
 *
 *   集合负责：认证、请求协议、流式解析、成本统计
 *   Agent 只负责：循环
 *
 * 分开的好处：随时换 provider，循环一行不用改。
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { config } from "../config.mjs";

/** 一次注册所有内置 provider（44 个，含中国区 moonshotai-cn / zai-coding-cn 等） */
export const models = builtinModels();

/** 取出配置里指定的模型；找不到就列出可选值，方便排错 */
export function resolveModel() {
  const { provider, name } = config.model;

  const model = models.getModel(provider, name);
  if (model) return model;

  const available = models.getModels(provider).map((m) => m.id);
  throw new Error(
    `找不到模型 ${provider}/${name}\n` +
      (available.length
        ? `  ${provider} 下可用：${available.join(", ")}`
        : `  没有名为 "${provider}" 的 provider`),
  );
}