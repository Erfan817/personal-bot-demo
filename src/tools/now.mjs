/**
 * 工具 · 当前时间
 *
 * 「模型做不到但工具做得到」的典型例子：
 * 模型不知道现在是几点，只能靠工具去问系统。
 */
import { Type } from "typebox";

export default {
  name: "now",
  label: "当前时间",
  description:
    "获取服务器当前时间（北京时间）。任何时候需要知道「现在几点」都应调用它。",
  parameters: Type.Object({}),

  async execute() {
    const text = new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    });
    return { content: [{ type: "text", text }] };
  },
};