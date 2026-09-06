// chat REPL 集成测试（piped stdin 非交互）：流式渲染/命令集/undo+redo 文件复原/审批交互。
// 依赖根脚本 `pnpm -r build`（dist/index.js）。mock provider 全程零 API key。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface ChatProc {
  proc: ChildProcess;
  out(): string;
  wait(pattern: string | RegExp | (() => boolean), timeoutMs?: number): Promise<string>;
  send(line: string): void;
  exit(timeoutMs?: number): Promise<number>;
}

function startChat(args: string[]): ChatProc {
  const proc = spawn('node', [cliEntry, 'chat', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  proc.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const chat: ChatProc = {
    proc,
    out: () => stdout,
    async wait(pattern, timeoutMs = 15000) {
      const start = Date.now();
      const test =
        typeof pattern === 'function'
          ? pattern
          : typeof pattern === 'string'
            ? () => stdout.includes(pattern)
            : () => pattern.test(stdout);
      while (!test()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `waitFor timeout (${String(pattern)});\n--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr}`,
          );
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return stdout;
    },
    send(line) {
      proc.stdin!.write(line + '\n');
    },
    async exit(timeoutMs = 10000) {
      if (!proc.stdin!.destroyed && proc.stdin!.writable) {
        this.send('/exit');
        proc.stdin!.end();
      }
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          proc.kill();
          resolve(null);
        }, timeoutMs);
        proc.on('close', (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      return code ?? -1;
    },
  };
  return chat;
}

describe('harness2 chat --provider mock（流式/命令/undo+redo）', () => {
  it('演示 turn：流式文本 + 工具行 + 落盘文件；/undo --dry-run 预览不动文件；/undo 删除创建文件；/redo 恢复', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      chat.send('开始演示'); // 触发 mock 演示脚本
      await chat.wait('演示完成'); // mock 三段 textChunks 流式拼流 + 两轮工具

      const out = chat.out();
      expect(out).toContain('provider: mock');
      // 流式工具行与结果行
      expect(out).toContain('> write (');
      expect(out).toContain('< ok [demo-write-1]');
      expect(out).toContain('> read (');
      expect(out).toContain('< ok [demo-read-1]');
      expect(out).toContain('[end_turn'); // turn 摘要行
      // write 真实落盘
      const demoFile = join(work, 'harness2-demo.txt');
      expect(existsSync(demoFile)).toBe(true);
      expect(readFileSync(demoFile, 'utf8')).toContain('mock 演示文件');

      // /undo --dry-run：预览、不动文件
      chat.send('/undo --dry-run');
      await chat.wait('预览（未执行）');
      expect(chat.out()).toContain('删除创建的文件');
      expect(chat.out()).toContain('（待执行）');
      expect(existsSync(demoFile)).toBe(true);

      // /undo：撤回 demo turn（1 user + 3 assistant 消息），创建的文件被删除
      chat.send('/undo');
      await chat.wait('已撤回 4 条消息');
      expect(existsSync(demoFile)).toBe(false);

      // /redo：恢复 after 内容
      chat.send('/redo');
      await chat.wait('已重做 4 条消息');
      expect(existsSync(demoFile)).toBe(true);
      expect(readFileSync(demoFile, 'utf8')).toContain('mock 演示文件');
    } finally {
      const code = await chat.exit();
      expect(code).toBe(0);
    }
  }, 30000);

  it('会话命令：/new 换新会话、/sessions 列表标记当前、/sessions 关键字搜索命中、未知命令报错', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      const firstId = /会话: (\S+)（新建）/.exec(chat.out())?.[1] ?? '';
      expect(firstId).not.toBe('');

      chat.send('开始演示');
      await chat.wait('演示完成'); // 先跑一轮，留消息供搜索
      chat.send('/new');
      await chat.wait(() => [...chat.out().matchAll(/会话: \S+（新建）/g)].length >= 2);
      const ids = [...chat.out().matchAll(/会话: (\S+)（新建）/g)];
      const secondId = ids.at(-1)?.[1] ?? '';
      expect(secondId).not.toBe(firstId);

      chat.send('/sessions');
      await chat.wait(`${firstId}  `); // 列表行格式（id + 两空格），与 /new 横幅区分
      expect(chat.out()).toContain(secondId);
      expect(chat.out()).toContain(' 条 *'); // 当前会话标记

      chat.send('/sessions 演示完成');
      await chat.wait('命中 [assistant@');
      expect(chat.out()).toContain(firstId); // 命中在第一个会话

      chat.send('/nope');
      await chat.wait('未知命令 /nope');

      chat.send('/help');
      await chat.wait('bash 命令造成的改动不进快照'); // 如实声明进帮助
    } finally {
      const code = await chat.exit();
      expect(code).toBe(0);
    }
  }, 30000);

  it('空行不产生 turn；/exit 退出码 0', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      const before = chat.out().length;
      chat.send('');
      await new Promise((r) => setTimeout(r, 300));
      // 空行后不应有新的 turn 摘要
      expect(chat.out().slice(before)).not.toContain('[end_turn');
    } finally {
      const code = await chat.exit();
      expect(code).toBe(0);
    }
  }, 20000);
});

// —— 会话恢复与多级 undo（审查 P2-6a/6b 覆盖缺口） ——

