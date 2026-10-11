// 对话页视图层导出面。
// Z2-05：视图环 / 视图注册表 / 视图选择规则已退役（Z-16 主区事实单一 chat；trajectory 迁右栏
// tab）。本目录只剩 D-39 图片 URL 缓存 —— 由壳注入读取缝，交给需要图片的视图（右栏轨迹 tab）。
export { createImageUrlCache, ImageUrlCache, ImageUrlCacheError } from './image-url-cache.js';
export type {
  ConversationImageAttachment,
  ConversationImageReader,
  ConversationImageUrlResolver,
  ImageUrlCacheOptions,
  SessionImageUrlResolver,
} from './image-url-cache.js';
