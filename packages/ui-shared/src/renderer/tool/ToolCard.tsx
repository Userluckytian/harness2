// 工具卡（D-6x `ui-tool` 对应物）：会话调用树内的**单一视图**卡片。
//
// D-86（工具卡单视图）落地方式：
//   - 卡片就在调用树内（本组件即卡片本体，无「点击展开第二个全高详情视图」的路径）；
//   - 参数里的文件路径 → 按钮走 owner `openFile`（右栏文本预览，见 tool-navigation）；
//   - `inspect`（查看轨迹）只在轨迹视图**已装配**时渲染（未装配 → 不摆假按钮）；
//   - 终端类工具（bash / pwsh / powershell / cmd / sh）无论是否运行中都用 terminal 卡片呈现命令日志。
//
// Z-93 对齐（Z3-06，在既有能力之上做视觉与交互对齐，不删任何既有入口）：
//   - 头部：图标 + 工具名 + 参数摘要 + 状态节点 + **悬停才显现的展开箭头**（展开时 rotate-90）；
//     可展开时整行 `role=button`，键盘 Enter/Space 展开收起（行内按钮不抢事件）；
//   - 三态语义色（Z-93）：运行 `text-interaction-ask-foreground` / 完成 `text-success` /
//     失败 `text-destructive`（嵌在 `.tool-status` 内层，不与 shell.css 旧状态色打架）；
//   - 失败态：失败文字带**虚线下划线**，hover/focus 出 tooltip，内含复制按钮
//     （复制后短暂变对勾；文案「复制错误 / 已复制」）；
//   - 结果区：折叠/展开 300ms 高度+淡入动画；**展开态记忆**——同一工具再次出现保持上次
//     开合（模块级内存 Map，按工具名记忆；不落盘、不持久化，符合 D-14 渲染端禁写存储）。
//
// 组装：子卡片复用既有实现（DiffCard 的 red/green diff、CommandLog 的命令日志、子会话跳转），
// 本模块只负责「一个工具调用 = 一张卡」的结构与动作，不重复实现 diff / 日志渲染。
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FilePenIcon,
  FileTextIcon,
  LoaderIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import type { Controller } from '../app-controller.js';
import { displayToolName } from '../chat-model.js';
import { DiffCard } from '../components/DiffCard.js';
import { CommandLog } from '../features/timeline/CommandLog.js';
import type { TimelineToolRow } from '../features/timeline/execution-log.js';
import {
  isDiffTool,
  isTerminalTool,
  shouldRenderCommandLog,
  summarizeToolArgs,
  toolDiffTargetFile,
  toolFileTarget,
  toolStatusLabel,
  toolStatusOf,
  type ToolCardModel,
  type ToolStatus,
} from './tool-model.js';
import type { ToolFileOpenRequest, ToolInspectRequest } from './tool-navigation.js';

/** 工具卡的动作面（全部可选；没给的动作不渲染入口 —— 不造假按钮） */
export interface ToolCardActions {
  /** D-86 ①：打开文件（宿主路由到右栏文本预览） */
  readonly onOpenFile?: (request: ToolFileOpenRequest) => void;
  /** D-86 ②：查看轨迹（宿主路由到轨迹视图；未装配时宿主不传） */
  readonly onInspect?: (request: ToolInspectRequest) => void;
  /** 子会话跳转（自带会话选中 + 重放） */
  readonly onOpenChildSession?: (childSessionId: string) => void;
  /** write/edit 的「撤销此次修改」（既有 undo 能力） */
  readonly onUndo?: () => void;
}

export interface ToolCardProps {
  readonly card: ToolCardModel;
  /** 会话 id（diff 卡读快照、轨迹跳转定位视图环都需要） */
  readonly sessionId?: string;
  /** D2 执行视图行（真实 shell/cwd/exitCode/输出归属）；缺省时按结果字段如实降级 */
  readonly commandRow?: TimelineToolRow;
  readonly actions?: ToolCardActions;
}

/** Z-93 展开态记忆（按工具名；**进程内存**，不持久化 —— D-14 渲染端不落盘） */
const toolOpenMemory = new Map<string, boolean>();

/** 仅测试用：清空展开态记忆（模块级 Map 跨用例共享，测试需要确定性初态） */
export function resetToolOpenMemoryForTests(): void {
  toolOpenMemory.clear();
}

/** 结果区收起后的延迟卸载间隔：略高于 300ms 动画，收起动画完整播完再卸载 */
const RESULT_UNMOUNT_DELAY_MS = 320;
/** 复制成功反馈时长（短暂变对勾） */
const COPY_FEEDBACK_MS = 1500;

/** Z-93 三态语义色（结果状态 → 文本色；只引用语义 token） */
const STATUS_TEXT_COLOR: Record<ToolStatus, string> = {
  running: 'text-interaction-ask-foreground',
  ok: 'text-success',
  failed: 'text-destructive',
};

