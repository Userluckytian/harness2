// 主进程桥：IPC 命令分发（渲染端唯一入口）+ 服务 WS 连接（事件帧转发给渲染端）。
// 安全边界：渲染进程零 Node——一切经 ipcRenderer.invoke('harness2:invoke') 到这里，
// 这里只与 127.0.0.1 的本地 serve 通信；WS 帧（含密钥三不约束的脱敏事件）原样转发。
import { BrowserWindow, Notification, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { composeNotifyContent } from '../shared/notify.js';
import { buildCapabilityReport, classifyProbeResponse } from '../shared/capabilities.js';
import type {
  CapabilityIdShape,
  CapabilityReportShape,
  ConnectionStatus,
  MessageReferenceShape,
  SessionSummaryShape,
  StatusDetail,
  SubmitIntentShape,
  WsClientOp,
  WsFrame,
} from '../shared/protocol.js';
import { readLayout, writeLayout } from './layout-file.js';
import type { ServeManager } from './serve-manager.js';
import { readPreferences, writePreferences } from './preferences-file.js';
import { readMetadata, writeMetadataPatch } from './metadata-file.js';
import { readDrafts, writeDrafts } from './drafts-file.js';
import { readAuthMasked, readSettingsConfig, updateAuth, updateSettingsConfig } from './config-file.js';
import { getCrashReports, getDoctorReport } from './diagnostics.js';
import { listWorkspaceDir } from './workspace-fs.js';
import { getContextUsageForSession } from './context-usage.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFile = promisify(execFileCb);

/** 会话目录布局：<home>/.harness2/sessions/<encoded-cwd>/<sessionId>/（与 core session/manager 一致） */
const SESSIONS_DIR_NAME = 'sessions';

/** 递归列出 sessions 根下的 cwd 目录（一层；结构固定 <encoded-cwd>/<sessionId>） */
function sessionCwdDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

/** 定位给定 sessionId 对应的会话目录（在 sessions 树里按目录名匹配；找不到返回 null） */
function sessionDirFor(sessionId: string, home?: string): string | null {
  const sessionsRoot = join(home ?? homedir(), '.harness2', SESSIONS_DIR_NAME);
  if (!existsSync(sessionsRoot)) return null;
  for (const cwdDir of sessionCwdDirs(sessionsRoot)) {
    const maybe = join(cwdDir, sessionId);
    if (existsSync(maybe) && statSync(maybe).isDirectory()) return maybe;
  }
  return null;
}

/** 读 rewind_points.jsonl，返回 seq 匹配的条目（解析失败/撕裂行跳过，与 core SnapshotStore 同策略） */
function readSnapshotEntry(
  sessionId: string,
  seq: number,
  home?: string,
): { file: string; before: string | null; after: string | null } | null {
  const dir = sessionDirFor(sessionId, home);
  if (dir === null) return null;
  const filePath = join(dir, 'rewind_points.jsonl');
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null; // 不存在 / 读失败
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 撕裂/损坏行：跳过
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const e = obj as Record<string, unknown>;
    if (e['v'] === 1 && e['seq'] === seq && typeof e['file'] === 'string') {
      const before = e['before'] === null ? null : typeof e['before'] === 'string' ? e['before'] : null;
      const after = e['after'] === null ? null : typeof e['after'] === 'string' ? e['after'] : null;
      return { file: e['file'], before, after };
    }
  }
  return null;
}

/** 读 git 分支（主进程执行；非 git 目录/无 .git → null） */
async function gitBranchForDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      timeout: 5000,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/** @file 引用读取（B8；主进程 fs，64KB 截断；不存在/读失败 → error，不抛给渲染层） */
function readFileForRefMain(
  path: string,
  cwd: string,
): { ok: boolean; content?: string; truncated?: boolean; error?: string } {
  const CRASH_CAP = 64 * 1024;
  if (path.length === 0) return { ok: false, error: '路径为空' };
  try {
    const target = resolve(cwd, path);
    // 防目录穿越出 cwd（@file 协议按 cwd 内解析，绝对路径也在 cwd 半径内才算合法）
    if (!isInside(target, cwd)) {
      return { ok: false, error: '路径超出当前工作目录' };
    }
    const text = readFileSync(target, 'utf8');
    if (text.length <= CRASH_CAP) return { ok: true, content: text };
    return { ok: true, content: text.slice(0, CRASH_CAP), truncated: true };
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? '未找到' : (e as Error).message };
  }
}

