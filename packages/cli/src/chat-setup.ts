// 共享会话装配：legacy（readline）与旧壳（TUI）两条路径共用同一套 provider / 审批 /
// 记忆 / 压缩 / 插件 / MCP / subagent / 会话解析 / runTurn 语义，避免两套装配各写一份。
// 渲染与输入交错策略由调用方（路径专属）决定：本模块只负责装配与 turn 执行，事件经
// onStream 回调桥接，不直接写 stdout。审批提问经 askApproval 钩子注入（legacy 走 readline
// 拦截；旧壳 走弹窗）。"总是允许"仅存进程内会话级缓存，绝不落盘。
import {
  applyToolSelection,
  createApprovalPolicy,
  createBrowserTools,
  createFanoutTools,
  createMemoryToolForPolicy,
  createProvider,
  createScriptTool,
  createSkillAuthoringTool,
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
  resolveEnabledToolNames,
  runTurn,
  SCRIPT_TOOL_NAME,
  SessionSteerSink,
  forkSession,
  SessionManager,
  SkillAuthoringStore,
  SkillStore,
  SnapshotStore,
  SpawnHistoryStore,
  ToolRegistry,
  ToolRpcService,
  FANOUT_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  type ApprovalConfig,
  type ConfiguredApprovalHandler,
  type ApprovalHandler,
  type ApprovalInput,
  type ChatProvider,
  type CompactionOptions,
  type MemoryMode,
  type MockScript,
  type ToolSelectionConfig,
  type TurnResult,
  type AnySessionEvent,
  type SessionAppender,
  type SessionEventMap,
  type SessionEventType,
  type SessionWriter,
  type ApprovalMode,
  type SteerResult,
  type SubagentHooks,
} from '@harness2/core';
import type { ChatOptions } from './legacy-chat.js';
import { PLAN_MODE_SYSTEM_PREFIX } from './mode-alias.js';
import { buildSteerRequest, makeSteerId, type SteerSubmitOutcome } from './steer.js';

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

/** 装配期输出钩子：渲染/打印（legacy=StreamRenderer.line；旧壳=事件分发） */
export interface ChatSetupHooks {
  line: (t: string) => void;
  /** 审批提问（signal 为 turn 取消信号，abort 时应以便利方式结束等待） */
  askApproval: (query: string, signal?: AbortSignal) => Promise<string>;
  /**
   * P3-D：子会话事件观察缝（可选；透传 createSubagentTools 的 hooks——core 导出契约，
   * 此处仅装配层传参）。next 渲染层用它把子会话事件实时追加进全屏子视图。
   */
  subagentHooks?: SubagentHooks;
}

/** 每轮 turn 的流式渲染回调（legacy=直写 stdout；旧壳=桥接 React state） */
export type TurnStreamHandler = (event: StreamEvent) => void;

/** 与 legacy onStream 对齐的事件联合（T3 加性：携带 turnId 供 typed transcript 归属；legacy 忽略） */
export type StreamEvent =
  | { type: 'text-delta'; text: string; turnId: string }
  | { type: 'tool-call'; call: { id: string; name: string; arguments: string }; turnId: string }
  | { type: 'reasoning-delta'; text: string; turnId: string }
  | { type: 'tool-result'; callId: string; ok: boolean; error?: string; turnId: string };

export type { TurnResult } from '@harness2/core';

/** 共享会话装配与 turn 执行的结果 */
export interface ChatRuntime {
  provider: ChatProvider;
  approval: ApprovalHandler | undefined;
  tools: ToolRegistry;
  /**
   * P7-C 加性：当前会话模型面工具注册表（含会话绑定变体 + config.tools 过滤）——
   * `/tools` 命令的盘点来源；缺省（测试桩）时命令如实显示空表。
   */
  toolRegistry?: () => ToolRegistry;
  /** P7-C 加性：当前生效的 config.tools 选择（/tools 展示启用/禁用状态） */
  toolSelection?: () => ToolSelectionConfig | undefined;
  /** P7-C 加性：项目 config.json 路径（/tools select 落盘目标） */
  configPath?: () => string | undefined;
  skillsStore: SkillStore;
  sessionManager: SessionManager;
  /** 工作目录（config 加载根目录，cwd） */
  root: string;
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
  /** 当前审批模式（仅当前进程/会话生效，不写回 config.json） */
  mode: () => ApprovalMode;
  /** 切换到指定审批模式；切出 plan 时顺带清空 alwaysAllowed；返回新 mode */
  setMode: (mode: ApprovalMode) => ApprovalMode;
  /** 推理过程展示开关（两路径共用同一状态，默认 off，仅当前会话生效） */
  reasoning: () => boolean;
  setReasoning: (on: boolean) => boolean;
  noteCrash: (id?: string) => void;
  /**
   * T5：提交一条 steer（控制输入）。仅当已从首个 TurnStreamEvent 得知当前 turnId 时入队，
   * 否则返回 `unknown` 并由调用方保留草稿（不猜测 turnId、不静默 abort/resend）。
   * 入队仅为受理；最终 accepted/stale/rejected 由 loop 在安全 step 边界/收尾回帧（observeSteer）。
   */
  submitSteer: (text: string) => SteerSubmitOutcome;
  /** T5：当前 turnId（首个 TurnStreamEvent 起可知；空闲或事件未到 → undefined） */
  currentTurnId: () => string | undefined;
  /** T5：订阅 steer 回帧（accepted / stale(draftKept) / rejected），返回退订函数 */
  observeSteer: (fn: (result: SteerResult) => void) => () => void;
  finish: (hooks: { closeReadline?: () => void; destroyInput?: () => void }) => Promise<void>;
}

