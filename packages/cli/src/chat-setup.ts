// 共享会话装配：legacy（readline）与 ink（TUI）两条路径共用同一套 provider / 审批 /
// 记忆 / 压缩 / 插件 / MCP / subagent / 会话解析 / runTurn 语义，避免两套装配各写一份。
// 渲染与输入交错策略由调用方（路径专属）决定：本模块只负责装配与 turn 执行，事件经
// onStream 回调桥接，不直接写 stdout。审批提问经 askApproval 钩子注入（legacy 走 readline
// 拦截；ink 走弹窗）。"总是允许"仅存进程内会话级缓存，绝不落盘。
import {
  createApprovalPolicy,
  createBrowserTools,
  createMemoryTool,
  createProvider,
  createSkillTool,
  createSubagentTools,
  defaultConfigPaths,
  defaultMemoriesRoot,
  defaultPendingRoot,
  defaultPluginsRoot,
  defaultSessionsRoot,
  defaultSkillsRoot,
  getSharedBrowserPool,
  loadConfig,
  McpManager,
  MemoryStore,
  MockProvider,
  noteCrashSessionId,
  PendingMemoryStore,
  PluginBus,
  projectSkillsRoot,
  registerBuiltinTools,
  resolveCompactionOptions,
  runTurn,
  forkSession,
  SessionManager,
  SkillStore,
  SnapshotStore,
  ToolRegistry,
  SUBAGENT_TOOL_NAMES,
  type ApprovalHandler,
  type ApprovalInput,
  type ChatProvider,
  type CompactionOptions,
  type MemorySink,
  type MockScript,
  type TurnResult,
  type AnySessionEvent,
  type SessionAppender,
  type SessionEventMap,
  type SessionEventType,
  type SessionWriter,
} from '@harness2/core';
import type { ChatOptions } from './legacy-chat.js';

/** --provider mock 的内置演示脚本：两轮工具调用（write 文件 + read 验证） */
export const MOCK_DEMO_SCRIPT: MockScript = [
  {
    textChunks: ['好的，', '我来创建演示文件。'],
    toolCalls: [
      {
        id: 'demo-write-1',
        name: 'write',
        arguments: JSON.stringify({
          file_path: 'harness2-demo.txt',
          content: 'harness2 mock 演示文件\n由 write 工具创建，可用 /undo 撤销、/redo 重做。\n',
        }),
      },
    ],
  },
  {
    textChunks: ['已写入 harness2-demo.txt，', '我再读一遍验证。'],
    toolCalls: [{ id: 'demo-read-1', name: 'read', arguments: JSON.stringify({ file_path: 'harness2-demo.txt' }) }],
  },
  {
    textChunks: ['演示完成：', '已写入并读取 harness2-demo.txt。', '试试 /undo --dry-run、/undo、/redo。'],
  },
];

/** mock 模式 subagent 子会话的缺省脚本（subagent_start / subagent_continue 派发的子会话 turn） */
export const MOCK_CHILD_DEMO_SCRIPT: MockScript = [
  { textChunks: ['子会话完成：', '这是子任务的结果。'] },
  { textChunks: ['子会话继续完成：', '这是追加消息后的结果。'] },
];

/** 审批 "总是允许" 缓存：进程内会话级，仅由本 runtime 读写 */
export interface ChatSession {
  id: string;
  dir: string;
  writer: SessionWriter;
}

/** 装配期输出钩子：渲染/打印（legacy=StreamRenderer.line；ink=事件分发） */
export interface ChatSetupHooks {
  line: (t: string) => void;
  /** 审批提问（signal 为 turn 取消信号，abort 时应以便利方式结束等待） */
  askApproval: (query: string, signal?: AbortSignal) => Promise<string>;
}

/** 每轮 turn 的流式渲染回调（legacy=直写 stdout；ink=桥接 React state） */
export type TurnStreamHandler = (event: StreamEvent) => void;

