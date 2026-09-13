// block-ops.ts — G-06 块内容操作动作表（纯逻辑，headless 可测）。
//
// 规格键位（refs-grok-build.md G-06）：
// - y：复制块正文
// - Shift+Y：复制块正文 + 元数据（角色/时间戳/工具名等，由装配层拼进 metadata）
// - Enter / Ctrl+F：全屏查看器打开该块（两键同动作，grok 双入口）
//
// 边界钉死：本层只产出「动作描述对象」并解析出剪贴板文本/查看器意图——**剪贴板与
// 全屏查看器都由调用方注入回调**（BlockOpCallbacks）。本阶段提供空实现注入点
// noopBlockOpCallbacks（所有回调缺省，dispatch 自然 no-op），不做假 UI、不接假剪贴板；
// 真实注入（系统剪贴板 / 查看器浮层）是第三批接线的事。
//
// 与 folds.ts 的关系：折叠决定块渲染形态，块操作作用于「聚焦块」的内容本体——两者
// 正交，本层不读折叠状态；聚焦块的选择由焦点模型（G-08，后续批次）给出。
/** 块操作键位（G-06） */
export type BlockOpKey = 'y' | 'Shift+Y' | 'Enter' | 'Ctrl+F';

/** 动作类型：复制正文 / 复制正文+元数据 / 打开全屏查看器 */
export type BlockOpActionType = 'copy-body' | 'copy-with-metadata' | 'open-viewer';

/** 动作描述对象（键位表 → 动作的唯一产物；可序列化，便于测试与事件记录） */
export interface BlockOpAction {
  readonly type: BlockOpActionType;
  /** 触发键位（记录用：同一动作可能有多入口，如 Enter / Ctrl+F） */
  readonly key: BlockOpKey;
}

/**
 * 键位表（G-06 的单一事实来源）。
 * 未知键位返回 null——本表只认四个键，其余键位归焦点/滚动/折叠各层。
 */
export function blockOpForKey(key: BlockOpKey): BlockOpAction | null {
  switch (key) {
    case 'y':
      return { type: 'copy-body', key };
    case 'Shift+Y':
      return { type: 'copy-with-metadata', key };
    case 'Enter':
    case 'Ctrl+F':
      return { type: 'open-viewer', key };
    default:
      return null;
  }
}

/** 被操作块的内容快照（装配层从转录条目投影而来；id 与折叠记账的块 id 同一空间） */
export interface BlockContent {
  readonly id: string;
  /** 正文（y 的复制目标） */
  readonly body: string;
  /** 元数据行（Shift+Y 的附加复制目标；角色/时间戳/工具名等，逐行给出） */
  readonly metadata?: readonly string[];
}

/** 纯解析结果：动作 + 剪贴板意图 + 查看器意图（无副作用，直接断言） */
export interface BlockOpResult {
  readonly action: BlockOpAction;
  /** 应写入剪贴板的文本（open-viewer 动作为 null） */
  readonly clipboardText: string | null;
  /** 是否应打开全屏查看器 */
  readonly openViewer: boolean;
}

/**
 * 动作 → 纯结果（不碰剪贴板不碰 UI）：
 * - copy-body：正文原样。
 * - copy-with-metadata：元数据行在上、正文在下，以 \n 连接；无元数据时退化为正文
 *   （与 copy-body 同文本，但动作类型不同——事件记录仍可区分入口）。
 * - open-viewer：clipboardText 为 null，openViewer = true。
 */
export function resolveBlockOp(action: BlockOpAction, block: BlockContent): BlockOpResult {
  if (action.type === 'open-viewer') {
    return { action, clipboardText: null, openViewer: true };
  }
  const meta = action.type === 'copy-with-metadata' ? (block.metadata ?? []) : [];
  const text = [...meta, block.body].join('\n');
  return { action, clipboardText: text, openViewer: false };
}

/**
 * 宿主注入点：剪贴板与全屏查看器的真实实现由装配层（第三批）提供。
 * 两回调都可缺省——缺省即 no-op（本阶段唯一合法形态，杜绝假 UI）。
 */
export interface BlockOpCallbacks {
  /** 写剪贴板（kind 标记复制口径，供宿主做提示行反馈） */
  copyText?(text: string, meta: { readonly blockId: string; readonly kind: 'body' | 'body+metadata' }): void;
  /** 打开全屏查看器 */
  openViewer?(block: BlockContent): void;
}

/** 空实现注入点：全部回调缺省 = dispatch 天然 no-op（G-06 本阶段不做假 UI 的落点） */
export const noopBlockOpCallbacks: BlockOpCallbacks = {};

/**
 * 键位 → 动作 → 纯结果 → 注入回调执行（一步到位的调用入口）。
 * 返回纯结果供调用方记录/断言；未知键位返回 null（不执行任何回调）。
 */
export function dispatchBlockOp(
  key: BlockOpKey,
  block: BlockContent,
  callbacks: BlockOpCallbacks = noopBlockOpCallbacks,
): BlockOpResult | null {
  const action = blockOpForKey(key);
  if (action === null) return null;
  const result = resolveBlockOp(action, block);
  if (result.clipboardText !== null) {
    callbacks.copyText?.(result.clipboardText, {
      blockId: block.id,
      kind: action.type === 'copy-with-metadata' ? 'body+metadata' : 'body',
    });
  }
  if (result.openViewer) callbacks.openViewer?.(block);
  return result;
}