/** 工具图标（lucide；按工具名分类取形，未知工具用扳手兜底） */
function ToolGlyph({ tool }: { tool: string | undefined }): ReactNode {
  const name = (tool ?? '').toLowerCase();
  const Icon = name.startsWith('subagent_')
    ? BotIcon
    : isTerminalTool(name)
      ? SquareTerminalIcon
      : isDiffTool(name)
        ? FilePenIcon
        : name === 'read'
          ? FileTextIcon
          : name === 'grep' || name === 'glob' || name.includes('search')
            ? SearchIcon
            : WrenchIcon;
  return <Icon size={13} aria-hidden className="shrink-0 text-foreground-subtle" />;
}

/** 复制反馈 hook：写入剪贴板成功 → 短暂 copied=true；失败/无通道保持原样（不假报已复制） */
function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = (text: string): void => {
    void (async () => {
      let ok = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else if (typeof document !== 'undefined') {
          // 老环境兜底：隐藏 textarea + execCommand（同样真实复制，失败不假报）
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        }
      } catch {
        ok = false;
      }
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, COPY_FEEDBACK_MS);
    })();
  };
  return { copied, copy };
}

/** 失败态（Z-93）：失败文字虚线下划线 + hover/focus tooltip（错误全文 + 复制按钮） */
function ToolErrorStatus({
  result,
  copied,
  onCopy,
}: {
  result: { ok: boolean; error?: string };
  copied: boolean;
  onCopy: (text: string) => void;
}): ReactNode {
  const error = result.error ?? '';
  return (
    <span className="tool-status">
      <span className="group/err relative inline-flex cursor-help items-center" data-testid="tool-error">
        <span
          tabIndex={0}
          title={error.length > 0 ? error : undefined}
          className="border-b border-dashed border-destructive text-destructive outline-none"
        >
          {toolStatusLabel(result)}
        </span>
        {/* tooltip 常驻 DOM（hover/focus 显隐），复制按钮真实可用；pt-1 桥接 hover 间隙 */}
        <span
          role="tooltip"
          data-testid="tool-error-tooltip"
          className="absolute right-0 top-full z-10 hidden pt-1 group-focus-within/err:block group-hover/err:block"
        >
          <span className="flex w-max max-w-80 items-start gap-2 rounded-md border border-popover-border bg-popover p-2 shadow-md">
            <span className="whitespace-pre-wrap break-all text-left text-ui-2xs text-foreground">
              {error.length > 0 ? error : '结果未标记 ok（未给出错误原因）'}
            </span>
            <button
              type="button"
              data-tool-inline-control="copy-error"
              data-testid="tool-copy-error"
              className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-ui-2xs text-foreground-subtle hover:bg-hover hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(error);
              }}
            >
              {copied ? <CheckIcon size={10} aria-hidden /> : <CopyIcon size={10} aria-hidden />}
              {copied ? '已复制' : '复制错误'}
            </button>
          </span>
        </span>
      </span>
    </span>
  );
}

/** 子会话跳转按钮（阶段 8 / P4-C：打开子会话＝选中 + 重放） */
function SubagentJump({
  childSessionId,
  onOpen,
}: {
  childSessionId: string;
  onOpen: (childSessionId: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="subagent-jump"
      data-tool-action="open-child-session"
      data-tool-inline-control="open-child-session"
      title={`打开子会话 ${childSessionId} 轨迹`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(childSessionId);
      }}
    >
      子会话 {childSessionId} ↗
    </button>
  );
}

