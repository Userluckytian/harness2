// 阶段 8 端侧命令测试：harness2 plugin list/enable/disable、harness2 mcp list、
// chat REPL 内 subagent 调用端到端（mock，经 --mock-script/--mock-child-script 注入）。
// 依赖根脚本 `pnpm -r build`（dist/index.js）；全部零外部依赖（MCP 用 core 的 stdio fixture）。
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const stdioServerFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'test',
  'fixtures',
  'mcp-stdio-server.mjs',
);

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

interface HomeEnv {
  home: string;
  configPath: string;
  pluginsDir: string;
  sessionsDir: string;
}

function makeHome(config?: Record<string, unknown>): HomeEnv {
  const home = tmpDir('h2-cli8-home-');
  const harnessDir = join(home, '.harness2');
  const pluginsDir = join(harnessDir, 'plugins');
  const sessionsDir = join(harnessDir, 'sessions');
  mkdirSync(pluginsDir, { recursive: true });
  const configPath = join(harnessDir, 'config.json');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { home, configPath, pluginsDir, sessionsDir };
}

function mkdir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写一个最小可用插件（注册 p_hello 工具） */
function writeGreetPlugin(pluginsDir: string, name = 'demo'): void {
  const dir = mkdir(pluginsDir, name);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', permissions: { tools: true, events: ['user/message'] } }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export default { name: '${name}', setup(ctx) { ctx.registerTool({ name: 'p_hello', description: 'demo', parameters: { type: 'object', properties: {} }, execute: () => ({ output: 'hello' }) }); ctx.on('user/message', () => {}); } };`,
    'utf8',
  );
}

const MIN_CONFIG = {
  providers: { ch: { protocol: 'openai', baseUrl: 'https://example.invalid' } },
  roles: { main: { channel: 'ch', model: 'm' } },
};

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [cliEntry, ...args], { encoding: 'utf8' });
}

