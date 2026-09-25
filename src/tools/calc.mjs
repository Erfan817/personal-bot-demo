/**
 * 工具 · 数学计算
 *
 * 两个注意点：
 *   1. 框架约定：工具失败要 throw，不要把错误文本当结果返回
 *   2. execute 里自己做输入校验 —— 工具层的最后一道防线
 */
import { Type } from "typebox";

export default {
  name: "calc",
  label: "数学计算",
  description:
    "计算一个数学表达式。用户问「123 乘 456 等于多少」这类问题时使用。",
  parameters: Type.Object({
    expr: Type.String({ description: "纯数学表达式，例如 123 * 456" }),
  }),

  async execute(toolCallId, params) {
    const expr = params.expr ?? "";

    // 白名单字符：只允许数字和四则运算符
    if (!/^[0-9+\-*/(). ]+$/.test(expr)) {
      throw new Error("表达式含非法字符（只允许 0-9 和 + - * / ( )）");
    }

    const value = Function(`"use strict"; return (${expr})`)();
    return { content: [{ type: "text", text: String(value) }] };
  },
};