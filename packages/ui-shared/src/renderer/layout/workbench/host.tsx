// 分屏工作台宿主（Z2-06 / Z-19）——主区 conversation 面板内的二叉分割渲染。
//
// 结构（递归）：split 容器（flex + `--ratio`）→ 两子节点 + 一条分隔条（role=separator）。
// 每格渲染一个 `ConversationSeat`（绑定该格的会话 id）；非主格右上角有浮动关闭按钮（Z-19）。
//
// 关键语义：
//   * **只在主区 conversation 面板内生效**（本组件是 conversation 内容的实现），Z2-03 的内层
//     conversation | terminal 分栏保持不变（分屏发生在 conversation 面板内部）。
//   * **未分屏（只有一格）时无任何分屏 UI 痕迹**：不渲染分隔条 / 关闭按钮 / 落点预览。
//   * 关闭格 **≠** 停止会话：只移除布局叶，会话流仍在 store 后台运行。
//   * 拖拽技术选型 = HTML5 `draggable`（理由见交付说明）：原生机制、行本身是 button 不冲突、
//     `dragover` 自带坐标可算边缘带；模块级 `workbenchDrag` 仅作 jsdom 单测回退。
//   * 状态只存内存（`workbenchStore` 单例），**不落盘**（D-14 约束，见 store.ts 头注释）。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, ComponentType, ReactNode } from 'react';
import type { Controller } from '../../app-controller.js';
import type { AppStore } from '../../store.js';
// Z7：席位组件由壳注入（桌面 = 桌面组装根 ConversationSeat，web = 共享 ConversationSeat 或 web 包装）。
// 缺省用共享 ConversationSeat（壳无专属 header/statusPanel 注入时即它）。
import { ConversationSeat as SharedConversationSeat, type ConversationSeatProps } from '../../conversation/seat.js';
import type { ComposerModeSwitchProps, ComposerModelSelectProps } from '../../conversation/composer/Composer.js';
import { createComposerOverlayHost, type ComposerOverlayHost } from '../../trajectory/shell-contract.js';
import { workbenchDrag } from './drag.js';
import {
  MAX_PANES,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  clampRatio,
  countPanes,
  dropSideForRect,
  findLeaf,
  findLeafBySession,
  firstLeafId,
  sessionOfLeaf,
  type SplitDirection,
  type SplitSide,
  type WorkbenchNode,
  type WorkbenchSnapshot,
} from './model.js';
import { workbenchStore, type WorkbenchStore } from './store.js';

/** 分隔条命中区（Z-19：≥8px） */
const SPLITTER_HIT_PX = 8;
/** 提示停留时长 */
const HINT_MS = 2200;

/** Z3-04 composer 左右簇控件 props（壳装配；结构等同桌面 composer-controls-bridge 的 ComposerControls） */
export interface WorkbenchComposerControls {
  readonly modelSelect?: ComposerModelSelectProps;
  readonly modeSwitch?: ComposerModeSwitchProps;
}

interface DropTarget {
  readonly leafId: string;
  readonly side: SplitSide;
}

interface WorkbenchApi {
  readonly store: AppStore;
  readonly controller: Controller;
  /** 每格渲染的会话席位组件（壳注入；缺省 = 共享 ConversationSeat） */
  readonly seat: ComponentType<ConversationSeatProps>;
  readonly snapshot: WorkbenchSnapshot;
  readonly selectedId: string | null;
  /** 主格 = 绑定当前 selectedId 的叶（无绑定时的回落：焦点叶 / 首个叶） */
  readonly primaryId: string;
  readonly dropTarget: DropTarget | null;
  readonly onDragOverLeaf: (leafId: string, event: React.DragEvent<HTMLDivElement>) => void;
  readonly onDragLeaveLeaf: (leafId: string, event: React.DragEvent<HTMLDivElement>) => void;
  readonly onDropLeaf: (leafId: string, event: React.DragEvent<HTMLDivElement>) => void;
  readonly onFocusLeaf: (leafId: string) => void;
  readonly onCloseLeaf: (leafId: string) => void;
  readonly onRatioChange: (splitId: string, ratio: number) => void;
  /** Z3-04：composer 左右簇控件 props（壳装配；缺省 = 不渲染控件，测试与旧调用面不变） */
  readonly composerControls?: WorkbenchComposerControls;
}