describe('harness2 plugin 命令', () => {
  it('list：无插件 / manifest 非法 / 权限与审批状态展示', () => {
    const env = makeHome();
    let r = runCli(['plugin', 'list', '--home', env.home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('（无插件）');

    writeGreetPlugin(env.pluginsDir);
    // 写一个 manifest 非法的插件
    const broken = mkdir(env.pluginsDir, 'broken');
    writeFileSync(join(broken, 'manifest.json'), '{ "name": "broken" }', 'utf8'); // 缺 version

    r = runCli(['plugin', 'list', '--home', env.home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('demo');
    expect(r.stdout).toContain('未批准');
    expect(r.stdout).toContain('tools=全部');
    expect(r.stdout).toContain('broken');
    expect(r.stdout).toContain('manifest 非法');
  });

  it('enable --yes：审批后写入 plugins.allow；disable 移除', () => {
    const env = makeHome(MIN_CONFIG);
    writeGreetPlugin(env.pluginsDir);
    const r = runCli(['plugin', 'enable', 'demo', '--yes', '--home', env.home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('权限清单');
    expect(r.stdout).toContain('已批准');
    const afterEnable = JSON.parse(readFileSync(env.configPath, 'utf8')!) as { plugins?: { allow?: string[] } };
    expect(afterEnable.plugins?.allow).toEqual(['demo']);
    // list 显示已批准
    const listed = runCli(['plugin', 'list', '--home', env.home]);
    expect(listed.stdout).toContain('已批准');
    // disable
    const off = runCli(['plugin', 'disable', 'demo', '--home', env.home]);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('已撤销');
    const afterDisable = JSON.parse(readFileSync(env.configPath, 'utf8')!) as { plugins?: { allow?: string[] } };
    expect(afterDisable.plugins?.allow).toEqual([]);
  });

  it('enable 交互确认：默认拒绝（非 y 不写 config）', () => {
    const env = makeHome(MIN_CONFIG);
    writeGreetPlugin(env.pluginsDir);
    const r = spawnSync('node', [cliEntry, 'plugin', 'enable', 'demo', '--home', env.home], {
      encoding: 'utf8',
      input: 'n\n',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已取消');
    expect(existsSync(env.configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(env.configPath, 'utf8')!) as { plugins?: { allow?: string[] } };
    expect(cfg.plugins?.allow ?? []).toEqual([]);
  });

  it('enable 不存在的插件 → exit 1', () => {
    const env = makeHome();
    const r = runCli(['plugin', 'enable', 'ghost', '--yes', '--home', env.home]);
    expect(r.status).toBe(1);
  });
});

describe('harness2 mcp list', () => {
  it('--no-probe：只展示配置', () => {
    const env = makeHome({
      ...MIN_CONFIG,
      mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } },
    });
    const r = runCli(['mcp', 'list', '--no-probe', '--home', env.home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files');
    expect(r.stdout).toContain('[stdio] npx -y @modelcontextprotocol/server-filesystem /tmp');
  });

  it('探测：stdio echo server 连接成功并列出工具数；未配置提示', () => {
    const empty = makeHome(MIN_CONFIG);
    const r0 = runCli(['mcp', 'list', '--home', empty.home]);
    expect(r0.status).toBe(0);
    expect(r0.stdout).toContain('（未配置 MCP 服务器');

    const env = makeHome({
      ...MIN_CONFIG,
      mcpServers: { probe: { command: process.execPath, args: [stdioServerFixture] } },
    });
    const r = runCli(['mcp', 'list', '--home', env.home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已连接');
    expect(r.stdout).toContain('mcp__probe__*');
  });
});

// —— chat REPL 内 subagent 端到端（mock） ——

interface ChatProc {
  out(): string;
  wait(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  send(line: string): void;
  exit(timeoutMs?: number): Promise<number>;
}

function startChat(args: string[]): ChatProc {
  const proc = spawn('node', [cliEntry, 'chat', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  const chat: ChatProc = {
    out: () => stdout,
    async wait(pattern, timeoutMs = 15000) {
      const start = Date.now();
      const test = typeof pattern === 'string' ? () => stdout.includes(pattern) : () => pattern.test(stdout);
      while (!test()) {
        if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${String(pattern)}\n${stdout.slice(-2000)}`);
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
  cleanups.push(() => {
    if (!proc.killed) proc.kill();
  });
  return chat;
}

describe('chat REPL subagent 端到端（mock）', () => {
  it('模型调 subagent_start → 独立子会话跑子任务 → 父会话收尾；子会话落盘血缘正确', { timeout: 60000 }, async () => {
    const root = tmpDir('h2-cli8-root-');
    const home = tmpDir('h2-cli8-home2-');
    // 主脚本：第一轮调 subagent_start，第二轮收尾
    const mockScript = [
      { toolCalls: [{ id: 's1', name: 'subagent_start', arguments: '{"prompt":"child task"}' }] },
      { textChunks: ['父会话收到子任务结果。'] },
    ];
    const childScript = [{ textChunks: ['子会话完成：', 'child result'] }];
    const scriptFile = join(root, 'mock-script.json');
    const childFile = join(root, 'mock-child.json');
    writeFileSync(scriptFile, JSON.stringify(mockScript), 'utf8');
    writeFileSync(childFile, JSON.stringify(childScript), 'utf8');

    const chat = startChat([
      '--provider', 'mock',
      '--root', root,
      '--home', home,
      '--mock-script', scriptFile,
      '--mock-child-script', childFile,
    ]);
    await chat.wait('会话: ');
    chat.send('go'); // 触发 mock 脚本（父 turn 调 subagent_start）
    await chat.wait('父会话收到子任务结果');
    const code = await chat.exit();
    expect(code).toBe(0);
    expect(chat.out()).toContain('subagent_start');
    // 子会话独立落盘：header 带 subagent 血缘
    const sessionsDir = join(home, '.harness2', 'sessions');
    const groups = readdirSync(sessionsDir);
    let childFound = false;
    for (const group of groups) {
      for (const id of readdirSync(join(sessionsDir, group))) {
        const header = JSON.parse(readFileSync(join(sessionsDir, group, id, 'session.v1.jsonl'), 'utf8').split('\n')[0]!);
        if (header.payload?.subagent === true) {
          childFound = true;
          expect(header.payload.isSeeded).toBe(true);
          expect(typeof header.payload.parentSession).toBe('string');
        }
      }
    }
    expect(childFound).toBe(true);
  });
});