describe('harness2 chat 会话恢复与多级 undo（P2-6）', () => {
  it('--session <id> 恢复：banner 标记已恢复，恢复后的投影可 /undo（文件复原联动）', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    // 第一段：跑演示生成会话与演示文件
    const first = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    await first.wait('会话: ');
    const id = /会话: (\S+)（新建）/.exec(first.out())?.[1] ?? '';
    expect(id).not.toBe('');
    first.send('开始演示');
    await first.wait('演示完成');
    expect(await first.exit()).toBe(0);

    // 第二段：--session 恢复同一会话，历史投影可用
    const second = startChat(['--provider', 'mock', '--home', home, '--root', work, '--session', id]);
    try {
      await second.wait(`会话: ${id}（已恢复）`);
      second.send('/undo');
      await second.wait('已撤回 4 条消息');
      expect(existsSync(join(work, 'harness2-demo.txt'))).toBe(false);
    } finally {
      expect(await second.exit()).toBe(0);
    }
  }, 30000);

  it('/resume <id> 恢复：切换后 /sessions 把恢复的会话标记为当前', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      const firstId = /会话: (\S+)（新建）/.exec(chat.out())?.[1] ?? '';
      expect(firstId).not.toBe('');
      chat.send('开始演示');
      await chat.wait('演示完成');
      chat.send('/new');
      await chat.wait(() => [...chat.out().matchAll(/会话: \S+（新建）/g)].length >= 2);

      chat.send(`/resume ${firstId}`);
      await chat.wait(`会话: ${firstId}（已恢复）`);
      chat.send('/sessions');
      await chat.wait(`${firstId}  `); // 列表行格式（id + 两空格），与横幅区分
      expect(chat.out()).toContain(' 条 *'); // 当前会话标记指向恢复的会话
    } finally {
      expect(await chat.exit()).toBe(0);
    }
  }, 30000);

  it('/undo 2（n>1）连续撤回两个 turn；/redo 只重做一层（文件回放）', async () => {
    const home = tmpDir('h2-chat-home-');
    const work = tmpDir('h2-chat-work-');
    const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      chat.send('开始演示');
      await chat.wait('演示完成');
      // 第二个 turn：mock 脚本耗尽 → error turn（user 消息已落盘，可撤）
      chat.send('再来一轮');
      await chat.wait('[error');

      chat.send('/undo 2');
      await chat.wait('已撤回 1 条消息'); // 先撤 error turn（仅 user 消息）
      await chat.wait('已撤回 4 条消息'); // 再撤演示 turn，创建的文件被删除
      const out = chat.out();
      expect(out.indexOf('已撤回 1 条消息')).toBeLessThan(out.indexOf('已撤回 4 条消息'));
      expect(existsSync(join(work, 'harness2-demo.txt'))).toBe(false);

      // /redo 只重做最近一次撤销：演示 turn 复活，文件恢复
      chat.send('/redo');
      await chat.wait('已重做 4 条消息');
      expect(existsSync(join(work, 'harness2-demo.txt'))).toBe(true);
    } finally {
      expect(await chat.exit()).toBe(0);
    }
  }, 30000);
});

// —— 审批交互（真实 provider 配置 + 本地 OpenAI SSE stub） ——

const SSE_HEADERS = { 'Content-Type': 'text/event-stream' };

// OpenAI-compatible SSE 帧（每帧由 stub server 以 "\n\n" 分隔写出）
const TOOL_CALL_FRAMES = (id: string, argsJson: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"read","arguments":"${argsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}}]}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
];

const TEXT_FRAMES = (text: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

describe('harness2 chat 审批交互（config approval ask → REPL 内联确认）', () => {
  let server: Server;
  let baseUrl = '';
  const scripts: string[][] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      void req;
      res.writeHead(200, SSE_HEADERS);
      const frames = scripts.shift() ?? TEXT_FRAMES('脚本耗尽');
      for (const f of frames) res.write(f + '\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('read 配置为 ask：REPL 提示 → a 总是允许（进程内缓存，第二次不再提示）', async () => {
    const home = tmpDir('h2-ask-home-');
    const work = tmpDir('h2-ask-work-');
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(
      join(home, '.harness2', 'config.json'),
      JSON.stringify({
        providers: { stub: { protocol: 'openai', baseUrl } },
        roles: { main: { channel: 'stub', model: 'stub-model' } },
        approval: { tools: { read: 'ask' } },
      }),
      'utf8',
    );
    writeFileSync(join(home, '.harness2', 'auth.json'), JSON.stringify({ channels: { stub: { apiKey: 'ask-test-key-secret' } } }), 'utf8');
    writeFileSync(join(work, 'approved.txt'), 'approved 内容', 'utf8');

    scripts.push(
      TOOL_CALL_FRAMES('call-1', '{"file_path":"approved.txt"}'),
      TEXT_FRAMES('第一次读取完成'),
      TOOL_CALL_FRAMES('call-2', '{"file_path":"approved.txt"}'),
      TEXT_FRAMES('第二次读取完成'),
    );

    const chat = startChat(['--home', home, '--root', work]);
    try {
      await chat.wait('会话: ');
      chat.send('读一下 approved.txt');
      await chat.wait('允许执行 read?'); // 审批内联提示
      chat.send('a'); // 本会话总是允许
      await chat.wait('< ok [call-1]');
      await chat.wait('第一次读取完成');

      chat.send('再读一遍');
      await chat.wait('< ok [call-2]');
      await chat.wait('第二次读取完成');

      const out = chat.out();
      expect(out.match(/允许执行 read\?/g)).toHaveLength(1); // 缓存生效：只提示一次
      expect(out).toContain('[end_turn'); // 两个 turn 正常收尾
      expect(out).not.toContain('ask-test-key-secret'); // 密钥不出现在任何输出
    } finally {
      const code = await chat.exit();
      expect(code).toBe(0);
    }
  }, 30000);
});
