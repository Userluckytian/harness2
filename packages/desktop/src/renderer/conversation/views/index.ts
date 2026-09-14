// 对话页视图层（P5-A / D-30～D-32、D-39）导出面。
// 装配（把真实会话 store 接进视图环）留给接线棒；本目录只提供注册表 + 选择规则 + 视图环 + 图片缓存。
export {
  ConversationViewRegistry,
  ConversationViewRegistryError,
  createConversationViewRegistry,
  emptyViewEntries,
} from './view-registry.js';
export type { ConversationViewDefinition, ConversationViewEntry, ConversationViewProps } from './view-registry.js';
export { CHAT_VIEW_KEY, selectConversationView } from './view-selection.js';
export type { ConversationSessionState, ViewSelectionInput } from './view-selection.js';
export { ConversationViewRing } from './view-ring.js';
export type { ConversationSessionBinding, ConversationViewRingProps, ViewSelectionPersistence } from './view-ring.js';
export { createImageUrlCache, ImageUrlCache, ImageUrlCacheError } from './image-url-cache.js';
export type {
  ConversationImageAttachment,
  ConversationImageReader,
  ConversationImageUrlResolver,
  ImageUrlCacheOptions,
  SessionImageUrlResolver,
} from './image-url-cache.js';
