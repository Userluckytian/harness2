// chat REPL（legacy readline 路径）：字符级保留原 readline REPL 行为，供 piped / CI /
// --no-tui / HARNESS2_NO_TUI=1 与非 TTY 场景使用（逃生舱）。装配与会话执行由
// chat-setup.ts 的 setupChatSession（与 ink 路径共用同一套）提供，本文件只保留
// readline 交互循环与渲染交错策略，避免两套装配各写一份。
// 渲染与输入的交错策略（Windows readline 风险缓解）：turn 期间不写提示符，
// 渲染器独占输出；审批提问由 REPL 直接写问题文本并拦截下一行输入作答案。
// 审批"总是允许"仅存进程内会话级缓存，绝不落盘。
import { createInterface, type Interface } from 'node:readline';
import { SnapshotStore, getContextUsage } from '@harness2/core';
import { StreamRenderer } from './render.js';
import { handleCommand, parseCommand, type CommandContext } from './commands.js';
import { MODE_ALIAS_LABEL, MODE_ALIAS_ORDER, MODE_ALIAS_TO_CORE, describeMode, parseModeAlias } from './mode-alias.js';
import { matchCommands } from './command-registry.js';
import { expandContextRefs, hasContextRefs } from './context-ref.js';
import { ASK_CANCELLED, ChatSetupAbort, setupChatSession, type ChatRuntime } from './chat-setup.js';
import type { MockScript } from '@harness2/core';

export { MOCK_CHILD_DEMO_SCRIPT, MOCK_DEMO_SCRIPT } from './chat-setup.js';

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