/** 与 legacy onStream 对齐的事件联合 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: { id: string; name: string; arguments: string } }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-result'; callId: string; ok: boolean; error?: string };

export type { TurnResult } from '@harness2/core';

/** 共享会话装配与 turn 执行的结果 */
export interface ChatRuntime {
  provider: ChatProvider;
  approval: ApprovalHandler | undefined;
  tools: ToolRegistry;
  skillsStore: SkillStore;
  sessionManager: SessionManager;
  getCurrent: () => ChatSession | null;
  switchSession: (id: string | null, opts?: { print?: (t: string) => void }) => void;
  fork: (at?: number, opts?: { print?: (t: string) => void }) => void;
  runUserTurn: (text: string, onStream: TurnStreamHandler) => Promise<TurnResult>;
  /** 中止当前 turn（含审批 ask 等待的竞速取消）；无活动 turn 时为 no-op */
  abortTurn: () => void;
  /** 结束当前会话写入器（由路径专属退出钩子调用） */
  closeCurrent: () => void;
  /** 清空 /mode 从 plan 切换时的会话级 alwaysAllowed 缓存（供路径调用） */
  clearAlwaysAllowed: () => void;
  noteCrash: (id?: string) => void;
  finish: (hooks: { closeReadline?: () => void; destroyInput?: () => void }) => Promise<void>;
}

const SESSION_HELP_BANNER = (id: string, kind: 'recovered' | 'new'): string =>
  `会话: ${id}（${kind === 'recovered' ? '已恢复' : '新建'}）`;

