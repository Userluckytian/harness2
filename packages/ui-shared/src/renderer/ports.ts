// 端口接口面（ports）：共享包与「壳」之间的唯一缝。
//
// 设计原则（本阶段硬要求）：共享包**只**定义端口与呈现，不 import electron / Node 内建 /
// 任何壳的桥；每个壳注入自己的实现——
//   * desktop：`window.harness2`（preload contextBridge + 主进程 serve/HTTP+WS/IPC）；
//   * web    ：`packages/web/src/serve-client.ts`（serve 的 HTTP `/api/*` + WS `/ws`）。
//
// 四个端口：
//   1. `HarnessClient`   —— 会话面（列会话 / 订阅事件 / 提交 / 停止 / 审批应答 / 只读查询）；
//   2. `Persistence`     —— 纯 UI 偏好持久化（视图选择等；缺省 = 内存）；
//   3. `AttachmentReader`—— 附件读取与上传（composer 的图片/文件通道）；
//   4. `HostBridge`      —— 壳侧零星能力（快照 / 文件文本读取），见 ./host-bridge.ts。
//
// 「可选」语义：端口里带 `?` 的成员属于**壳可选择提供**的能力。缺失时共享层必须如实降级
// （显示「此壳未提供该通道」/ 仅内存生效），**绝不**伪造成功、绝不摆假入口。
import type {
  CapabilityReportShape,
  ChangeSetShape,
  ConnectionStatus,
  EffectiveRunConfigShape,
  MessageReferenceShape,
  PlanStateShape,
  SessionEventsPayloadShape,
  SessionSummaryShape,
  StatusDetail,
  SubmitIntentShape,
  ToolExecutionViewShape,
  UndoRedoResponseShape,
  WsFrame,
} from '../shared/protocol.js';
import type { DraftsMap } from '../shared/drafts.js';
import type { SessionMetadataMap } from '../shared/metadata.js';
import type { ImageReadIO, UploadTransport } from './conversation/composer/attachments.js';
import type { ViewSelectionPersistence } from './conversation/views/view-ring.js';

export type { HostBridge } from './host-bridge.js';

/**
 * 壳 → 会话服务端口。必需成员 = 每个壳都能实现（serve 契约面）；可选成员 = 宿主专属能力。
 * desktop 的 `Harness2Api` 结构上满足本接口（多出的成员不影响赋值）。
 */
export interface HarnessClient {
  // —— 会话面（必需） ——

  listSessions(cwd?: string): Promise<SessionSummaryShape[]>;
  createSession(cwd?: string): Promise<{ id: string }>;
  /** 会话全量事件（切换/重放的事实源；随后增量按 seq 去重接入） */
  events(sessionId: string): Promise<SessionEventsPayloadShape>;
  /** 订阅会话事件流（WS `op:'subscribe'`） */
  subscribe(sessionId: string): Promise<void>;
  /** 发送用户消息（旧通道；新路径走 submit） */
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** 中止当前 turn（旧通道；三态结论见 cancel） */
  abort(sessionId: string): Promise<void>;
  /** 审批应答（WS `op:'approval-response'`） */
  respondApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  /** 主动查一次连接状态（只订阅可能错过启动前的 connected） */
  getStatus(): Promise<{ status: ConnectionStatus; detail?: StatusDetail }>;
  /** 订阅服务事件帧；返回退订函数 */
  onEvent(listener: (frame: WsFrame) => void): () => void;
  /** 订阅连接状态变化；返回退订函数 */
  onConnectionStatus(listener: (status: ConnectionStatus, detail?: StatusDetail) => void): () => void;

  // —— S3 交互 op（必需；全走 serve 契约） ——

  /** 提交（幂等 clientMessageId；结论经 submit-ack 帧回传，unknown ≠ rejected） */
  submit(op: {
    clientMessageId: string;
    sessionId: string;
    rawText: string;
    intent: SubmitIntentShape;
    references?: MessageReferenceShape[];
    expectedTurnId?: string;
  }): Promise<void>;
  /** 取消 turn/task（三态经 cancel-ack 帧回传；不把取消当 undo） */
  cancel(op: {
    requestId: string;
    target: { kind: 'turn' | 'task'; id: string };
    expectedId?: string;
    expectedTurnGeneration?: number;
  }): Promise<void>;
  /** 重订阅：带水位回放 + 在途状态（结论经 resume-snapshot 帧回传） */
  resumeSubscription(sessionId: string, lastSeq: number, epoch: number): Promise<void>;
  /** 从既有会话分叉（不改原会话） */
  fork(sessionId: string, atSeq?: number): Promise<void>;
  undo(sessionId: string, opts?: { n?: number; dryRun?: boolean }): Promise<UndoRedoResponseShape>;
  redo(sessionId: string): Promise<UndoRedoResponseShape>;

  // —— S7 只读查询（必需；serve 端点，两壳都能实现） ——

  runConfig(sessionId: string): Promise<EffectiveRunConfigShape>;
  planState(sessionId: string): Promise<PlanStateShape | null>;
  executionViews(sessionId: string): Promise<ToolExecutionViewShape[]>;
  changeReview(sessionId: string): Promise<ChangeSetShape>;

  // —— 可选宿主能力（缺失 = 如实降级） ——

  unsubscribe?(sessionId: string): Promise<void>;
  /** 能力盘点（后端真实具备什么；缺失时控制层保持上次结果，不伪造「全部可用」） */
  capabilities?(sessionId?: string): Promise<CapabilityReportShape>;
  /** 上报「是否有运行中工作」（桌面用它决定关窗口是否提示；web 无此概念） */
  setBusy?(busy: boolean, counts?: { runningTurns: number; backgroundTasks: number }): Promise<void>;
  /** 读旧版分屏布局文件（只读兼容；web 无此历史文件） */
  loadLayout?(): Promise<unknown>;
  /** 会话展示态覆层（重命名/归档/删除标记） */
  metadataGet?(): Promise<SessionMetadataMap>;
  metadataSet?(
    id: string,
    patch: { title?: string; archived?: boolean; deleted?: boolean },
  ): Promise<SessionMetadataMap>;
  /** 会话草稿（按会话隔离的原始输入） */
  draftsGet?(): Promise<DraftsMap>;
  draftsSet?(drafts: DraftsMap): Promise<DraftsMap>;
  /** 写全局配置（桌面走 config.json 白名单深合并；web 未提供时如实拒绝） */
  settingsUpdateConfig?(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 纯 UI 偏好持久化端口（D-14 口径：**不落浏览器存储**是壳的自由，但必须经此缝注入）。
 * 默认实现 = `createInMemoryPersistence()`（只在本进程存活期内记住）。
 */
export type Persistence = ViewSelectionPersistence;

/** 内存实现：只在本进程存活期内记住每个会话的选择；`subscribe` 让环外改写也能即时切换视图 */
export function createInMemoryPersistence(): Persistence {
  const bySession = new Map<string, string>();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    read: (sessionId) => bySession.get(sessionId) ?? null,
    write: (sessionId, key) => {
      const before = bySession.get(sessionId) ?? null;
      if (key === null) bySession.delete(sessionId);
      else bySession.set(sessionId, key);
      if ((bySession.get(sessionId) ?? null) !== before) emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 附件读取/上传端口（composer 注入缝合集）：图片读取器 + 文件上传 transport。
 * 两者都可缺省——缺省时 composer 的对应能力如实不可用（失败项留在附件列表，不伪造凭证）。
 */
export interface AttachmentReader {
  readonly imageIO?: ImageReadIO;
  readonly transport?: UploadTransport;
}
