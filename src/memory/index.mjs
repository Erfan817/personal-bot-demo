/**
 * 记忆层 —— 统一出口
 */
export { db } from "./db.mjs";
export {
  saveMessage,
  loadRecent,
  clearChat,
  countAll,
} from "./messages.mjs";
export { searchHistory } from "./search.mjs";