export async function setupChatSession(
  options: ChatOptions,
  hooks: ChatSetupHooks,
): Promise<ChatRuntime> {
  const { line } = hooks;
  const root = options.root !== undefined ? options.root : process.cwd();

  // —— provider 与审批缝 ——
  let provider: ChatProvider;
  let approval: ApprovalHandler | undefined;
  let memoryStore: MemoryStore | undefined;
  let compaction: CompactionOptions | undefined;
  let pluginBus: PluginBus | undefined;
  let mcpManager: McpManager | undefined;
  let subagentConfig: { maxDepth: number; maxTurns: number; provider?: ChatProvider } | undefined;
  const extensionDisposers: Array<() => void | Promise<void>> = [];
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  // 会话与会话中止态：装配中途即可能被异步闭包（memory sink / 审批 ask）在运行期读取
  let current: ChatSession | null = null;
  let currentAbort: AbortController | null = null;

  const skillsStore = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(options.home));
  tools.register(createSkillTool(skillsStore));

  const alwaysAllowed = new Set<string>(); // 进程内会话级缓存，不落盘

  if (options.provider === 'mock') {
    provider = new MockProvider(options.mockScript ?? MOCK_DEMO_SCRIPT);
  } else {
    const loaded = loadConfig({ root, ...(options.home !== undefined ? { home: options.home } : {}) });
    if (loaded.config === null) {
      for (const err of loaded.errors) line(`error: ${err}`);
      process.exitCode = 1;
      throw new ChatSetupAbort();
    }
    for (const w of loaded.warnings) line(`warning: ${w}`);
    try {
      const paths = defaultConfigPaths(root, options.home);
      provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
      let smallProvider: ChatProvider | undefined;
      try {
        smallProvider = createProvider(loaded.config, 'small', { authPath: paths.globalAuth });
      } catch {
        smallProvider = undefined;
      }
      compaction = resolveCompactionOptions(loaded.config, (role) =>
        role === 'small' ? smallProvider : provider,
      );
      let subProvider: ChatProvider | undefined;
      try {
        subProvider = createProvider(loaded.config, 'subagent', { authPath: paths.globalAuth });
      } catch {
        subProvider = undefined;
      }
      subagentConfig = {
        maxDepth: loaded.config.subagent.maxDepth,
        maxTurns: loaded.config.subagent.maxTurns,
        ...(subProvider !== undefined ? { provider: subProvider } : {}),
      };
      if (loaded.config.browser.enabled) {
        const pool = getSharedBrowserPool({
          idleDestroyMs: loaded.config.browser.idleDestroyMs,
          maxConcurrent: loaded.config.browser.maxConcurrent,
        });
        for (const def of createBrowserTools('cli', pool)) tools.register(def);
      }
    } catch (e) {
      line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      throw new ChatSetupAbort();
    }
    if (loaded.config.memory.mode !== 'off') {
      memoryStore = new MemoryStore(defaultMemoriesRoot(options.home));
      if (loaded.config.memory.mode === 'ask') {
        const pendingStore = new PendingMemoryStore(defaultPendingRoot(options.home), memoryStore);
        const sink: MemorySink = {
          apply: async (ops) => {
            const stagedItem = await pendingStore.stage(current?.id ?? 'unknown', ops);
            return { ok: true, warnings: [], files: [], stagedId: stagedItem.id };
          },
        };
        tools.register(createMemoryTool(sink));
      } else {
        tools.register(createMemoryTool(memoryStore));
      }
    }
    const policy = createApprovalPolicy(loaded.config.approval);
    if (loaded.config.plugins.enabled) {
      pluginBus = new PluginBus({ tools, config: loaded.config });
      const report = await pluginBus.loadAll(defaultPluginsRoot(options.home), loaded.config.plugins.allow);
      for (const w of report.warnings) line(`warning: ${w}`);
      extensionDisposers.push(() => pluginBus?.dispose());
    }
    if (Object.keys(loaded.config.mcpServers).length > 0) {
      mcpManager = new McpManager({ tools });
      const report = await mcpManager.connectAll(loaded.config.mcpServers);
      for (const w of report.warnings) line(`warning: ${w}`);
      extensionDisposers.push(() => mcpManager?.close());
    }
    approval = {
      decide(input: ApprovalInput) {
        if (alwaysAllowed.has(input.tool)) return 'allow';
        return policy.decide(input);
      },
      async onAsk(input: ApprovalInput) {
        const answer = await hooks.askApproval(
          toolPrompt(input.tool),
          currentAbort?.signal,
        );
        if (answer === ASK_CANCELLED) {
          line('审批等待被取消（该工具调用按拒绝处理）');
          return false;
        }
        const normalized = answer.trim().toLowerCase();
        if (normalized === 'a') {
          alwaysAllowed.add(input.tool);
          return true;
        }
        return normalized === 'y';
      },
    };
  }

  // —— 会话解析 ——
  const manager = new SessionManager(defaultSessionsRoot(options.home));
  const openById = (id: string): ChatSession => {
    const r = manager.resume(id);
    return { id: r.id, dir: r.dir, writer: r.writer };
  };
  const newSession = (): ChatSession => {
    const created = manager.create(root);
    return { id: created.id, dir: created.dir, writer: created.writer };
  };
  if (options.fork !== undefined) {
    try {
      const r = forkSession(manager, options.fork, options.at !== undefined ? { atSeq: options.at } : {});
      current = openById(r.id);
      line(`会话: ${current.id}（自 ${r.parentSession} 分叉，复制 ${r.copiedEvents} 个活动事件）`);
    } catch (e) {
      line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      throw new ChatSetupAbort();
    }
  } else if (options.session !== undefined) {
    try {
      current = openById(options.session);
    } catch (e) {
      line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      throw new ChatSetupAbort();
    }
    line(SESSION_HELP_BANNER(current.id, 'recovered'));
  } else {
    const latest = manager.list(root)[0];
    if (latest) {
      try {
        current = openById(latest.id);
        line(`会话: ${current.id}（已恢复最近会话）`);
      } catch {
        current = null;
      }
    }
    if (!current) {
      current = newSession();
      line(SESSION_HELP_BANNER(current.id, 'new'));
    }
  }
  noteCrashSessionId(current.id);

  // —— subagent 工具装配 ——
  const subagentDisposers: Array<() => void> = [];
  const bindSubagentTools = (sessionId: string): void => {
    for (const dispose of subagentDisposers) dispose();
    subagentDisposers.length = 0;
    for (const name of SUBAGENT_TOOL_NAMES) {
      if (tools.get(name) === undefined) continue;
      const revoked = pluginBus?.revokeTool(name) === true;
      line(
        `warning: 工具 "${name}" 与 subagent 权威工具重名，已剔除冲突版本（subagent 实现优先）${revoked ? '' : '，但冲突工具不可收回'}`,
      );
    }
    const childProvider =
      options.provider === 'mock'
        ? new MockProvider(options.mockChildScript ?? MOCK_CHILD_DEMO_SCRIPT)
        : (subagentConfig?.provider ?? provider);
    for (const def of createSubagentTools({
      manager,
      provider: childProvider,
      baseTools: tools,
      ...(approval !== undefined ? { approval } : {}),
      cwd: root,
      maxDepth: subagentConfig?.maxDepth ?? 1,
      maxTurns: subagentConfig?.maxTurns ?? 25,
      parentSessionId: sessionId,
      depth: 0,
      skills: skillsStore,
    })) {
      if (tools.get(def.name) !== undefined) {
        line(`warning: subagent 工具 "${def.name}" 与不可收回的既有工具重名，本会话跳过注册`);
        continue;
      }
      subagentDisposers.push(tools.register(def));
    }
  };
  bindSubagentTools(current.id);

  // —— 生命周期 ——
  const closeCurrent = (): void => {
    if (current) {
      try {
        current.writer.close();
      } catch {
        // 已关闭/锁异常不阻塞退出
      }
      current = null;
    }
  };

  const runUserTurn = async (text: string, onStream: TurnStreamHandler): Promise<TurnResult> => {
    if (!current) throw new Error('无活动会话');
    const session = current;
    const ac = new AbortController();
    currentAbort = ac;
    const snapshots = new SnapshotStore(session.dir);
    const turnWriter: SessionWriter | SessionAppender =
      pluginBus === undefined
        ? session.writer
        : {
            dir: session.writer.dir,
            get lastSeq(): number {
              return session.writer.lastSeq;
            },
            append: <T extends SessionEventType>(type: T, payload: SessionEventMap[T]) => {
              const event = session.writer.append(type, payload);
              pluginBus.emitSessionEvent(session.id, event as AnySessionEvent);
              return event;
            },
          };
    try {
      const result = await runTurn(turnWriter, {
        provider,
        tools,
        ...(approval !== undefined ? { approval } : {}),
        ...(memoryStore !== undefined ? { memory: memoryStore } : {}),
        skills: skillsStore,
        ...(compaction !== undefined ? { compaction } : {}),
        cwd: root,
        userText: text,
        signal: ac.signal,
        snapshots,
        onStream: (event) => {
          if (event.type === 'text-delta') onStream({ type: 'text-delta', text: event.text });
          else if (event.type === 'tool-call') onStream({ type: 'tool-call', call: event.call });
          else if (event.type === 'reasoning-delta') {
            // reasoning 增量：REPL 不渲染（与落盘展示口径一致）
          } else onStream({ type: 'tool-result', callId: event.callId, ok: event.ok, error: event.error });
        },
      });
      return result;
    } finally {
      currentAbort = null;
    }
  };

  const switchSession = (
    id: string | null,
    opts?: { print?: (t: string) => void },
  ): void => {
    const print = opts?.print ?? line;
    closeCurrent();
    try {
      current = id === null ? newSession() : openById(id);
    } catch (e) {
      print(`error: ${(e as Error).message}`);
      current = newSession();
      print(`会话: ${current.id}（新建）`);
    }
    bindSubagentTools(current.id);
    noteCrashSessionId(current.id);
    print(`会话: ${current.id}（${id === null ? '新建' : '已恢复'}）`);
  };

  const fork = (at?: number, opts?: { print?: (t: string) => void }): void => {
    const print = opts?.print ?? line;
    if (!current) {
      print('error: 无活动会话');
      return;
    }
    try {
      const r = forkSession(manager, current.id, at !== undefined ? { atSeq: at } : {});
      closeCurrent();
      current = openById(r.id);
      print(
        `会话: ${current.id}（自 ${r.parentSession} 分叉，复制 ${r.copiedEvents} 个活动事件${at !== undefined ? `，截取到 seq ${at}` : ''}）`,
      );
    } catch (e) {
      print(`error: ${(e as Error).message}`);
    }
  };

  const finish = async (fhooks: { closeReadline?: () => void; destroyInput?: () => void }): Promise<void> => {
    closeCurrent();
    noteCrashSessionId(undefined);
    for (const dispose of subagentDisposers) dispose();
    subagentDisposers.length = 0;
    for (const dispose of extensionDisposers) {
      try {
        await dispose();
      } catch {
        // 收尾异常不阻塞退出
      }
    }
    extensionDisposers.length = 0;
    try {
      fhooks.closeReadline?.();
    } catch {
      // 已关闭
    }
    try {
      fhooks.destroyInput?.();
    } catch {
      // 非 TTY 读流销毁失败不阻塞退出
    }
  };

  return {
    provider,
    approval,
    tools,
    skillsStore,
    sessionManager: manager,
    getCurrent: () => current,
    switchSession,
    fork,
    runUserTurn,
    abortTurn: () => currentAbort?.abort(),
    closeCurrent,
    clearAlwaysAllowed: () => alwaysAllowed.clear(),
    noteCrash: (id?: string) => noteCrashSessionId(id),
    finish,
  };
}

/** ask 取消哨兵：无法由键盘输入的答案值（turn 取消信号 abort 时以此结束 ask 等待） */
export const ASK_CANCELLED = '\u0000ask-cancelled';

// 审批提问文案（P2-3：[a] 的粒度在提示里写明；仅进程内会话级，不落盘）
const toolPrompt = (tool: string): string =>
  `允许执行 ${tool}? [y]本次 [a]本会话总是（该工具后续所有调用不再询问） [n]拒绝 `;

/** 装配中途配置不可用时抛出的哨兵（调方捕获后应静默返回，勿重复打印） */
export class ChatSetupAbort extends Error {
  constructor() {
    super('chat setup aborted');
    this.name = 'ChatSetupAbort';
  }
}