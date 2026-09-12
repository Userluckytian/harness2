// demo-next.mjs — W3 next 渲染层真机冒烟（不走 setupChatSession，直接驱动 next-shell 的
// 最小 mock runtime）：流式文本 + 一次工具调用 + 一次审批，全部走真终端
// （Screen alt-screen 差量帧 + 统一输入层 + raw mode）。
//
// 复跑：node scripts/demo-next.mjs
//   - 输入文字后 Enter → mock turn：流式两段正文 → write 工具调用 → 审批 overlay
//     （↑↓ / 1-3 / Enter 选择；y 允许 / a 总是 / n 拒绝；Esc 取消）→ 工具结果 → 终稿。
//   - Ctrl+C：忙时取消 turn；空闲 2s 内双击退出。
//   - Esc：忙时停止 turn；空闲清空草稿。Ctrl+O 展开/收起最近工具卡。
// 装配参考：src/commands/chat.ts 的 --provider mock 与 runInkChat.tsx 的 raw mode 做法。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, existsSync } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, '..');

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('ESBUILD_MISSING need esbuild dev dep');
  process.exit(2);
}

// next-shell.ts（TS，import 链含 react/@harness2/core/diff）→ 临时 bundle 后动态 import
const outfile = join(CLI_ROOT, 'scripts', `.next-shell-demo-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [join(CLI_ROOT, 'src', 'tui', 'next', 'next-shell.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  sourcemap: false,
  logLevel: 'warning',
  external: ['@harness2/core', 'diff', 'react', 'string-width'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 最小 mock runtime（只实现 next-shell 消费的面）——
let turnSeq = 0;
const runtime = {
  provider: { name: 'mock-demo' },
  root: process.cwd(),
  getCurrent: () => null,
  switchSession: () => undefined,
  mode: () => 'default',
  setMode: (m) => m,
  reasoning: () => false,
  setReasoning: (on) => on,
  noteCrash: () => undefined,
  submitSteer: () => ({ state: 'unknown', reason: 'demo', draftKept: true, message: 'demo 无 steer' }),
  currentTurnId: () => undefined,
  observeSteer: (_fn) => () => undefined,
  abortTurn: () => console.error('（demo：abortTurn 被调用——Ctrl+C/Esc 取消生效）'),
  closeCurrent: () => undefined,
  clearAlwaysAllowed: () => undefined,
  finish: async () => undefined,
  tools: {},
  skillsStore: {},
  sessionManager: { list: () => [], locate: () => undefined },
  approval: undefined,
  async runUserTurn(text, onStream) {
    turnSeq += 1;
    const turnId = `demo-turn-${turnSeq}`;
    onStream({ type: 'text-delta', text: `收到「${text}」。`, turnId });
    await sleep(300);
    onStream({ type: 'text-delta', text: '我来写入演示文件，需要审批：', turnId });
    await sleep(300);
    onStream({
      type: 'tool-call',
      call: {
        id: `demo-write-${turnSeq}`,
        name: 'write',
        arguments: JSON.stringify({ file_path: 'next-demo.txt', content: 'next 渲染层演示文件\n' }),
      },
      turnId,
    });
    // 审批（真机交互：↑↓/数字/Enter，Esc 或 Ctrl+C 取消 → 按拒绝处理）
    const answer = await demoGate.ask('允许执行 write?');
    if (answer !== 'y' && answer !== 'a') {
      onStream({ type: 'tool-result', callId: `demo-write-${turnSeq}`, ok: false, error: '用户拒绝', turnId });
      return {
        stopReason: 'end_turn',
        steps: 1,
        toolCalls: 1,
        durationMs: 1,
        turnId,
        textOutcome: 'final',
        finalText: '审批被拒绝，演示结束（工具未执行）。',
      };
    }
    await sleep(200);
    onStream({ type: 'tool-result', callId: `demo-write-${turnSeq}`, ok: true, turnId });
    await sleep(200);
    onStream({ type: 'text-delta', text: '写入完成，', turnId });
    await sleep(200);
    onStream({ type: 'text-delta', text: '这就是最终回复。', turnId });
    await sleep(60);
    return {
      stopReason: 'end_turn',
      steps: 2,
      toolCalls: 1,
      durationMs: 5,
      turnId,
      textOutcome: 'final',
      finalText: '写入完成，这就是最终回复。',
    };
  },
};

// —— 终端装配（与 runNextChat 同口径：alt-screen + bracketed paste + raw mode）——
const stdout = process.stdout;
const stdin = process.stdin;
const canRaw = stdin.isTTY === true && typeof stdin.setRawMode === 'function';

const nextShell = await import(pathToFileURL(outfile).href);
const { Screen, createApprovalGate, createNextChatHarness } = nextShell;
const demoGate = createApprovalGate();
const screen = new Screen(stdout, stdout.columns ?? 80, stdout.rows ?? 24);
screen.start({ mouse: process.env.HARNESS2_MOUSE !== '0' });
stdout.write('\x1b[?2004h');
if (canRaw) stdin.setRawMode(true);

const harness = createNextChatHarness(runtime, {
  out: stdout,
  bootLines: ['next 渲染层 demo：输入文字回车发起 mock turn；Ctrl+C 双击退出。'],
  env: process.env,
  gate: demoGate,
  screen,
  cleanup: async () => {
    screen.stop();
    stdout.write('\x1b[?2004l');
    if (canRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* 已销毁 */
      }
    }
  },
  exit: (code) => {
    process.exitCode = code;
  },
});

stdin.on('data', (chunk) => harness.feed(chunk));
stdout.on('resize', () => harness.resize(stdout.columns ?? 80, stdout.rows ?? 24));

try {
  const code = await harness.awaitDone();
  process.exitCode = code;
} finally {
  stdin.removeAllListeners('data');
  stdout.removeAllListeners('resize');
  if (existsSync(outfile)) rmSync(outfile, { force: true });
}