const WorkbenchContext = createContext<WorkbenchApi | null>(null);

function useWorkbench(): WorkbenchApi {
  const api = useContext(WorkbenchContext);
  if (api === null) throw new Error('WorkbenchContext 缺失：分屏组件必须在 WorkbenchHost 内渲染');
  return api;
}

/** split 容器样式：方向 + `--ratio` 自定义属性（React 类型不含自定义属性，收口在此） */
function splitContainerStyle(dir: SplitDirection, ratio: number): CSSProperties {
  return {
    display: 'flex',
    flexDirection: dir === 'row' ? 'row' : 'column',
    '--ratio': String(ratio),
  } as unknown as CSSProperties;
}

/** 落点预览半边色块的定位（按 side 取半宽/半高） */
function previewStyle(side: SplitSide): CSSProperties {
  switch (side) {
    case 'left':
      return { left: 0, top: 0, width: '50%', height: '100%' };
    case 'right':
      return { right: 0, top: 0, width: '50%', height: '100%' };
    case 'up':
      return { left: 0, top: 0, width: '100%', height: '50%' };
    case 'down':
      return { left: 0, bottom: 0, width: '100%', height: '50%' };
  }
}

/** 非主格头部：只给会话标题（不含窗控/Side Pane 开关，避免多格重复窗控） */
function PaneHeader({ sessionId, store }: { sessionId: string; store: AppStore }): ReactNode {
  const state = store.getState();
  const summary = state.sessions.find((s) => s.id === sessionId);
  const title = store.displayTitleFor(sessionId) ?? (summary?.firstUserText.trim() || sessionId);
  return (
    <div
      data-testid="workbench-pane-header"
      className="flex min-h-[22px] flex-none items-center gap-2 border-b border-border bg-surface px-2.5 py-1 text-ui-xs text-foreground-subtle"
    >
      <span className="truncate">{title}</span>
    </div>
  );
}

export interface WorkbenchHostProps {
  readonly store: AppStore;
  readonly controller: Controller;
  /** 测试注入独立仓库；缺省 = 应用级内存单例（不落盘） */
  readonly workbench?: WorkbenchStore;
  /** 每格渲染的会话席位组件（壳注入；缺省 = 共享 ConversationSeat，无专属壳注入） */
  readonly seat?: ComponentType<ConversationSeatProps>;
  /** Z3-04：composer 左右簇控件 props（壳经 useComposerControls 装配；缺省不渲染控件） */
  readonly composerControls?: WorkbenchComposerControls;
}

/**
 * 分屏工作台宿主：单格时与旧结构等价（一格会话界面），多格时二叉分割。
 * @param props - 会话数据源（store/controller）、可选状态仓库、可选席位组件与可选 composer 控件 props。
 * @returns 工作台根元素。
 */
