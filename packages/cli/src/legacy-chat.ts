// chat REPL：readline 循环 + 流式渲染 + 命令集 + 审批交互 + 会话管理。
// 渲染与输入的交错策略（Windows readline 风险缓解）：turn 期间不写提示符，
// 渲染器独占输出；审批提问由 REPL 直接写问题文本并拦截下一行输入作答案。
// 审批“总是允许”仅存进程内会话级缓存，绝不落盘。
import { createInterface, type Interface } from 'node:readline';
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
  defaultSessionsRoot,
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
  type AnySessionEvent,
  type SessionAppender,
  type SessionEventMap,
  type SessionEventType,
  type SessionWriter,
} from '@harness2/core';
import { StreamRenderer } from './render.js';
import { handleCommand, parseCommand, type CommandContext } from './commands.js';

export interface ChatOptions {
  /** 恢复指定会话 id；缺省 = 恢复 cwd 最新会话或新建 */
  session?: string;
  /** 从指定会话分叉新会话并继续（可配 at 截取；阶段 6） */
  fork?: string;
  /** --fork 的截取上界（事件 seq，含）；缺省 = 全部活动事件 */
  at?: number;
  /** 'mock' = 内置演示脚本（不加载配置、不触发审批）；缺省按配置 roles.main 构造 */
  provider?: string;
  /** 工作目录：工具执行 cwd + 会话分组（默认 process.cwd()） */
  root?: string;
  /** 用户数据根：配置与会话存储（默认用户 home；测试/多环境用） */
  home?: string;
  /** 覆盖 mock 演示脚本（测试注入；缺省 MOCK_DEMO_SCRIPT） */
  mockScript?: MockScript;
  /** 覆盖 mock 模式子会话脚本（subagent_start 派发的子会话 turn；测试注入） */
  mockChildScript?: MockScript;
  /** 可注入 I/O（默认 process.stdin/stdout；测试用） */
  stdin?: NodeJS.ReadableStream;
  stdout?: import('node:stream').Writable;
}

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

// P2-3：[a] 的粒度在提示里写明（该工具后续所有调用不再询问；仅进程内会话级，不落盘）
const APPROVAL_PROMPT = (tool: string): string =>
  `允许执行 ${tool}? [y]本次 [a]本会话总是（该工具后续所有调用不再询问） [n]拒绝 `;

/** ask 取消哨兵：无法由键盘输入的答案值（turn 取消信号 abort 时以此结束 ask 等待，P2-2） */
const ASK_CANCELLED = '\u0000ask-cancelled';

interface ChatSession {
  id: string;
  dir: string;
  writer: SessionWriter;
}

