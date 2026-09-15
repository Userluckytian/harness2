// folds.ts — G-05 块折叠与视图状态机（纯 reducer，headless 可测，零旧壳/零渲染）。
//
// 规格键位（refs-grok-build.md G-05）：
// - h / l（或 ← / →）：折叠 / 展开当前聚焦块（方向性：h 收、l 开，不是 toggle）
// - e：切折叠（toggle）当前聚焦块
// - Shift+E：全部展开
// - Ctrl+E：thinking 块开合（存在展开态 thinking → 全收；否则全开）
// - r：原始 markdown 视图开关（全局视图标志，与折叠正交）
// - [scrollback.scroll] respect_manual_folds：控制**自动**折叠是否覆盖**手动**折叠
//
// 语义裁决（钉死）：
// - 折叠状态按块 id 记账：{ collapsed, manual }。manual = 该块的当前开合态由用户键位
//   造成（含 Shift+E / Ctrl+E 这类批量用户动作）；register/autoFold 初始折叠不算手动。
// - respect_manual_folds = true（缺省，对齐 grok「尊重手动折叠」直觉）：autoFold 跳过
//   manual 块——自动折叠永不覆盖手动折叠。= false：autoFold 覆盖一切（写入目标开合态
//   并清 manual 标记——手动决策已被覆盖，标记随之失效）。
// - 未注册的块 id 上的键位动作一律 no-op（折叠记账只能由 register 建立账目，不给
//   幽灵块发状态）；块账目由投影/装配层（第三批）在转录条目入列表时 register。
// - rawMarkdown 是全局视图开关（r 切换），不进逐块记账；渲染层据此选原始文本投影。
//
// 配置形状：[scrollback.scroll] respect_manual_folds（布尔，缺省 true）。
// core config schema 已加性落地 scrollback 顶层段（schema.ts，P2-C；同 mode.ts 的 [ui]
// 段——KNOWN_TOP_KEYS 含 scrollback），本模块钉死的形状与解析即其对齐的消费端。
//
// 块种类：thinking / tool / diff / message 四类够覆盖 harness2 转录条目形态
// （projection.ts 的 kind 集合在此的折叠相关投影）；Ctrl+E 只作用于 thinking 类。
/** 可折叠块种类 */
export type FoldableBlockKind = 'thinking' | 'tool' | 'diff' | 'message';

/** 注册新块的规格（id 稳定唯一；defaultCollapsed = 该类块的默认折叠态） */
export interface FoldBlockSpec {
  readonly id: string;
  readonly kind: FoldableBlockKind;
  readonly defaultCollapsed: boolean;
}

/** 单块折叠记账：collapsed = 当前开合；manual = 当前开合是否出自用户键位 */
export interface FoldBlockState {
  readonly collapsed: boolean;
  readonly manual: boolean;
}

/** 折叠状态机整体（纯数据；blocks/kinds 用新 Map 替换，绝不原地改写） */
export interface FoldsState {
  readonly blocks: ReadonlyMap<string, FoldBlockState>;
  readonly kinds: ReadonlyMap<string, FoldableBlockKind>;
  /** 原始 markdown 视图（r 键全局切换；false = 正常渲染投影） */
  readonly rawMarkdown: boolean;
  /** [scrollback.scroll] respect_manual_folds（缺省 true：自动折叠不覆盖手动折叠） */
  readonly respectManualFolds: boolean;
}

/** 配置路径常量（与 refs-grok-build.md G-05 记法一致） */
export const RESPECT_MANUAL_FOLDS_CONFIG_PATH = 'scrollback.scroll.respect_manual_folds';

/** 缺省状态：无块、正常 markdown 视图、尊重手动折叠 */
export function emptyFoldsState(respectManualFolds = true): FoldsState {
  return { blocks: new Map(), kinds: new Map(), rawMarkdown: false, respectManualFolds };
}

export type FoldAction =
  /** 新块入账（已有 id 重登记：更新 kind，保留既有开合态——id 稳定语义） */
  | { readonly type: 'register'; readonly blocks: readonly FoldBlockSpec[] }
  /** h / ←：折叠聚焦块 */
  | { readonly type: 'collapse'; readonly blockId: string }
  /** l / →：展开聚焦块 */
  | { readonly type: 'expand'; readonly blockId: string }
  /** e：切折叠聚焦块 */
  | { readonly type: 'toggle'; readonly blockId: string }
  /** Shift+E：全部展开 */
  | { readonly type: 'expandAll' }
  /** Ctrl+E：thinking 块开合（有展开 thinking → 全收；否则全开） */
  | { readonly type: 'toggleThinking' }
  /** r：原始 markdown 视图开关 */
  | { readonly type: 'toggleRawMarkdown' }
  /** 自动折叠事件（转录投影的默认折叠规则推送；受 respect_manual_folds 约束） */
  | {
      readonly type: 'autoFold';
      readonly updates: readonly { readonly blockId: string; readonly collapsed: boolean }[];
    }
  /** 配置应用（运行期改 respect_manual_folds，如配置热加载） */
  | { readonly type: 'setRespectManualFolds'; readonly value: boolean };