export function WorkbenchHost({
  store,
  controller,
  workbench = workbenchStore,
  seat = SharedConversationSeat,
  composerControls,
}: WorkbenchHostProps): ReactNode {
  const appState = useSyncExternalStore(store.subscribe, store.getState);
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot);
  const selectedId = appState.selectedId;

  // 主格跟随左侧选择：selectedId 变化时把主格改绑/聚焦（见 store.syncSelection）
  const previousSelected = useRef<string | null>(null);
  useEffect(() => {
    workbench.syncSelection(selectedId, previousSelected.current);
    previousSelected.current = selectedId;
  }, [workbench, selectedId]);

  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [hint, setHint] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const hintSeq = useRef(0);

  const showHint = useCallback((text: string) => {
    hintSeq.current += 1;
    setHint({ id: hintSeq.current, text });
  }, []);

  useEffect(() => {
    if (hint === null) return undefined;
    const timer = setTimeout(() => setHint((current) => (current?.id === hint.id ? null : current)), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  // 拖拽在任何位置结束（含落在窗口外）都要清掉落点预览，避免残留（左栏 dragend 也会清在途载荷）
  useEffect(() => {
    const clear = (): void => setDropTarget(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const boundPrimary = findLeafBySession(snapshot.bindings, selectedId);
  const primaryId =
    boundPrimary ??
    (findLeaf(snapshot.root, snapshot.focusedId) !== undefined ? snapshot.focusedId : firstLeafId(snapshot.root));

  const onDragOverLeaf = useCallback((leafId: string, event: React.DragEvent<HTMLDivElement>) => {
    // 只认**本工作台发起的**会话行拖拽（模块级在途载荷）：否则页内文字选择拖拽也会带 dataTransfer，
    // 会被误当成「拖会话进分屏」而弹出落点预览（生产路径由左栏 dragstart 置位、dragend 清空）。
    if (workbenchDrag.current() === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const side = dropSideForRect(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    setDropTarget((current) => {
      if (side === null) return current?.leafId === leafId ? null : current;
      if (current !== null && current.leafId === leafId && current.side === side) return current;
      return { leafId, side };
    });
  }, []);

  const onDragLeaveLeaf = useCallback((leafId: string, event: React.DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && event.currentTarget.contains(next)) return;
    setDropTarget((current) => (current?.leafId === leafId ? null : current));
  }, []);

  const onDropLeaf = useCallback(
    (leafId: string, event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sessionId = workbenchDrag.current() ?? event.dataTransfer?.getData('text/plain') ?? '';
      workbenchDrag.end();
      const side =
        dropTarget !== null && dropTarget.leafId === leafId
          ? dropTarget.side
          : dropSideForRect(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
      setDropTarget(null);
      if (sessionId.length === 0) return;
      if (side === null) {
        // 中间区域不分屏（避免误触）：给一次可见提示，不静默
        showHint('拖到面板边缘（左/右/上/下）才能创建分屏');
        return;
      }
      const outcome = workbench.dropSession({ sessionId, targetLeafId: leafId, side });
      if (outcome.ok) return; // 新格已聚焦
      if (outcome.reason === 'duplicate') {
        const existing = outcome.leafId;
        if (existing !== undefined) workbench.focusLeaf(existing);
        if (sessionId !== selectedId) store.select(sessionId);
        showHint('该会话已在分屏中，已聚焦该格');
        return;
      }
      if (outcome.reason === 'limit') {
        showHint(`分屏最多 ${MAX_PANES} 格`);
        return;
      }
      showHint('无法在此创建分屏');
    },
    [dropTarget, selectedId, showHint, store, workbench],
  );

  const onFocusLeaf = useCallback(
    (leafId: string) => {
      const sessionId = sessionOfLeaf(snapshot.bindings, leafId);
      workbench.focusLeaf(leafId);
      if (sessionId !== undefined && sessionId !== selectedId) store.select(sessionId);
    },
    [selectedId, snapshot.bindings, store, workbench],
  );

  const onCloseLeaf = useCallback(
    (leafId: string) => {
      workbench.closeLeaf(leafId, primaryId);
      setDropTarget((current) => (current?.leafId === leafId ? null : current));
      showHint('已关闭该格；会话仍在后台运行');
    },
    [primaryId, showHint, workbench],
  );

  const onRatioChange = useCallback(
    (splitId: string, ratio: number) => workbench.setRatio(splitId, ratio),
    [workbench],
  );

  const api = useMemo<WorkbenchApi>(
    () => ({
      store,
      controller,
      seat,
      snapshot,
      selectedId,
      primaryId,
      dropTarget,
      onDragOverLeaf,
      onDragLeaveLeaf,
      onDropLeaf,
      onFocusLeaf,
      onCloseLeaf,
      onRatioChange,
      ...(composerControls !== undefined ? { composerControls } : {}),
    }),
    [
      store,
      controller,
      seat,
      snapshot,
      selectedId,
      primaryId,
      dropTarget,
      onDragOverLeaf,
      onDragLeaveLeaf,
      onDropLeaf,
      onFocusLeaf,
      onCloseLeaf,
      onRatioChange,
      composerControls,
    ],
  );

  return (
    <WorkbenchContext.Provider value={api}>
      <div
        className="relative flex min-h-0 min-w-0 flex-1"
        data-testid="workbench-root"
        data-panes={countPanes(snapshot.root)}
      >
        {renderNode(snapshot.root)}
        {hint !== null && (
          <div
            role="status"
            data-testid="workbench-hint"
            className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-1 text-ui-xs text-foreground shadow-md"
          >
            {hint.text}
          </div>
        )}
      </div>
    </WorkbenchContext.Provider>
  );
}

/** 递归渲染：叶 → WorkbenchLeaf；分割 → WorkbenchSplit */
function renderNode(node: WorkbenchNode): ReactNode {
  return node.t === 'leaf' ? (
    <WorkbenchLeaf key={node.id} leafId={node.id} />
  ) : (
    <WorkbenchSplit key={node.id} node={node} />
  );
}

/** 分割节点：flex 容器（`--ratio` 控制 a 的 flex-basis）+ 两子节点 + 分隔条 */
function WorkbenchSplit({ node }: { node: Extract<WorkbenchNode, { t: 'split' }> }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1"
      style={splitContainerStyle(node.dir, node.ratio)}
      data-testid="workbench-split"
      data-dir={node.dir}
    >
      <div
        className="flex min-h-0 min-w-0"
        style={{ flexBasis: 'calc(var(--ratio) * 100%)', flexGrow: 0, flexShrink: 0 }}
      >
        {renderNode(node.a)}
      </div>
      <Splitter splitId={node.id} dir={node.dir} ratio={node.ratio} containerRef={containerRef} />
      <div className="flex min-h-0 min-w-0" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0 }}>
        {renderNode(node.b)}
      </div>
    </div>
  );
}

/**
 * 分隔条（Z-19）：命中区 ≥8px、`role=separator`、键盘可调。
 * 拖动时**只改容器的 `--ratio` CSS 变量 + rAF 合帧**，松手才写状态（对齐 ZCode 的「只写 CSS 变量、
 * 松手才 setState」）。比例钳制到 [0.25, 0.75]。
 */
function Splitter({
  splitId,
  dir,
  ratio,
  containerRef,
}: {
  splitId: string;
  dir: SplitDirection;
  ratio: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  const api = useWorkbench();
  const [dragging, setDragging] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  // row 分割 → 竖向分隔条（沿 X 拖动）；column 分割 → 横向分隔条（沿 Y 拖动）
  const vertical = dir === 'row';

  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  const startDrag = (_event: React.PointerEvent<HTMLDivElement>): void => {
    stopRef.current?.();
    const container = containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    const origin = vertical ? rect.left : rect.top;
    const size = vertical ? rect.width : rect.height;
    let pending: number | null = null;
    let frame = 0;
    const apply = (): void => {
      frame = 0;
      if (pending !== null) container.style.setProperty('--ratio', String(pending));
    };
    const onMove = (moveEvent: PointerEvent): void => {
      const position = vertical ? moveEvent.clientX : moveEvent.clientY;
      pending = clampRatio(size > 0 ? (position - origin) / size : ratioRef.current);
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    const stop = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      stopRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      setDragging(false);
      const finalRatio = pending;
      pending = null;
      if (finalRatio !== null) api.onRatioChange(splitId, finalRatio);
      else container.style.setProperty('--ratio', String(ratioRef.current));
    };
    stopRef.current = stop;
    setDragging(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const forward = vertical ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    const backward = vertical ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    api.onRatioChange(splitId, clampRatio(ratio + (forward ? 1 : -1) * SPLIT_STEP));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={vertical ? '调整分屏列宽' : '调整分屏行高'}
      aria-valuenow={ratio}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      tabIndex={0}
      data-testid="workbench-splitter"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      className={`group relative flex-none focus-visible:bg-primary/20 ${
        vertical ? 'cursor-col-resize' : 'cursor-row-resize'
      }`}
      style={vertical ? { width: SPLITTER_HIT_PX } : { height: SPLITTER_HIT_PX }}
    >
      <span
        aria-hidden
        className={
          vertical
            ? 'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/40'
            : 'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border group-hover:bg-primary/40'
        }
      />
    </div>
  );
}

/** 叶（一格）：渲染 ConversationSeat + 焦点标识 + 非主格关闭按钮 + 落点预览 */
function WorkbenchLeaf({ leafId }: { leafId: string }): ReactNode {
  const api = useWorkbench();
  const { snapshot, selectedId, primaryId } = api;
  const binding = sessionOfLeaf(snapshot.bindings, leafId);
  const isPrimary = leafId === primaryId;
  const isFocused = snapshot.focusedId === leafId;
  const sessionId = binding ?? (isPrimary ? selectedId : null);
  const showClose = countPanes(snapshot.root) > 1 && !isPrimary;
  const preview = api.dropTarget !== null && api.dropTarget.leafId === leafId ? api.dropTarget.side : null;

  // 非主格用**每格独立**的 composer 浮层测量宿主：避免多格共用桌面单例时，某格卸载的
  // `observe(null)` 把其余格的预留高度清掉。主格不传 → 保持桌面单例，行为与未分屏完全一致。
  const overlayHost = useMemo<ComposerOverlayHost>(() => createComposerOverlayHost(), []);
  const header = useMemo(
    () =>
      isPrimary
        ? undefined
        : (info: { readonly sessionId: string; readonly cwd?: string }) => (
            <PaneHeader sessionId={info.sessionId} store={api.store} />
          ),
    [isPrimary, api.store],
  );

  return (
    <div
      data-testid="workbench-pane"
      data-leaf-id={leafId}
      data-primary={isPrimary ? 'true' : 'false'}
      data-focused={isFocused ? 'true' : 'false'}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        api.onFocusLeaf(leafId);
      }}
      onDragOver={(event) => api.onDragOverLeaf(leafId, event)}
      onDragLeave={(event) => api.onDragLeaveLeaf(leafId, event)}
      onDrop={(event) => api.onDropLeaf(leafId, event)}
    >
      {/* Z3-04：左右簇控件 props（壳装配经 host 下发；未装配时缺省不渲染） */}
      <api.seat
        store={api.store}
        controller={api.controller}
        sessionId={sessionId}
        {...(header !== undefined ? { header } : {})}
        {...(isPrimary ? {} : { composerOverlayHost: overlayHost })}
        {...(api.composerControls?.modeSwitch !== undefined ? { modeSwitch: api.composerControls.modeSwitch } : {})}
        {...(api.composerControls?.modelSelect !== undefined ? { modelSelect: api.composerControls.modelSelect } : {})}
      />
      {isFocused && <div aria-hidden className="pointer-events-none absolute inset-0 z-10 border border-primary/40" />}
      {showClose && (
        <button
          type="button"
          data-testid="pane-close"
          aria-label="关闭该分屏格"
          title="关闭该格（会话仍在后台运行）"
          className="absolute right-2 top-1.5 z-20 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            api.onCloseLeaf(leafId);
          }}
        >
          ✕
        </button>
      )}
      {preview !== null && (
        <div
          aria-hidden
          data-testid="pane-drop-preview"
          data-side={preview}
          className="pointer-events-none absolute z-10 border border-primary/30 bg-accent"
          style={previewStyle(preview)}
        />
      )}
    </div>
  );
}
