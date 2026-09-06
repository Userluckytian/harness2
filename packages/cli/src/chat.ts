// chat REPL：readline 循环 + 流式渲染 + 命令集 + 审批交互 + 会话管理。
// 渲染与输入的交错策略（Windows readline 风险缓解）：turn 期间不写提示符，
// 渲染器独占输出；审批提问由 REPL 直接写问题文本并拦截下一行输入作答案。
// 审批“总是允许”仅存进程内会话级缓存，绝不落盘。
import { createInterface, type Interface } from 'node:readline';
import {
  createApprovalPolicy,
  createMemoryTool,
  createProvider,
  defaultConfigPaths,
  defaultMemoriesRoot,
  defaultPendingRoot,
  loadConfig,
  MemoryStore,
  MockProvider,
  PendingMemoryStore,
  registerBuiltinTools,
  runTurn,
  defaultSessionsRoot,
  SessionManager,
  SnapshotStore,
  ToolRegistry,
  type ApprovalHandler,
  type ApprovalInput,
  type ChatProvider,
  type MemorySink,
  type MockScript,
  type SessionWriter,
} from '@harness2/core';
import { StreamRenderer } from './render.js';
import { handleCommand, parseCommand, type CommandContext } from './commands.js';

export interface ChatOptions {
  /** 恢复指定会话 id；缺省 = 恢复 cwd 最新会话或新建 */
  session?: string;
  /** 'mock' = 内置演示脚本（不加载配置、不触发审批）；缺省按配置 roles.main 构造 */
  provider?: string;
  /** 工作目录：工具执行 cwd + 会话分组（默认 process.cwd()） */
  root?: string;
  /** 用户数据根：配置与会话存储（默认用户 home；测试/多环境用） */
  home?: string;
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

export async function runChat(options: ChatOptions = {}): Promise<void> {
  const root = options.root !== undefined ? options.root : process.cwd();
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const renderer = new StreamRenderer({ write: (t) => output.write(t) });

  // —— provider 与审批缝 ——
  let provider: ChatProvider;
  let approval: ApprovalHandler | undefined;
  // 记忆装配（阶段 6）：mode ≠ off 才注册 memory 工具与注入 store；off = 零记忆行为
  let memoryStore: MemoryStore | undefined;
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  if (options.provider === 'mock') {
    // mock 演示：不接配置（零 key 可用），审批全放行
    provider = new MockProvider(MOCK_DEMO_SCRIPT);
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
  if (options.session !== undefined) {
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

  function finish(): void {
    closeCurrent();
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
        return;
      }
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
  };

  async function runUserTurn(text: string): Promise<void> {
    if (!current) return;
    const ac = new AbortController();
    currentAbort = ac;
    const snapshots = new SnapshotStore(current.dir);
    try {
      const result = await runTurn(current.writer, {
        provider,
        tools,
        ...(approval !== undefined ? { approval } : {}),
        ...(memoryStore !== undefined ? { memory: memoryStore } : {}),
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