const SESSION_HELP_BANNER = (id: string, kind: 'recovered' | 'new'): string =>
  `会话: ${id}（${kind === 'recovered' ? '已恢复' : '新建'}）`;

export async function setupChatSession(options: ChatOptions, hooks: ChatSetupHooks): Promise<ChatRuntime> {
  const { line } = hooks;
  const root = options.root !== undefined ? options.root : process.cwd();

  // —— provider 与审批缝 ——
  let provider: ChatProvider;
  let approval: ApprovalHandler | undefined;
  let memoryStore: MemoryStore | undefined;
  let memoryMode: MemoryMode | undefined;
  let memoryPending: PendingMemoryStore | undefined;
  let skillsAuthoringStore: SkillAuthoringStore | undefined;
  let toolsConfig: ToolSelectionConfig | undefined;
  let projectConfigPath: string | undefined;
  let compaction: CompactionOptions | undefined;
  let pluginBus: PluginBus | undefined;
  let mcpManager: McpManager | undefined;
  let subagentConfig: { maxDepth: number; maxTurns: number; provider?: ChatProvider } | undefined;
  const extensionDisposers: Array<() => void | Promise<void>> = [];
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);
  // H-42 扇出历史（P7-C 接线）：进程级单例（跨会话保留最近 10 次；未来 /replay 读）
  const fanoutHistory = new SpawnHistoryStore();
  // 会话绑定工具集（memory/skill_author/subagent/fanout + config.tools 过滤 + run_script）：
  // 每次切换会话重建；未装配任何会话绑定能力时等同静态基座 tools。
  let sessionTools: ToolRegistry = tools;

  // 会话与会话中止态：装配中途即可能被异步闭包（memory sink / 审批 ask）在运行期读取
  let current: ChatSession | null = null;
  let currentAbort: AbortController | null = null;

  // T5：会话级 steer 控制通道。core loop 只在安全 step 边界 take()；sink 本体用 core 的
  // SessionSteerSink（主入口导出，解冻窗口 #2 起），CLI 只做接收/回帧转发，不再本地实现。
  // steer 不写 session.log、不进投影正文。
  const steerSink = new SessionSteerSink();
  const steerObservers = new Set<(result: SteerResult) => void>();
  steerSink.observe({
    onSteerResult: (result) => {
      for (const fn of [...steerObservers]) {
        try {
          fn(result);
        } catch {
          // 观察者异常不影响内核收尾
        }
      }
    },
  });
  let activeTurnId: string | undefined;
  let steerSeq = 0;

  const skillsStore = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(options.home));
  tools.register(createSkillTool(skillsStore));

  const alwaysAllowed = new Set<string>(); // 进程内会话级缓存，不落盘

  // 推理过程展示开关（两路径共享，仅当前会话进程内生效，默认关）
  let reasoningEnabled = false;

  // 运行时审批模式（仅当前进程/会话，不落盘）。policy 随 mode 重建；
  // default 捕获时 approvalCfg 未定义（mock 分支无审批），mode 切换仅改状态。
  let approvalCfg: ApprovalConfig | undefined;
  let currentMode: ApprovalMode = 'default';
  let policy: ConfiguredApprovalHandler | undefined;
  const applyMode = (next: ApprovalMode): ApprovalMode => {
    currentMode = next;
    if (approvalCfg !== undefined) {
      policy = createApprovalPolicy(approvalCfg, undefined, next);
    }
    if (next !== 'plan') alwaysAllowed.clear(); // 切出 plan 清会话级审批缓存
    return next;
  };

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
      compaction = resolveCompactionOptions(loaded.config, (role) => (role === 'small' ? smallProvider : provider));
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
    // 记忆装配（H-21/P7-A）：只建 store/暂存区，工具注册延后到 bindSessionTools——
    // 统一走 createMemoryToolForPolicy（三壳唯一策略出口，off/ask/auto 三态 + 主动持久化）。
    if (loaded.config.memory.mode !== 'off') {
      memoryStore = new MemoryStore(defaultMemoriesRoot(options.home));
      memoryMode = loaded.config.memory.mode;
      if (memoryMode === 'ask') {
        memoryPending = new PendingMemoryStore(defaultPendingRoot(options.home), memoryStore);
      }
    }
    // 经验造技能（P7-A H-22）：skills.authoring=on 才装配 skill_author（缺省 off）
    if (loaded.config.skills?.authoring === 'on') {
      skillsAuthoringStore = new SkillAuthoringStore(projectSkillsRoot(root));
    }
    // 工具面选择（P7-C H-30）：config.tools（缺省不裁剪）+ 项目 config.json 路径（/tools select 落盘目标）
    toolsConfig = loaded.config.tools;
    projectConfigPath = defaultConfigPaths(root, options.home).projectConfig;
    approvalCfg = loaded.config.approval;
    currentMode = approvalCfg?.mode ?? 'default';
    policy = createApprovalPolicy(approvalCfg);
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
        return policy?.decide(input) ?? 'ask';
      },
      async onAsk(input: ApprovalInput) {
        const answer = await hooks.askApproval(toolPrompt(input.tool), currentAbort?.signal);
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

  // —— 会话绑定工具装配（P7 接线）——
  // 每次绑定重建模型面注册表：静态基座 tools − subagent 冲突名/memory → 追加会话变体
  // （memory 按策略 / skill_author / subagent / fanout）→ config.tools 过滤 → run_script
  // （RPC 服务绑本进程审批缝，内层调用同样受审批约束，不可绕过）。切换会话时重绑，
  // 血缘（parentSessionId）与暂存归因（sessionId）随之更新。
  const bindSessionTools = (sessionId: string): void => {
    const next = new ToolRegistry();
    const subNames = new Set<string>([...SUBAGENT_TOOL_NAMES, ...FANOUT_TOOL_NAMES]);
    for (const def of tools.list()) {
      if (def.name === 'memory') continue; // 换装按会话绑定的变体（策略出口统一）
      if (subNames.has(def.name)) {
        // 插件抢占 subagent/fanout 权威工具名：剔除插件版 + 提示（权威版随后重挂）
        const revoked = pluginBus?.revokeTool(def.name) === true;
        line(
          `warning: 工具 "${def.name}" 与 subagent 权威工具重名，已剔除冲突版本（subagent 实现优先）${revoked ? '' : '，但冲突工具不可收回'}`,
        );
        continue;
      }
      next.register(def);
    }
    // 记忆（H-21/P7-A）：off→不注册、ask→pending 暂存、auto→直写 + 主动持久化
    if (memoryStore !== undefined && memoryMode !== undefined) {
      const memoryTool = createMemoryToolForPolicy(memoryStore, memoryMode, {
        ...(memoryPending !== undefined ? { pending: memoryPending } : {}),
        sessionId,
      });
      if (memoryTool !== undefined) next.register(memoryTool);
    }
    // 经验造技能（H-22）：模型只提案，落盘走 `harness2 skill approve <id>`
    if (skillsAuthoringStore !== undefined) {
      next.register(createSkillAuthoringTool(skillsAuthoringStore, { sessionId }));
    }
    // subagent + 并行扇出（阶段 8 / H-42）：按会话绑血缘
    const childProvider =
      options.provider === 'mock'
        ? new MockProvider(options.mockChildScript ?? MOCK_CHILD_DEMO_SCRIPT)
        : (subagentConfig?.provider ?? provider);
    const subagentOptions = {
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
      ...(hooks.subagentHooks !== undefined ? { hooks: hooks.subagentHooks } : {}),
    };
    for (const def of createSubagentTools(subagentOptions)) {
      if (next.get(def.name) !== undefined) {
        line(`warning: subagent 工具 "${def.name}" 与不可收回的既有工具重名，本会话跳过注册`);
        continue;
      }
      next.register(def);
    }
    for (const def of createFanoutTools({ ...subagentOptions, history: fanoutHistory })) {
      if (next.get(def.name) !== undefined) continue;
      next.register(def);
    }
    // 工具面过滤（H-30）：动态工具同样受 toolset/enable 约束；未配置 = 不过滤（零回归）
    const selected = toolsConfig !== undefined ? applyToolSelection(next, toolsConfig) : next;
    // run_script（H-43）：RPC 服务绑本进程审批缝；RPC 可见表 = selected 快照（不含 run_script 防递归）
    const wouldEnableScript =
      toolsConfig === undefined ||
      resolveEnabledToolNames([...selected.list().map((d) => d.name), SCRIPT_TOOL_NAME], toolsConfig).enabled.includes(
        SCRIPT_TOOL_NAME,
      );
    if (wouldEnableScript) {
      const rpcRegistry = new ToolRegistry();
      for (const def of selected.list()) rpcRegistry.register(def);
      const service = new ToolRpcService({
        registry: rpcRegistry,
        cwd: root,
        ...(approval !== undefined ? { approval } : {}),
      });
      selected.register(createScriptTool({ service }));
    }
    sessionTools = selected;
  };
  bindSessionTools(current.id);

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
    activeTurnId = undefined; // T5：turn 起始清空；由首个 TurnStreamEvent 重新绑定
    // plan 模式：每条 user message 前追加系统前缀（文案两路径共用 mode-alias）
    if (currentMode === 'plan' && text.trim().length > 0) {
      text = `${PLAN_MODE_SYSTEM_PREFIX}\n${text}`;
    }
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
        tools: sessionTools,
        ...(approval !== undefined ? { approval } : {}),
        ...(memoryStore !== undefined ? { memory: memoryStore } : {}),
        skills: skillsStore,
        ...(compaction !== undefined ? { compaction } : {}),
        cwd: root,
        userText: text,
        signal: ac.signal,
        snapshots,
        // T5：steer 控制输入通道（loop 只在安全 step 边界消费；legacy 从不 push，行为不变）
        steer: steerSink,
        onStream: (event) => {
          activeTurnId = event.turnId; // 首个事件即绑定本 turn 的 turnId（供 submitSteer）
          if (event.type === 'text-delta') onStream({ type: 'text-delta', text: event.text, turnId: event.turnId });
          else if (event.type === 'tool-call') onStream({ type: 'tool-call', call: event.call, turnId: event.turnId });
          else if (event.type === 'reasoning-delta') {
            // reasoning 增量：默认不渲染（legacy 保持折叠）；开启后转给调用方（旧壳展示）
            if (reasoningEnabled) onStream({ type: 'reasoning-delta', text: event.text, turnId: event.turnId });
          } else
            onStream({
              type: 'tool-result',
              callId: event.callId,
              ok: event.ok,
              error: event.error,
              turnId: event.turnId,
            });
        },
      });
      return result;
    } finally {
      currentAbort = null;
      activeTurnId = undefined; // turn 结束：之后的 steer 视为 unknown（保草稿），不挂到未来 turn
    }
  };

  const switchSession = (id: string | null, opts?: { print?: (t: string) => void }): void => {
    const print = opts?.print ?? line;
    closeCurrent();
    try {
      current = id === null ? newSession() : openById(id);
    } catch (e) {
      print(`error: ${(e as Error).message}`);
      current = newSession();
      print(`会话: ${current.id}（新建）`);
    }
    bindSessionTools(current.id);
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
      bindSessionTools(current.id); // P7：分叉后重绑会话绑定工具（血缘/暂存归因随新会话）
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
    toolRegistry: () => sessionTools,
    toolSelection: () => toolsConfig,
    configPath: () => projectConfigPath,
    skillsStore,
    sessionManager: manager,
    root,
    getCurrent: () => current,
    switchSession,
    fork,
    runUserTurn,
    abortTurn: () => currentAbort?.abort(),
    closeCurrent,
    clearAlwaysAllowed: () => alwaysAllowed.clear(),
    mode: () => currentMode,
    setMode: (next: ApprovalMode) => applyMode(next),
    reasoning: () => reasoningEnabled,
    setReasoning: (on: boolean) => {
      reasoningEnabled = on;
      return reasoningEnabled;
    },
    noteCrash: (id?: string) => noteCrashSessionId(id),
    submitSteer: (text: string): SteerSubmitOutcome => {
      if (text.trim().length === 0) {
        return {
          state: 'rejected',
          reason: '空白 steer 不提交',
          draftKept: true,
          message: '空白 steer 不提交（草稿保留）',
        };
      }
      steerSeq += 1;
      const req = buildSteerRequest(activeTurnId, makeSteerId(steerSeq), text);
      if (req === null) {
        return {
          state: 'unknown',
          reason: '当前没有可绑定的 turn（尚无 turnId）',
          draftKept: true,
          message: '尚无进行中的 turn：steer 未提交（草稿保留）',
        };
      }
      if (!steerSink.push(req)) {
        return {
          state: 'rejected',
          id: req.id,
          reason: '重复的 steer id',
          draftKept: true,
          message: 'steer 被拒绝（重复 id；草稿保留）',
        };
      }
      return {
        state: 'submitted',
        id: req.id,
        turnId: req.expectedTurnId,
        message: 'steer 已提交，将在安全 step 边界应用',
      };
    },
    currentTurnId: () => activeTurnId,
    observeSteer: (fn: (result: SteerResult) => void) => {
      steerObservers.add(fn);
      return () => {
        steerObservers.delete(fn);
      };
    },
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