export async function runLegacyReadlineChat(options: ChatOptions = {}): Promise<void> {
  const root = options.root !== undefined ? options.root : process.cwd();
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const renderer = new StreamRenderer({ write: (t) => output.write(t) });

  // —— provider 与审批缝 ——
  let provider: ChatProvider;
  let approval: ApprovalHandler | undefined;
  // 记忆装配（阶段 6）：mode ≠ off 才注册 memory 工具与注入 store；off = 零记忆行为
  let memoryStore: MemoryStore | undefined;
  // 压缩装配（阶段 7）：仅配置路径派生（mock 演示零压缩行为）
  let compaction: CompactionOptions | undefined;
  // 阶段 8 装配（配置路径）：插件总线 / MCP / subagent 参数
  let pluginBus: PluginBus | undefined;
  let mcpManager: McpManager | undefined;
  let subagentConfig: { maxDepth: number; maxTurns: number; provider?: ChatProvider } | undefined;
  // 退出收尾（MCP 连接 / 插件订阅逆序展开）；dispose 允许异步（P2-5②：MCP close 等真正
  // 完成后再放行进程退出，不再 `void` 丢弃——REPL 会话日志与子进程收尾不被截断）
  const extensionDisposers: Array<() => void | Promise<void>> = [];
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  // Skills 装配（阶段 10）：项目级 .harness2/skills/ 优先于全局 ~/.harness2/skills/。
  // 无 config 开关：两级扫描按需读盘（空目录 = 零注入）；全文经 skill 工具按需加载。
  const skillsStore = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(options.home));
  tools.register(createSkillTool(skillsStore));

  if (options.provider === 'mock') {
    // mock 演示：不接配置（零 key 可用），审批全放行
    provider = new MockProvider(options.mockScript ?? MOCK_DEMO_SCRIPT);
  } else {
    const loaded = loadConfig({ root, ...(options.home !== undefined ? { home: options.home } : {}) });
    if (loaded.config === null) {
      for (const err of loaded.errors) renderer.line(`error: ${err}`);
      process.exitCode = 1;
      return;
    }
    for (const w of loaded.warnings) renderer.line(`warning: ${w}`);
    try {
      const paths = defaultConfigPaths(root, options.home);
      provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
    // 压缩装配（阶段 7）：contextWindow = roles.main 容量声明；摘要 = roles.small（缺失回落主）
    let smallProvider: ChatProvider | undefined;
    try {
      smallProvider = createProvider(loaded.config, 'small', { authPath: paths.globalAuth });
    } catch {
      smallProvider = undefined;
    }
    compaction = resolveCompactionOptions(loaded.config, (role) =>
      role === 'small' ? smallProvider : provider,
    );
    // subagent 装配参数（阶段 8）：provider 取 roles.subagent（缺失回退主）；深度红线来自 config
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
    // 浏览器装配（阶段 7）：enabled 时注册 browser_* 工具（CLI 单会话，池键 = 'cli'）
    if (loaded.config.browser.enabled) {
      const pool = getSharedBrowserPool({
        idleDestroyMs: loaded.config.browser.idleDestroyMs,
        maxConcurrent: loaded.config.browser.maxConcurrent,
      });
      for (const def of createBrowserTools('cli', pool)) tools.register(def);
    }
  } catch (e) {
      renderer.line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (loaded.config.memory.mode !== 'off') {
      memoryStore = new MemoryStore(defaultMemoriesRoot(options.home));
      if (loaded.config.memory.mode === 'ask') {
        // ask：主对话的记忆写入先进 pending 暂存（harness2 memory approve 落盘）
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
    // 插件装载（阶段 8）：enabled 时扫描 ~/.harness2/plugins，allow 名单审批后装载进工具链。
    // 事件订阅经 per-turn writer 包裹桥接（见 runUserTurn）；serve 模式由 hub 镜像桥接同源。
    if (loaded.config.plugins.enabled) {
      pluginBus = new PluginBus({ tools, config: loaded.config });
      const report = await pluginBus.loadAll(defaultPluginsRoot(options.home), loaded.config.plugins.allow);
      for (const w of report.warnings) renderer.line(`warning: ${w}`);
      extensionDisposers.push(() => pluginBus?.dispose());
    }
    // MCP 连接（阶段 8）：逐 server 连接并注册 mcp__<server>__<tool>；失败退避重启不拖垮 REPL
    if (Object.keys(loaded.config.mcpServers).length > 0) {
      mcpManager = new McpManager({ tools });
      const report = await mcpManager.connectAll(loaded.config.mcpServers);
      for (const w of report.warnings) renderer.line(`warning: ${w}`);
      extensionDisposers.push(() => mcpManager?.close());
    }
    const alwaysAllowed = new Set<string>(); // 进程内会话级缓存，不落盘
    approval = {
      decide(input: ApprovalInput) {
        if (alwaysAllowed.has(input.tool)) return 'allow';
        return policy.decide(input);
      },
      async onAsk(input: ApprovalInput) {
        // P2-2：ask 等待与 turn 取消信号竞速——signal abort 时以取消态结束（按拒绝处理），
        // 不再无限悬挂（Ctrl+C / Ctrl+D / /exit 期间的等待均可取消），且取消后不再吞下一行输入。
        const answer = await askUser(APPROVAL_PROMPT(input.tool), currentAbort?.signal);
        if (answer === ASK_CANCELLED) {
          renderer.line('审批等待被取消（该工具调用按拒绝处理）');
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

  // —— 会话解析：--session id → 恢复；否则 cwd 最新会话；否则新建 ——
  const manager = new SessionManager(defaultSessionsRoot(options.home));
  let current: ChatSession | null = null;
  const openById = (id: string): ChatSession => {
    const r = manager.resume(id);
    return { id: r.id, dir: r.dir, writer: r.writer };
  };
  const newSession = (): ChatSession => {
    // P2-5：fsync 与恢复路径（manager.resume 默认 true）保持一致，不再对新建降级
    const created = manager.create(root);
    return { id: created.id, dir: created.dir, writer: created.writer };
  };
  if (options.fork !== undefined) {
    // --fork <id> [--at <seq>]：先分叉（读原会话活动投影 → 新会话血缘重放），再打开新会话
    try {
      const r = forkSession(manager, options.fork, options.at !== undefined ? { atSeq: options.at } : {});
      current = openById(r.id);
      renderer.line(`会话: ${current.id}（自 ${r.parentSession} 分叉，复制 ${r.copiedEvents} 个活动事件）`);
    } catch (e) {
      renderer.line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  } else if (options.session !== undefined) {
    try {
      current = openById(options.session);
    } catch (e) {
      renderer.line(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    renderer.line(`会话: ${current.id}（已恢复）`);
  } else {
    const latest = manager.list(root)[0];
    if (latest) {
      try {
        current = openById(latest.id);
        renderer.line(`会话: ${current.id}（已恢复最近会话）`);
      } catch {
        current = null; // 最新会话打不开（如被占用）→ 新建
      }
    }
    if (!current) {
      current = newSession();
      renderer.line(`会话: ${current.id}（新建）`);
    }
  }
  noteCrashSessionId(current.id); // 崩溃报告携带当前会话 id（阶段 11 Task 4）

  // —— subagent 工具装配（阶段 8）：按当前会话 id 绑定血缘；会话切换时重绑 ——
  // mock 模式用注入的子脚本 provider；配置模式取 roles.subagent（缺失回退主 provider）。
  const subagentDisposers: Array<() => void> = [];
  const bindSubagentTools = (sessionId: string): void => {
    for (const dispose of subagentDisposers) dispose();
    subagentDisposers.length = 0;
    // P1-3：插件抢占 subagent 权威工具名 → 先剔除冲突插件工具 + 告警（subagent 工具为权威
    // 实现）。原实现直接 tools.register 重名 throw 在 try/catch 之外，chat 整体崩溃。
    for (const name of SUBAGENT_TOOL_NAMES) {
      if (tools.get(name) === undefined) continue;
      const revoked = pluginBus?.revokeTool(name) === true;
      renderer.line(
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
      // 阶段 11 口径统一：CLI 子会话不再经共享注册表继承 memory/browser（per-session
      // 绑定类，核心侧剔除）；skills 注入为加性——与宿主同一 SkillStore
      skills: skillsStore,
    })) {
      if (tools.get(def.name) !== undefined) {
        // 防御兜底：冲突工具不可收回（非插件来源等）→ 跳过该权威版，绝不让 REPL 崩溃
        renderer.line(`warning: subagent 工具 "${def.name}" 与不可收回的既有工具重名，本会话跳过注册`);
        continue;
      }
      subagentDisposers.push(tools.register(def));
    }
  };
  bindSubagentTools(current.id);

  // —— readline REPL ——
  const isTTY = (input as NodeJS.ReadStream & { isTTY?: boolean }).isTTY === true;
  const rl: Interface = createInterface({ input, output, prompt: '> ', terminal: isTTY });
  let exiting = false;
  let busy = false;
  let currentAbort: AbortController | null = null;
  const queue: string[] = [];
  let answerResolver: ((line: string) => void) | null = null;
  let lastCtrlCAt = 0;

  /**
   * 内联审批提问：拦截下一行输入作答案（answerResolver）。
   * 提供 signal 时与 turn 取消竞速（P2-2）：abort → 以 ASK_CANCELLED 结束等待，
   * 并清空 answerResolver——取消后到达的输入行走正常 REPL 流程，不再被当答案吞掉。
   */
  function askUser(query: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolveAnswer) => {
      const settle = (line: string): void => {
        if (answerResolver === resolveAnswer) answerResolver = null;
        signal?.removeEventListener('abort', onAbort);
        resolveAnswer(line);
      };
      const onAbort = (): void => settle(ASK_CANCELLED);
      output.write(query);
      answerResolver = resolveAnswer;
      if (signal === undefined) return;
      if (signal.aborted) {
        settle(ASK_CANCELLED);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function closeCurrent(): void {
    if (current) {
      try {
        current.writer.close();
      } catch {
        // 已关闭/锁异常不阻塞退出
      }
      current = null;
    }
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  async function finish(): Promise<void> {
    closeCurrent();
    noteCrashSessionId(undefined);
    for (const dispose of subagentDisposers) dispose();
    subagentDisposers.length = 0;
    for (const dispose of extensionDisposers) {
      try {
        await dispose(); // P2-5②：await MCP close 等异步收尾（完成后再 resolveDone 放行退出）
      } catch {
        // 收尾异常不阻塞退出
      }
    }
    extensionDisposers.length = 0;
    try {
      rl.close();
    } catch {
      // 已关闭
    }
    try {
      // 关闭输入流：确保事件循环可排空、进程能退出（/exit 或 Ctrl+D 后）
      (input as NodeJS.ReadStream).destroy?.();
    } catch {
      // 非 TTY 读流销毁失败不阻塞退出
    }
    resolveDone();
  }

  const ctx: CommandContext = {
    print: (t) => renderer.line(t),
    manager,
    cwd: root,
    current: () => current,
    switchSession(id) {
      closeCurrent();
      try {
        current = id === null ? newSession() : openById(id);
      } catch (e) {
        // 恢复失败：回到一个新会话，保证 REPL 仍可用
        renderer.line(`error: ${(e as Error).message}`);
        current = newSession();
        renderer.line(`会话: ${current.id}（新建）`);
      }
      bindSubagentTools(current.id); // subagent 血缘随会话切换重绑（阶段 8）
      noteCrashSessionId(current.id); // 崩溃报告会话上下文随切换更新
      renderer.line(`会话: ${current.id}（${id === null ? '新建' : '已恢复'}）`);
    },
    requestExit() {
      exiting = true;
      if (busy && currentAbort) {
        currentAbort.abort(); // 任务收尾时 finish
        return;
      }
      finish();
    },
    snapshots: () => (current ? new SnapshotStore(current.dir) : undefined),
    fork: (at?: number) => {
      if (!current) {
        renderer.line('error: 无活动会话');
        return;
      }
      try {
        const r = forkSession(manager, current.id, at !== undefined ? { atSeq: at } : {});
        closeCurrent();
        current = openById(r.id);
        renderer.line(
          `会话: ${current.id}（自 ${r.parentSession} 分叉，复制 ${r.copiedEvents} 个活动事件${at !== undefined ? `，截取到 seq ${at}` : ''}）`,
        );
      } catch (e) {
        renderer.line(`error: ${(e as Error).message}`);
      }
    },
  };

  async function runUserTurn(text: string): Promise<void> {
    if (!current) return;
    const session = current;
    const ac = new AbortController();
    currentAbort = ac;
    const snapshots = new SnapshotStore(session.dir);
    // 插件事件桥接（阶段 8）：per-turn writer 包裹（先落盘、后回调 → 插件 on 订阅）；
    // serve 模式由 hub 镜像桥接，同源不旁路。
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
              // append 按 T 构造，必属 AnySessionEvent 联合成员（此处收窄需显式断言）
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
          if (event.type === 'text-delta') renderer.textDelta(event.text);
          else if (event.type === 'tool-call') renderer.toolCall(event.call.name, event.call.arguments);
          else if (event.type === 'reasoning-delta') {
            // reasoning 增量：REPL 不渲染（与落盘展示口径一致；服务层用它推送 reasoning delta）
          } else renderer.toolResult(event.callId, event.ok, event.error);
        },
      });
      renderer.turnEnd(result);
    } finally {
      currentAbort = null;
    }
  }

  async function handleLine(line: string): Promise<void> {
    busy = true;
    try {
      const parsed = parseCommand(line);
      if (parsed !== null) {
        handleCommand(parsed, ctx);
      } else if (line.trim().length === 0) {
        // 空行：无操作（Ctrl+D = EOF 由 readline close 处理）
      } else {
        await runUserTurn(line);
      }
    } catch (e) {
      renderer.line(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      busy = false;
      if (exiting) {
        finish();
        return;
      }
      const next = queue.shift();
      if (next !== undefined) void handleLine(next);
      else rl.prompt();
    }
  }

  rl.on('line', (line) => {
    // 审批答案优先（REPL 内联提问期间的下一行输入）；ask 被取消后 answerResolver
    // 已被清空（P2-2），取消后的输入行不再被当答案吞掉，走正常 REPL 流程
    if (answerResolver) {
      const resolveAnswer = answerResolver;
      answerResolver = null;
      resolveAnswer(line);
      return;
    }
    if (exiting) return;
    if (busy) {
      queue.push(line);
      return;
    }
    void handleLine(line);
  });
  rl.on('SIGINT', () => {
    // TTY Ctrl+C：turn 进行中（含审批 ask 等待，P2-2——ask 与 signal 竞速会随 abort 结束）
    // = 取消当前 turn；空闲 = 两次退出
    if (busy && currentAbort) {
      renderer.line('^C（正在取消当前 turn…）');
      currentAbort.abort();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlCAt < 2000) {
      ctx.requestExit();
      return;
    }
    lastCtrlCAt = now;
    renderer.line('（再按一次 Ctrl+C 退出）');
    rl.prompt();
  });
  rl.on('close', () => {
    // Ctrl+D / stdin 结束：若 turn 进行中先取消，等当前任务收尾后 finish
    exiting = true;
    currentAbort?.abort();
    if (!busy) finish();
  });

  renderer.line(`harness2 chat — provider: ${provider.name}${options.provider === 'mock' ? '（mock 演示：不加载配置）' : ''}`);
  renderer.line('输入 /help 查看命令；write/edit 的文件改动可 /undo（bash 改动不进快照）');
  rl.prompt();

  await done;
}