/** G-05 键位（键位表的单一事实来源：h/l/←/→/e/Shift+E/Ctrl+E/r） */
export type FoldKey = 'h' | 'l' | 'ArrowLeft' | 'ArrowRight' | 'e' | 'Shift+E' | 'Ctrl+E' | 'r';

/** 键位 → 折叠动作；focusedBlockId 缺失时块级键位（h/l/e）无动作（全局键不受影响） */
export function foldKeyToAction(key: FoldKey, focusedBlockId: string | null): FoldAction | null {
  switch (key) {
    case 'h':
    case 'ArrowLeft':
      return focusedBlockId === null ? null : { type: 'collapse', blockId: focusedBlockId };
    case 'l':
    case 'ArrowRight':
      return focusedBlockId === null ? null : { type: 'expand', blockId: focusedBlockId };
    case 'e':
      return focusedBlockId === null ? null : { type: 'toggle', blockId: focusedBlockId };
    case 'Shift+E':
      return { type: 'expandAll' };
    case 'Ctrl+E':
      return { type: 'toggleThinking' };
    case 'r':
      return { type: 'toggleRawMarkdown' };
    default:
      return null;
  }
}

/** 键位入口（foldKeyToAction + reduceFolds 组合的语法糖） */
export function reduceFoldKey(state: FoldsState, key: FoldKey, focusedBlockId: string | null): FoldsState {
  const action = foldKeyToAction(key, focusedBlockId);
  return action === null ? state : reduceFolds(state, action);
}

/** 手动开合统一落账（collapsed 为目标态；manual=true） */
function withManual(state: FoldsState, blockId: string, collapsed: boolean): FoldsState {
  if (!state.blocks.has(blockId)) return state; // 幽灵块 no-op
  const blocks = new Map(state.blocks);
  blocks.set(blockId, { collapsed, manual: true });
  return { ...state, blocks };
}

/** 主 reducer（纯函数：同状态 + 同动作 → 同新状态；无变化返回原引用） */
export function reduceFolds(state: FoldsState, action: FoldAction): FoldsState {
  switch (action.type) {
    case 'register': {
      const blocks = new Map(state.blocks);
      const kinds = new Map(state.kinds);
      for (const spec of action.blocks) {
        kinds.set(spec.id, spec.kind);
        const existing = blocks.get(spec.id);
        if (existing === undefined) {
          blocks.set(spec.id, { collapsed: spec.defaultCollapsed, manual: false });
        }
        // 重登记保留既有开合态（id 稳定语义：投影层可能重复推送同一块）
      }
      return { ...state, blocks, kinds };
    }
    case 'collapse':
      return withManual(state, action.blockId, true);
    case 'expand':
      return withManual(state, action.blockId, false);
    case 'toggle': {
      const cur = state.blocks.get(action.blockId);
      if (cur === undefined) return state;
      return withManual(state, action.blockId, !cur.collapsed);
    }
    case 'expandAll': {
      if (state.blocks.size === 0) return state;
      const blocks = new Map<string, FoldBlockState>();
      for (const id of state.blocks.keys()) blocks.set(id, { collapsed: false, manual: true });
      return { ...state, blocks };
    }
    case 'toggleThinking': {
      const thinking = [...state.blocks.entries()].filter(([id]) => state.kinds.get(id) === 'thinking');
      if (thinking.length === 0) return state;
      const anyExpanded = thinking.some(([, b]) => !b.collapsed);
      const blocks = new Map(state.blocks);
      for (const [id] of thinking) blocks.set(id, { collapsed: anyExpanded, manual: true });
      return { ...state, blocks };
    }
    case 'toggleRawMarkdown':
      return { ...state, rawMarkdown: !state.rawMarkdown };
    case 'autoFold': {
      const overrides = new Map<string, boolean>();
      for (const u of action.updates) overrides.set(u.blockId, u.collapsed);
      if (overrides.size === 0) return state;
      let changed = false;
      const blocks = new Map(state.blocks);
      for (const [blockId, collapsed] of overrides) {
        const cur = blocks.get(blockId);
        if (cur === undefined) continue; // 幽灵块 no-op
        if (state.respectManualFolds && cur.manual) continue; // 手动折叠神圣不可侵犯
        if (cur.collapsed === collapsed) continue;
        // 落账一律 manual=false：respect=true 时被跳过的 manual 块到不了这里；
        // respect=false 覆盖手动时手动标记随之失效（手动决策被自动规则接管）
        blocks.set(blockId, { collapsed, manual: false });
        changed = true;
      }
      return changed ? { ...state, blocks } : state;
    }
    case 'setRespectManualFolds':
      return state.respectManualFolds === action.value ? state : { ...state, respectManualFolds: action.value };
    default:
      return state;
  }
}

/** 查询：块当前是否折叠（未注册 = 未折叠——注册前不参与折叠渲染） */
export function isCollapsed(state: FoldsState, blockId: string): boolean {
  return state.blocks.get(blockId)?.collapsed ?? false;
}

/**
 * 解析 respect_manual_folds 原始配置值：布尔原样；其余 → null（调用方回退缺省并告警）。
 * 配置 JSON 布尔直出，不做字符串 'true' 宽容（与 core schema 的严格口径一致）。
 */
export function parseRespectManualFolds(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null;
}