/** 工具卡（单一视图：卡片内联在调用树里；Z-93 对齐头部/状态/失败/结果区交互） */
export function ToolCard({ card, sessionId, commandRow, actions }: ToolCardProps): ReactNode {
  const status = toolStatusOf(card.result);
  const tool = card.tool ?? '';
  const memoryKey = tool.length > 0 ? tool : '(未具名)';
  const [open, setOpen] = useState(() => toolOpenMemory.get(memoryKey) ?? false);
  const [resultMounted, setResultMounted] = useState(open);
  const { copied, copy } = useCopyFeedback();
  const unmountTimerRef = useRef<number | null>(null);

  const file = toolFileTarget(card.args);
  const canOpenFile = file !== undefined && actions?.onOpenFile !== undefined;
  const canInspect = card.callId !== undefined && sessionId !== undefined && actions?.onInspect !== undefined;
  const diffFile = toolDiffTargetFile(card.args);
  const showDiff =
    isDiffTool(card.tool) && card.result?.ok === true && sessionId !== undefined && actions?.onUndo !== undefined;
  const hasCommandLog = commandRow !== undefined && shouldRenderCommandLog(commandRow);
  const showCommandLog = hasCommandLog && commandRow !== undefined;
  // Z-93：可展开 = 有结果区（diff / 命令日志）；没有就不摆假箭头
  const expandable = showDiff || hasCommandLog;

  const toggle = (): void => {
    setOpen((prev) => {
      const next = !prev;
      toolOpenMemory.set(memoryKey, next); // 展开态记忆：同工具下次出现沿用
      return next;
    });
  };

  // 结果区：展开即挂载；收起先播 300ms 收拢动画、结束后卸载（隐藏时不白拉 diff 快照等数据）
  useEffect(() => {
    if (open) {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      setResultMounted(true);
      return undefined;
    }
    unmountTimerRef.current = window.setTimeout(() => {
      unmountTimerRef.current = null;
      setResultMounted(false);
    }, RESULT_UNMOUNT_DELAY_MS);
    return () => {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [open]);

  // 行内控件（打开文件 / 查看轨迹 / 复制错误 / 子会话跳转）不触发整行开合
  const fromInlineControl = (e: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>): boolean =>
    (e.target as HTMLElement).closest('[data-tool-inline-control]') !== null;

  const onRowClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!expandable || fromInlineControl(e)) return;
    toggle();
  };

  // Z-93：整行 role=button，Enter / Space 展开
  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || fromInlineControl(e)) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  };

  return (
    <div
      className={`tool-entry tool-${status}`}
      data-tool-card={tool}
      data-tool-status={status}
      data-tool-open={open ? 'true' : 'false'}
    >
      <div
        className={`tool-row tool-${status} group/tool flex items-center gap-2`}
        data-testid="tool-summary-row"
        {...(expandable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: onRowClick,
              onKeyDown: onRowKeyDown,
            }
          : {})}
      >
        <ToolGlyph tool={card.tool} />
        <span className="tool-line min-w-0 flex-1 truncate">
          &gt; {displayToolName(card.tool)} ({summarizeToolArgs(card.args)})
        </span>
        {status !== 'failed' ? (
          <span className="tool-status">
            <span className={`flex items-center gap-1 ${STATUS_TEXT_COLOR[status]}`}>
              {status === 'running' && <LoaderIcon size={11} aria-hidden className="animate-spin" />}
              {toolStatusLabel(card.result)}
            </span>
          </span>
        ) : (
          // 失败态：状态节点本体即失败文字（虚线下划线 + tooltip + 复制），不再重复渲染一份
          <ToolErrorStatus result={card.result ?? { ok: false }} copied={copied} onCopy={copy} />
        )}
        {canOpenFile && (
          <button
            type="button"
            className="tool-open-file"
            data-tool-action="open-file"
            data-tool-inline-control="open-file"
            title={file}
            onClick={(e) => {
              e.stopPropagation();
              actions?.onOpenFile?.({
                path: file,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(card.callId !== undefined ? { callId: card.callId } : {}),
              });
            }}
          >
            打开文件
          </button>
        )}
        {canInspect && (
          <button
            type="button"
            className="tool-inspect"
            data-tool-action="inspect"
            data-tool-inline-control="inspect"
            onClick={(e) => {
              e.stopPropagation();
              actions?.onInspect?.({
                sessionId,
                ...(card.callId !== undefined ? { callId: card.callId } : {}),
                ...(card.seq !== undefined ? { seq: card.seq } : {}),
              });
            }}
          >
            查看轨迹
          </button>
        )}
        {card.childSessionId !== undefined && actions?.onOpenChildSession !== undefined && (
          <SubagentJump childSessionId={card.childSessionId} onOpen={actions.onOpenChildSession} />
        )}
        {expandable && (
          <ChevronRightIcon
            size={13}
            aria-hidden
            data-testid="tool-chevron"
            className={`shrink-0 text-foreground-subtle transition-all duration-200 ${
              open
                ? 'rotate-90 opacity-100'
                : 'opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100'
            }`}
          />
        )}
      </div>
      {resultMounted && expandable && (
        <div
          data-testid="tool-result"
          aria-hidden={!open}
          className={`grid transition-all duration-300 ease-out ${
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            {showDiff && sessionId !== undefined && (
              <DiffCard
                sessionId={sessionId}
                {...(card.seq !== undefined ? { seq: card.seq } : {})}
                {...(diffFile !== undefined ? { file: diffFile } : {})}
                onUndo={() => actions?.onUndo?.()}
              />
            )}
            {showCommandLog && commandRow !== undefined && (
              <CommandLog row={commandRow} displayName={displayToolName(card.tool)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 便捷：既有调用点的 controller 折成动作面（子会话跳转 + 撤销） */
export function controllerToolActions(controller: Controller, sessionId: string | undefined): ToolCardActions {
  return {
    ...(sessionId !== undefined ? { onUndo: () => void controller.undoSession(sessionId) } : {}),
    onOpenChildSession: (childSessionId) => void controller.selectSession(childSessionId),
  };
}