export async function runLegacyReadlineChat(options: ChatOptions = {}): Promise<void> {
  const root = options.root !== undefined ? options.root : process.cwd();
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const isTTY = (input as NodeJS.ReadStream & { isTTY?: boolean }).isTTY === true;
  const renderer = new StreamRenderer({ write: (t) => output.write(t) }, isTTY);

  // —— 共享装配（provider/审批/记忆/压缩/插件/MCP/subagent/会话解析；与 ink 路径同一份） ——
  let runtime: ChatRuntime;
  try {
    runtime = await setupChatSession(options, {
      line: (t) => renderer.line(t),
      async askApproval(query, signal) {
        return askUser(query, signal);
      },
    });
  } catch (e) {
    if (e instanceof ChatSetupAbort) return; // 装配失败已由 setup 逐行打印 error 与 exit code
    throw e;
  }

  // —— readline REPL ——
  const rl: Interface = createInterface({
    input,
    output,
    prompt: '> ',
    terminal: isTTY,
    // Tab 补全（terminal 模式生效）：命令名阶段从两路径共享注册表读，非命令不补全
    completer: (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('/')) return [[], line];
      // 命令名阶段（尝试补全命令名本身；带空格进入参数阶段不补全）
      const namePart = trimmed.split(' ')[0] ?? '';
      const hits = matchCommands(namePart);
      return [hits, namePart];
    },
  });
  let exiting = false;
  let busy = false;
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

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  async function finish(): Promise<void> {
    await runtime.finish({
      closeReadline: () => rl.close(),
      destroyInput: () => (input as NodeJS.ReadStream).destroy?.(),
    });
    resolveDone();
  }

  const ctx: CommandContext = {
    print: (t) => renderer.line(t),
    manager: runtime.sessionManager,
    cwd: root,
    current: () => runtime.getCurrent(),
    switchSession(id) {
      runtime.switchSession(id, { print: (t) => renderer.line(t) });
    },
    requestExit() {
      exiting = true;
      if (busy && runtime.abortTurn != null) {
        runtime.abortTurn(); // 任务收尾时 finish
        return;
      }
      void finish();
    },
    snapshots: () => {
      const current = runtime.getCurrent();
      return current ? new SnapshotStore(current.dir) : undefined;
    },
    fork: (at?: number) => {
      runtime.fork(at, { print: (t) => renderer.line(t) });
    },
  };

  async function runUserTurn(text: string): Promise<void> {
    // @file/@dir 引用解析（发送前预处理；回显仍用原始 text）
    let sendText = text;
    if (hasContextRefs(text)) {
      const ref = expandContextRefs(text, { cwd: root, root });
      if (ref.hasRefs && ref.header.length > 0) sendText = `${ref.header}\n\n${text}`;
    }
    const result = await runtime.runUserTurn(sendText, (event) => {
      if (event.type === 'text-delta') renderer.textDelta(event.text);
      else if (event.type === 'tool-call') renderer.toolCall(event.call.name, event.call.arguments);
      else if (event.type === 'reasoning-delta') {
        // reasoning 增量：默认不渲染（折叠）；/reasoning on 时由 setup 仅在该态转发到此
        if (event.type === 'reasoning-delta' && runtime.reasoning()) renderer.reasoning(event.text);
      } else renderer.toolResult(event.callId, event.ok, event.error);
    });
    renderer.turnEnd(result);
  }

  /** /reasoning：查看/切换推理过程展示（on|off，默认 off；两路径共用同一状态） */
  function handleReasoningCommand(rest: string): void {
    const arg = rest.trim().toLowerCase();
    if (arg.length === 0) {
      renderer.line(`推理展示: ${runtime.reasoning() ? '开启' : '关闭'}（/reasoning on|off）`);
      return;
    }
    if (arg === 'on') {
      runtime.setReasoning(true);
      renderer.line('推理展示已开启（灰色斜体折叠输出）。');
    } else if (arg === 'off') {
      runtime.setReasoning(false);
      renderer.line('推理展示已关闭。');
    } else {
      renderer.line(`error: 未知参数 ${rest}（用 on|off，或留空查看当前状态）`);
    }
  }

  /** /mode：无参列出四选项与说明；带参直接应用别名（两路径共用 mode-alias 文案与映射） */
  function handleModeCommand(rest: string): void {
    if (rest.length === 0) {
      renderer.line(`当前模式: ${describeMode(runtime.mode())}`);
      renderer.line('可选模式:');
      for (const alias of MODE_ALIAS_ORDER) {
        renderer.line(`  ${alias}\t${MODE_ALIAS_LABEL[alias]}`);
      }
      renderer.line('用法: /mode <别名>（如 /mode plan）');
      return;
    }
    const alias = parseModeAlias(rest);
    if (alias === undefined) {
      renderer.line(`error: 未知模式 ${rest}（可选: ${MODE_ALIAS_ORDER.join(', ')}）`);
      return;
    }
    runtime.setMode(MODE_ALIAS_TO_CORE[alias]);
    renderer.line(`已切换模式: ${alias}（${MODE_ALIAS_LABEL[alias]}）`);
  }

  async function handleLine(line: string): Promise<void> {
    busy = true;
    try {
      const parsed = parseCommand(line);
      if (parsed !== null) {
        if (parsed.name === '/mode') {
          handleModeCommand(parsed.rest);
        } else if (parsed.name === '/context') {
          const current = runtime.getCurrent();
          const usage = current !== null ? getContextUsage(current.dir) : undefined;
          renderer.line(`上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`);
        } else if (parsed.name === '/compact') {
          renderer.line('压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。');
        } else if (parsed.name === '/reasoning') {
          handleReasoningCommand(parsed.rest);
        } else if (parsed.name === '/tasks') {
          renderer.line('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
        } else {
          handleCommand(parsed, ctx);
        }
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
        void finish();
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
    if (busy) {
      renderer.line('^C（正在取消当前 turn…）');
      runtime.abortTurn();
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
    if (busy) runtime.abortTurn();
    if (!busy) void finish();
  });

  renderer.line(
    `harness2 chat — provider: ${runtime.provider.name}${options.provider === 'mock' ? '（mock 演示：不加载配置）' : ''}`,
  );
  renderer.line('输入 /help 查看命令；write/edit 的文件改动可 /undo（bash 改动不进快照）');
  rl.prompt();

  await done;
}