/** 目标是否在 cwd 半径内（相对路径不逃逸 + 等值） */
function isInside(target: string, cwd: string): boolean {
  const rel = relative(cwd, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolutePath(rel));
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

export interface BridgeDeps {
  serve: ServeManager;
  /** serve 的 --root（工具执行 cwd + 新会话分组；渲染端不感知文件系统） */
  root: string;
  /** 用户数据根（分屏布局持久化 ~/.harness2/desktop-layout.json） */
  home: string;
  /** 渲染窗口 webContents 推送（帧） */
  sendEvent: (frame: WsFrame) => void;
  /** 渲染窗口推送（连接状态） */
  sendStatus: (status: ConnectionStatus, detail?: StatusDetail) => void;
  /** D4：运行态上报（main 据此在关窗口前提示；关 UI ≠ 已停任务） */
  setBusy?: (info: { busy: boolean; runningTurns: number; backgroundTasks: number }) => void;
}

export interface Bridge {
  /** 连接（或重连）服务 WS；serve 每次变 ready 后调用 */
  connectWs(): void;
  /** 断开 WS（不触发出错帧） */
  disconnectWs(): void;
  /** IPC invoke 入口（registerBridgeIpc 挂到 ipcMain） */
  handleInvoke(_event: IpcMainInvokeEvent, req: unknown): Promise<unknown>;
}

export class InvokeError extends Error {
  /** HTTP 状态码（网络层失败/非 HTTP 错误时为 undefined） */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'InvokeError';
    this.status = status;
  }
}

