// 工具卡（D-6x `ui-tool` 对应物）：会话调用树内的**单一视图**卡片。
//
// D-86（工具卡单视图）落地方式：
//   - 卡片就在调用树内（本组件即卡片本体，无「点击展开第二个全高详情视图」的路径）；
//   - 参数里的文件路径 → 按钮走 owner `openFile`（右栏文本预览，见 tool-navigation）；
//   - `inspect`（查看轨迹）只在轨迹视图**已装配**时渲染（未装配 → 不摆假按钮）；
//   - 终端类工具（bash / pwsh / powershell / cmd / sh）无论是否运行中都用 terminal 卡片呈现命令日志。
//
// 组装：子卡片复用既有实现（DiffCard 的 red/green diff、CommandLog 的命令日志、子会话跳转），
// 本模块只负责「一个工具调用 = 一张卡」的结构与动作，不重复实现 diff / 日志渲染。
import type { Controller } from '../app-controller.js';
import { displayToolName } from '../chat-model.js';
import { DiffCard } from '../components/DiffCard.js';
import { CommandLog } from '../features/timeline/CommandLog.js';
import type { TimelineToolRow } from '../features/timeline/execution-log.js';
import {
  isDiffTool,
  shouldRenderCommandLog,
  summarizeToolArgs,
  toolDiffTargetFile,
  toolFileTarget,
  toolStatusLabel,
  toolStatusOf,
  type ToolCardModel,
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

/** 子会话跳转按钮（阶段 8 / P4-C：打开子会话＝选中 + 重放） */
function SubagentJump({
  childSessionId,
  onOpen,
}: {
  childSessionId: string;
  onOpen: (childSessionId: string) => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      className="subagent-jump"
      data-tool-action="open-child-session"
      title={`打开子会话 ${childSessionId} 轨迹`}
      onClick={() => onOpen(childSessionId)}
    >
      子会话 {childSessionId} ↗
    </button>
  );
}

/** 工具卡（单一视图：卡片内联在调用树里） */
export function ToolCard({ card, sessionId, commandRow, actions }: ToolCardProps): React.ReactNode {
  const status = toolStatusOf(card.result);
  const tool = card.tool ?? '';
  const file = toolFileTarget(card.args);
  const canOpenFile = file !== undefined && actions?.onOpenFile !== undefined;
  const canInspect = card.callId !== undefined && sessionId !== undefined && actions?.onInspect !== undefined;
  const diffFile = toolDiffTargetFile(card.args);
  const showDiff =
    isDiffTool(card.tool) && card.result?.ok === true && sessionId !== undefined && actions?.onUndo !== undefined;
  const showCommandLog = shouldRenderCommandLog(commandRow) && commandRow !== undefined;

  return (
    <div className={`tool-entry tool-${status}`} data-tool-card={tool} data-tool-status={status}>
      <div className={`tool-row tool-${status}`}>
        <span className="tool-line">
          &gt; {displayToolName(card.tool)} ({summarizeToolArgs(card.args)})
        </span>
        <span className="tool-status">{toolStatusLabel(card.result)}</span>
        {canOpenFile && (
          <button
            type="button"
            className="tool-open-file"
            data-tool-action="open-file"
            title={file}
            onClick={() =>
              actions?.onOpenFile?.({
                path: file,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(card.callId !== undefined ? { callId: card.callId } : {}),
              })
            }
          >
            打开文件
          </button>
        )}
        {canInspect && (
          <button
            type="button"
            className="tool-inspect"
            data-tool-action="inspect"
            onClick={() =>
              actions?.onInspect?.({
                sessionId,
                ...(card.callId !== undefined ? { callId: card.callId } : {}),
                ...(card.seq !== undefined ? { seq: card.seq } : {}),
              })
            }
          >
            查看轨迹
          </button>
        )}
        {card.childSessionId !== undefined && actions?.onOpenChildSession !== undefined && (
          <SubagentJump childSessionId={card.childSessionId} onOpen={actions.onOpenChildSession} />
        )}
      </div>
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
  );
}

/** 便捷：既有调用点的 controller 折成动作面（子会话跳转 + 撤销） */
export function controllerToolActions(controller: Controller, sessionId: string | undefined): ToolCardActions {
  return {
    ...(sessionId !== undefined ? { onUndo: () => void controller.undoSession(sessionId) } : {}),
    onOpenChildSession: (childSessionId) => void controller.selectSession(childSessionId),
  };
}
