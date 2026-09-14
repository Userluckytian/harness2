// 视图选择规则（D-31）——**纯函数**，无状态、无副作用、同入参同出参。
//
// 规则（优先级严格自上而下）：
//   1. 有效持久选择：持久值非空**且**已在已注册 keys 中 → 选它；
//   2. 否则：已注册 `chat` → 选 'chat'；
//   3. 否则：不渲染（返回 null）。
// **绝不选「第一个注册的」** —— 「首个注册项」在注册顺序里只是巧合，不是契约；
// 把它当回落会让「Trajectory 先注册」这类装配顺序变化悄悄改变默认视图。
//
// 持久选择的读写由注入缝提供（见 view-ring 的 ViewSelectionPersistence / D-14 口径：
// 面板几何不持久化；视图选择的持久性由宿主注入，本模块不碰任何浏览器存储）。

import { CHAT_VIEW_KEY } from './view-keys.js';

/** 内置主视图 key（D-31 的回落目标；字面量唯一来源见 `view-keys.ts`） */
export { CHAT_VIEW_KEY };

/**
 * 会话状态（选择规则的第三类输入）：
 * 没有可渲染的会话时，视图环不渲染任何视图 —— 与「没有匹配视图」同样是 null。
 */
export interface ConversationSessionState {
  /** 是否存在可渲染的会话（无选中会话 = false） */
  readonly active: boolean;
}

/** 选择规则输入 */
export interface ViewSelectionInput {
  /** 已注册视图 key（注册顺序；来自 ConversationViewRegistry.keys()） */
  readonly registeredKeys: readonly string[];
  /** 持久化的视图选择（原始值；缺失 = null） */
  readonly persisted: string | null;
  readonly session: ConversationSessionState;
}

/**
 * 选择当前应渲染的视图 key；`null` = 不渲染。
 * @see ViewSelectionInput 三分支规则的详细口径
 */
export function selectConversationView(input: ViewSelectionInput): string | null {
  // 无会话 → 无视图（在此之后才谈持久选择，避免「会话不存在却记住标签」产生幽灵视图）
  if (!input.session.active) return null;

  const persisted = normalizePersisted(input.persisted);
  if (persisted !== null && input.registeredKeys.includes(persisted)) return persisted;

  if (input.registeredKeys.includes(CHAT_VIEW_KEY)) return CHAT_VIEW_KEY;

  // 落到这里 = 既没有有效持久选择、也没有注册 chat：不渲染（**绝不**回落 registeredKeys[0]）
  return null;
}

/** 持久值归一化：null / 空白一律视为「没有持久选择」 */
function normalizePersisted(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