async function httpJsonRaw<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new InvokeError(`服务请求失败: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new InvokeError(`服务响应不是 JSON（status ${res.status}）`, res.status);
    }
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `服务错误（status ${res.status}）`;
    throw new InvokeError(msg, res.status);
  }
  return body as T;
}

/** 取非空 sessionId（缺失 → 明确 InvokeError，不静默打空路径） */
function requireSessionId(args: Record<string, unknown>): string {
  const sid = args['sessionId'];
  if (typeof sid !== 'string' || sid.length === 0) throw new InvokeError('缺少 sessionId');
  return sid;
}

export function createBridge(deps: BridgeDeps): Bridge {
  /**
   * P2：所有 serve HTTP 请求携带一次性 token（serve 默认严格鉴权）。
   * token 只在主进程流转，渲染进程不感知；未就绪（null）时不加头，保持旧行为。
   */
  const httpJson = <T>(url: string, init?: RequestInit): Promise<T> => {
    const token = deps.serve.authToken;
    if (!token) return httpJsonRaw<T>(url, init);
    const headers = new Headers(init?.headers);
    headers.set('x-harness2-token', token);
    return httpJsonRaw<T>(url, { ...init, headers });
  };

  /** 404 = 「无此数据/无此端点」→ null（供 planState 等可选端点；其余错误照常抛出） */
  const httpJsonOptional = async <T>(url: string): Promise<T | null> => {
    try {
      return await httpJson<T>(url);
    } catch (e) {
      if (e instanceof InvokeError && e.status === 404) return null;
      throw e;
    }
  };

  /**
   * 能力盘点（D0）：以**实测**为准——
   *   - serve 就绪 = 当前连接状态 connected；
   *   - S7 四个只读端点在给定会话上逐个 GET：404 且 error 以 `not found:` 开头 → 路由缺失（旧 serve）；
   *     「会话暂无计划数据」等业务 404 → 路由存在（数据缺失，非能力缺失）。
   * WS 交互 op（queue/steer/cancel/fork/resume）无法无副作用探测：冻结契约保证其存在，
   * 就绪即视为可用；若旧 serve 缺失，调用时会收到明确 error 帧（不静默）。
   */
  const probeCapabilities = async (sessionId?: string): Promise<CapabilityReportShape> => {
    const serveReady = deps.serve.status === 'connected';
    const unsupported = new Set<CapabilityIdShape>();
    if (serveReady && typeof sessionId === 'string' && sessionId.length > 0) {
      const base = deps.serve.baseUrl;
      const id = encodeURIComponent(sessionId);
      const endpoints: Array<{ cap: CapabilityIdShape; path: string }> = [
        { cap: 'run-config', path: `/api/sessions/${id}/run-config` },
        { cap: 'plan-state', path: `/api/sessions/${id}/plan-state` },
        { cap: 'execution-view', path: `/api/sessions/${id}/execution-view` },
        { cap: 'change-review', path: `/api/sessions/${id}/change-review` },
      ];
      for (const ep of endpoints) {
        try {
          await httpJson<unknown>(`${base}${ep.path}`);
        } catch (e) {
          if (e instanceof InvokeError && classifyProbeResponse(ep.cap, e.status ?? 0, e.message)) {
            unsupported.add(ep.cap);
          }
        }
      }
    }
    return buildCapabilityReport({ serveReady, unsupportedEndpoints: unsupported });
  };

  let ws: WebSocket | null = null;
  let wsIntentionalClose = false;
  let wsReconnectTimer: NodeJS.Timeout | null = null;

  const sendFrame = (frame: WsFrame): void => {
    try {
      deps.sendEvent(frame);
    } catch {
      // 窗口已销毁：忽略
    }
  };

  /**
   * 系统通知触发（B7）：渲染端判定「窗口非聚焦 + 会话不可见」后经 IPC 调到这里。
   * - Notification 支持时原生弹通知；点击 → 聚焦窗口 + 回传 notify/click 帧（渲染端跳会话）
   * - 不支持的原生平台（部分 Linux/打包环境）回退 Electron 对话框（同为"待点击"交互，仍能聚焦跳转）
   * 渲染端不等待结果（fire-and-forget）；本函数永不抛错。
   */
  const triggerNotification = ({
    title,
    body,
    sessionId,
  }: {
    title: string;
    body: string;
    sessionId?: string;
  }): void => {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win !== undefined) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (sessionId !== undefined && sessionId.length > 0) {
        sendFrame({ type: 'notify/click', sessionId });
      }
    });
    try {
      if (Notification.isSupported()) n.show();
      else {
        void dialog.showMessageBox({
          type: 'info',
          title,
          message: title,
          detail: body,
          buttons: [sessionId !== undefined && sessionId.length > 0 ? '查看会话' : '好'],
        });
      }
    } catch {
      // 通知失败（无桌面通知能力/被系统禁用）：静默，不打断会话
    }
  };

  const connectWs = (): void => {
    wsIntentionalClose = false;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      ws = null;
    }
    try {
      // P2：严格鉴权下 WS 升级同样需 token。主进程用全局 WebSocket（不支持自定义 header），
      // 故走 ?token= 查询参数（serve 端 extractServeToken 兼容三种形态，优先级最低）。
      const token = deps.serve.authToken;
      const wsUrl = token ? `${deps.serve.wsUrl}?token=${encodeURIComponent(token)}` : deps.serve.wsUrl;
      const socket = new WebSocket(wsUrl);
      socket.addEventListener('open', () => {
        ws = socket;
        // PD2：WS 建立/恢复必须让渲染端知道 —— 重连后渲染端据此重发订阅并拉权威快照
        // （controller.resyncSubscriptions 挂在 onConnectionStatus('connected') 上）。
        deps.sendStatus('connected');
      });
      socket.addEventListener('message', (ev) => {
        try {
          sendFrame(JSON.parse(String(ev.data)) as WsFrame);
        } catch {
          // 非 JSON 帧：忽略
        }
      });
      socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
        if (wsIntentionalClose) return;
        // 服务重启中：1s 后重试（重连成功前渲染端保持 reconnecting 角标）
        if (wsReconnectTimer === null && deps.serve.status !== 'offline') {
          // PD2：非计划断开要如实告知渲染端（事件流已断，不能继续挂「已连接」假象），
          // 也不得把运行中 turn 标成已停 —— reconnecting 角标 + 重连后恢复由渲染端处理。
          deps.sendStatus('reconnecting', { error: '事件通道断开，正在重连' });
          wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            if (!wsIntentionalClose) connectWs();
          }, 1000);
        }
      });
      socket.addEventListener('error', () => {
        // close 事件统一收尾
      });
    } catch (e) {
      sendFrame({ type: 'error', error: `WS 连接失败: ${(e as Error).message}` });
    }
  };

  const disconnectWs = (): void => {
    wsIntentionalClose = true;
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      ws = null;
    }
  };

  const wsSendOrThrow = (op: WsClientOp): void => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new InvokeError('与服务的事件通道未连接（等待 serve 就绪）');
    }
    ws.send(JSON.stringify(op));
  };

  const handleInvoke = async (_event: IpcMainInvokeEvent, req: unknown): Promise<unknown> => {
    if (typeof req !== 'object' || req === null || typeof (req as { cmd?: unknown }).cmd !== 'string') {
      throw new InvokeError('invoke 请求必须是 {cmd, ...}');
    }
    const cmd = (req as { cmd: string }).cmd;
    const args = req as Record<string, unknown>;
    const base = deps.serve.baseUrl;
    switch (cmd) {
      case 'listSessions': {
        const cwd = args['cwd'];
        // serve 返回 { sessions: [...] }，但 Harness2Api.listSessions 契约是数组 → 这里取 .sessions
        // （2026-09-07 修：此前返回整个对象，渲染端 [...sessions] 展开对象抛错，会话列表永不更新）
        const body = await httpJson<{ sessions: SessionSummaryShape[] }>(
          `${base}/api/sessions${typeof cwd === 'string' && cwd.length > 0 ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
        );
        return body.sessions;
      }
      case 'createSession':
        return httpJson(`${base}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            cwd: typeof args['cwd'] === 'string' && args['cwd'].length > 0 ? args['cwd'] : deps.root,
          }),
        });
      case 'events':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/events`);
      case 'undo':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/undo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(typeof args['n'] === 'number' ? { n: args['n'] } : {}),
            ...(typeof args['dryRun'] === 'boolean' ? { dryRun: args['dryRun'] } : {}),
          }),
        });
      case 'redo':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/redo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      case 'subscribe':
        wsSendOrThrow({ op: 'subscribe', sessionId: requireSessionId(args) });
        return null;
      case 'unsubscribe':
        wsSendOrThrow({ op: 'unsubscribe', sessionId: requireSessionId(args) });
        return null;
      case 'sendMessage':
        wsSendOrThrow({
          op: 'user-message',
          sessionId: requireSessionId(args),
          text: typeof args['text'] === 'string' ? args['text'] : '',
        });
        return null;
      case 'abort':
        wsSendOrThrow({ op: 'abort', sessionId: requireSessionId(args) });
        return null;
      case 'respondApproval':
        wsSendOrThrow({
          op: 'approval-response',
          requestId: typeof args['requestId'] === 'string' ? args['requestId'] : '',
          decision: args['decision'] === 'allow' ? 'allow' : 'deny',
        });
        return null;
      // —— D0：S7 只读查询端点（GET，纯投影） ——
      case 'runConfig': {
        const sid = requireSessionId(args);
        return httpJson(`${base}/api/sessions/${encodeURIComponent(sid)}/run-config`);
      }
      case 'planState': {
        const sid = requireSessionId(args);
        // 404 = 「会话暂无计划数据」（core 明确语义，非错误）→ null，UI 显示空态而非假计划
        return httpJsonOptional(`${base}/api/sessions/${encodeURIComponent(sid)}/plan-state`);
      }
      case 'executionViews': {
        const sid = requireSessionId(args);
        const body = await httpJson<{ views: unknown[] }>(
          `${base}/api/sessions/${encodeURIComponent(sid)}/execution-view`,
        );
        return body.views;
      }
      case 'changeReview': {
        const sid = requireSessionId(args);
        return httpJson(`${base}/api/sessions/${encodeURIComponent(sid)}/change-review`);
      }
      // —— D0：S3 交互 op（WS；结果经 ack 帧回传，不在此处等待） ——
      case 'fork': {
        const sid = requireSessionId(args);
        const atSeq = args['atSeq'];
        wsSendOrThrow({
          op: 'fork',
          sessionId: sid,
          ...(typeof atSeq === 'number' && Number.isInteger(atSeq) && atSeq >= 0 ? { atSeq } : {}),
        });
        return null;
      }
      case 'submit': {
        const sid = requireSessionId(args);
        const clientMessageId = typeof args['clientMessageId'] === 'string' ? args['clientMessageId'] : '';
        if (clientMessageId.length === 0) throw new InvokeError('submit 缺少 clientMessageId（幂等键）');
        const rawText = typeof args['rawText'] === 'string' ? args['rawText'] : '';
        const intent: SubmitIntentShape = args['intent'] === 'steer' ? 'steer' : 'queue';
        const expectedTurnId = args['expectedTurnId'];
        const references = Array.isArray(args['references'])
          ? (args['references'] as MessageReferenceShape[])
          : undefined;
        wsSendOrThrow({
          op: 'submit',
          clientMessageId,
          sessionId: sid,
          rawText,
          intent,
          ...(references !== undefined ? { references } : {}),
          ...(typeof expectedTurnId === 'string' && expectedTurnId.length > 0 ? { expectedTurnId } : {}),
        });
        return null;
      }
      case 'cancel': {
        const requestId = typeof args['requestId'] === 'string' ? args['requestId'] : '';
        const target = args['target'] as { kind?: unknown; id?: unknown } | undefined;
        const kind = target?.kind === 'task' ? 'task' : 'turn';
        const targetId = typeof target?.id === 'string' ? target.id : '';
        if (requestId.length === 0 || targetId.length === 0) {
          throw new InvokeError('cancel 需要 requestId 与非空 target.id');
        }
        const expectedId = args['expectedId'];
        const generation = args['expectedTurnGeneration'];
        wsSendOrThrow({
          op: 'cancel',
          requestId,
          target: { kind, id: targetId },
          ...(typeof expectedId === 'string' && expectedId.length > 0 ? { expectedId } : {}),
          ...(typeof generation === 'number' && Number.isInteger(generation)
            ? { expectedTurnGeneration: generation }
            : {}),
        });
        return null;
      }
      case 'resumeSubscription': {
        const sid = requireSessionId(args);
        const lastSeq = typeof args['lastSeq'] === 'number' ? args['lastSeq'] : 0;
        const epoch = typeof args['epoch'] === 'number' ? args['epoch'] : 0;
        wsSendOrThrow({ op: 'resume-subscription', sessionId: sid, lastSeq, epoch });
        return null;
      }
      case 'capabilities':
        return probeCapabilities(typeof args['sessionId'] === 'string' ? args['sessionId'] : undefined);
      case 'runtime:setBusy':
        deps.setBusy?.({
          busy: args['busy'] === true,
          runningTurns: typeof args['runningTurns'] === 'number' ? args['runningTurns'] : 0,
          backgroundTasks: typeof args['backgroundTasks'] === 'number' ? args['backgroundTasks'] : 0,
        });
        return null;
      case 'loadLayout':
        return readLayout(deps.home);
      case 'saveLayout':
        return writeLayout(deps.home, args['layout']);
      case 'getStatus':
        return deps.serve.getStatus();
      case 'settings:getConfig':
        return readSettingsConfig(deps.home, deps.root);
      case 'settings:updateConfig':
        return updateSettingsConfig(deps.home, deps.root, (args['patch'] as Record<string, unknown>) ?? {});
      case 'settings:getAuthMasked':
        return readAuthMasked(deps.home);
      case 'settings:updateAuth':
        return updateAuth(deps.home, (args['patch'] as Record<string, unknown>) ?? {});
      case 'settings:getPreferences':
        return readPreferences(deps.home);
      case 'settings:setPreferences':
        return writePreferences(deps.home, args['preferences']);
      case 'metadata:get':
        return readMetadata(deps.home);
      case 'metadata:set': {
        const id = typeof args['id'] === 'string' ? args['id'] : '';
        if (id.length === 0) throw new InvokeError('metadata:set 缺少会话 id');
        const rawPatch = args['patch'];
        if (typeof rawPatch !== 'object' || rawPatch === null) throw new InvokeError('metadata:set patch 必须是对象');
        const patch = rawPatch as { title?: string; archived?: boolean; deleted?: boolean; [k: string]: unknown };
        // 只接受白名单字段（title 字符串 / archived|deleted 布尔），其余注入字段一律忽略（校验统一在 normalizeMetadata）
        return writeMetadataPatch(deps.home, id, {
          ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
          ...(typeof patch.archived === 'boolean' ? { archived: patch.archived } : {}),
          ...(typeof patch.deleted === 'boolean' ? { deleted: patch.deleted } : {}),
        });
      }
      case 'drafts:get':
        return readDrafts(deps.home);
      case 'drafts:set':
        return writeDrafts(deps.home, args['drafts']);
      case 'settings:getDoctorReport':
        return getDoctorReport(deps.home, deps.root);
      case 'settings:getCrashReports':
        return getCrashReports(deps.home);
      case 'gitBranch': {
        const dir = typeof args['dir'] === 'string' ? args['dir'] : deps.root;
        return gitBranchForDir(dir);
      }
      case 'getContextUsage': {
        const sid = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
        if (sid.length === 0) return { usage: null, label: '—' };
        return getContextUsageForSession(sid, { home: deps.home });
      }
      case 'getSnapshotForCall': {
        const sid = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
        const seqRaw = args['seq'];
        const seq = typeof seqRaw === 'number' && Number.isInteger(seqRaw) ? seqRaw : NaN;
        if (sid.length === 0 || !Number.isInteger(seq)) {
          return { ok: false, error: '参数非法' };
        }
        // 只读：定位会话目录读 rewind_points.jsonl 的 seq 条目（渲染端零 Node；不写任何文件）
        const entry = readSnapshotEntry(sid, seq, deps.home);
        if (entry === null) return { ok: false, error: '未找到对应快照' };
        return { ok: true, entry };
      }
      case 'listDir': {
        // PD7：工作区只读列目录 —— 根恒为主进程持有的 serve --root，渲染端只传相对路径；
        // realpath 边界校验（符号链接/junction 越界拒绝）在 workspace-fs 内实现。
        const rel = typeof args['relativePath'] === 'string' ? args['relativePath'] : '';
        return listWorkspaceDir(deps.root, rel);
      }
      case 'readFileForRef':
        return readFileForRefMain(
          typeof args['path'] === 'string' ? args['path'] : '',
          typeof args['cwd'] === 'string' ? args['cwd'] : deps.root,
        );
      case 'notify': {
        // 渲染端已做触发判定（notify/click 回传）；主进程只负责弹通知 + 点击回传。
        // 兜底规范化：title/body 由渲染端 composeNotifyContent 生成；此处再走一遍保证
        // 即便渲染端传空/异常，通知内容也符合「标题或 harness2 + 80 字摘要」契约。
        const composed = composeNotifyContent({
          title: typeof args['title'] === 'string' && args['title'].length > 0 ? args['title'] : null,
          firstUserText: null,
          replyText: typeof args['body'] === 'string' ? args['body'] : '',
        });
        const sessionId =
          typeof args['sessionId'] === 'string' && args['sessionId'].length > 0 ? args['sessionId'] : undefined;
        triggerNotification({ title: composed.title, body: composed.body, sessionId });
        return null;
      }
      default:
        throw new InvokeError(`未知命令 ${cmd}`);
    }
  };

  return { connectWs, disconnectWs, handleInvoke };
}

/** 挂 IPC 通道（主进程启动时调用一次） */
export function registerBridgeIpc(bridge: Bridge): void {
  ipcMain.handle('harness2:invoke', (event, req) => bridge.handleInvoke(event, req));
}
