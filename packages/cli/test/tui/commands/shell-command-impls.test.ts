// P3-A shell-command-impls 单测：catalog P3-A 批次 shellOnly 新命令的壳层 thin 实现。
// 每条新命令至少一个执行用例（真实 tmp 夹具 + core 真实 API）：
//   session-info / export / timeline（真实会话日志）、doctor、memory、skills、
//   plugins、mcps（tmp home/root 配置），外加未接管 id 回落 false 与无活动会话降级。
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@harness2/core';
import { runPaletteShellCommand, type ShellCommandIo } from '../../../src/tui/commands/shell-command-impls.js';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 录制式 ShellCommandIo：print 收行；会话目录/根可注入 */
function makeIo(overrides: Partial<ShellCommandIo> = {}): { io: ShellCommandIo; lines: string[] } {
  const lines: string[] = [];
  const io: ShellCommandIo = {
    print: (t) => lines.push(t),
    currentSessionDir: () => null,
    root: tmpDir('h2-palette-root-'),
    home: tmpDir('h2-palette-home-'),
    ...overrides,
  };
  return { io, lines };
}

/** 真实会话夹具：header u1 a1 u2 a2（writer 关闭落盘），返回目录 */
function seedSession(cwd: string): string {
  const manager = new SessionManager(tmpDir('h2-palette-sess-'));
  const { dir, writer } = manager.create(cwd);
  writer.append('user/message', { text: 'u1', turnId: 't1' });
  writer.append('assistant/message', { text: 'a1', turnId: 't1' });
  writer.append('user/message', { text: 'u2', turnId: 't2' });
  writer.append('assistant/message', { text: 'a2', turnId: 't2' });
  writer.close();
  return dir;
}

describe('runPaletteShellCommand 路由', () => {
  it('本表 8 条 id 全部接管（同步 6 条 true；doctor/memory 异步 resolves true）；未知/core 命令返回 false', async () => {
    const { io } = makeIo();
    for (const id of ['session-info', 'export', 'timeline', 'skills', 'plugins', 'mcps']) {
      expect(runPaletteShellCommand(id, io, '')).toBe(true);
    }
    await expect(runPaletteShellCommand('doctor', io, '')).resolves.toBe(true);
    await expect(runPaletteShellCommand('memory', io, '')).resolves.toBe(true);
    expect(runPaletteShellCommand('nope', io, '')).toBe(false);
    expect(runPaletteShellCommand('new', io, '')).toBe(false); // core 有 run 的命令不经本表
  });
});

describe('/session-info（G-59）', () => {
  it('真实会话：输出 id/事件与消息统计（遮蔽计数）', () => {
    const cwd = tmpDir('h2-palette-cwd-');
    const dir = seedSession(cwd);
    const { io, lines } = makeIo({ currentSessionDir: () => dir });
    void runPaletteShellCommand('session-info', io, '');
    expect(lines[0]).toMatch(/^会话 ID: /);
    const cwdLine = lines.find((l) => l.startsWith('工作目录: '));
    expect(cwdLine).toBeDefined();
    expect(cwdLine).toContain(cwd.split(/[\\/]/).pop()!);
    expect(lines.some((l) => l === '事件: 5 条（活动 5，遮蔽 0）')).toBe(true);
    expect(lines).toContain('消息: 4 条');
  });

  it('无活动会话 → error 行（不静默）', () => {
    const { io, lines } = makeIo();
    void runPaletteShellCommand('session-info', io, '');
    expect(lines).toEqual(['error: 无活动会话']);
  });
});

describe('/export（G-63）', () => {
  it('真实会话：rest 作输出路径 → ZIP 落盘 tmp + 逐字摘要行', () => {
    const dir = seedSession(tmpDir('h2-palette-cwd-'));
    const outZip = join(tmpDir('h2-palette-out-'), 'exported.zip');
    const { io, lines } = makeIo({ currentSessionDir: () => dir });
    void runPaletteShellCommand('export', io, outZip);
    expect(lines[0]).toMatch(/^已导出 .+ → .+（\d+ 个文件）$/);
    const outFile = lines[0]!.split(' → ')[1]!.split('（')[0]!;
    expect(outFile).toBe(outZip);
    expect(existsSync(outFile)).toBe(true);
  });

  it('无活动会话 → error 行', () => {
    const { io, lines } = makeIo();
    void runPaletteShellCommand('export', io, '');
    expect(lines).toEqual(['error: 无活动会话']);
  });
});

describe('/timeline（G-03，仅 fullscreen；门控归壳层，此处验证只读输出）', () => {
  it('真实会话：输出轨迹时间线（含用户/助手正文）', () => {
    const dir = seedSession(tmpDir('h2-palette-cwd-'));
    const { io, lines } = makeIo({ currentSessionDir: () => dir });
    void runPaletteShellCommand('timeline', io, '');
    const all = lines.join('\n');
    expect(all).toContain('u1');
    expect(all).toContain('a2');
  });

  it('无活动会话 → error 行', () => {
    const { io, lines } = makeIo();
    void runPaletteShellCommand('timeline', io, '');
    expect(lines).toEqual(['error: 无活动会话']);
  });
});

describe('/doctor（G-85）', () => {
  it('tmp home/root：输出分节报告（首行 harness2 doctor、逐条 [OK]/[WARN]/[FAIL] 标记）', async () => {
    const { io, lines } = makeIo();
    await expect(runPaletteShellCommand('doctor', io, '')).resolves.toBe(true);
    expect(lines[0]).toMatch(/^harness2 doctor（/);
    const checkLines = lines.filter((l) => /^\[(OK|WARN|FAIL)\]/.test(l));
    expect(checkLines.length).toBeGreaterThan(0);
    expect(checkLines.some((l) => l.includes('node'))).toBe(true);
  });
});

describe('/memory（G-77）', () => {
  it('tmp home：空记忆 0 条 + 写入 MEMORY.md 后列出条目', async () => {
    const { io, lines } = makeIo();
    await runPaletteShellCommand('memory', io, '');
    expect(lines.filter((l) => l.includes('（0 条，')).length).toBe(2); // memory + user 均空

    const memoriesDir = join(io.home!, '.harness2', 'memories');
    mkdirSync(memoriesDir, { recursive: true });
    writeFileSync(join(memoriesDir, 'MEMORY.md'), '第一条记忆\n§\n第二条记忆', 'utf8');
    const lines2: string[] = [];
    await runPaletteShellCommand('memory', { ...io, print: (t) => lines2.push(t) }, '');
    expect(lines2.some((l) => l.includes('MEMORY.md（2 条，'))).toBe(true);
    expect(lines2).toContain('  [1] 第一条记忆');
    expect(lines2).toContain('  [2] 第二条记忆');
  });
});

describe('/skills（G-78）', () => {
  it('tmp root：放入带 frontmatter 的 .md 后列出（项目级标注；全局兜底目录挂真实主目录，不做空库假设）', () => {
    const { io } = makeIo();
    const skillsDir = join(io.root, '.harness2', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'demo-skill.md'), '---\nname: demo-skill\ndescription: 演示技能\n---\n正文', 'utf8');
    const lines: string[] = [];
    void runPaletteShellCommand('skills', { ...io, print: (t) => lines.push(t) }, '');
    expect(lines).toContain('demo-skill  [project]  演示技能');
  });
});

describe('/plugins（G-78）', () => {
  it('tmp home：无插件提示 + manifest 目录列出与审批状态', () => {
    const { io, lines } = makeIo();
    void runPaletteShellCommand('plugins', io, '');
    expect(lines).toEqual(['（无插件）']);

    const pluginDir = join(io.home!, '.harness2', 'plugins', 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');
    const lines2: string[] = [];
    void runPaletteShellCommand('plugins', { ...io, print: (t) => lines2.push(t) }, '');
    expect(lines2[0]).toContain('注意：v1 插件与主进程同进程运行');
    expect(lines2[1]).toContain('demo  v0.1.0  未批准（plugin enable 启用）');
  });
});

describe('/mcps（G-88）', () => {
  it('tmp home：无配置文件 → 逐字 error（与 cli mcp list 同文案）；config.mcpServers → stdio/url 两形态列出（不探测）', () => {
    const { io, lines } = makeIo();
    void runPaletteShellCommand('mcps', io, '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: 未找到任何配置文件（全局 .+ 与项目 .+ 均不存在）$/);

    mkdirSync(join(io.home!, '.harness2'), { recursive: true });
    writeFileSync(
      join(io.home!, '.harness2', 'config.json'),
      JSON.stringify({
        providers: {
          deepseek: {
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            envKey: 'DEEPSEEK_API_KEY',
            models: { 'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 } },
          },
        },
        roles: { main: { channel: 'deepseek', model: 'deepseek-chat' } },
        mcpServers: {
          fs: { command: 'node', args: ['fs.js'] },
          web: { url: 'http://127.0.0.1:9/mcp' },
        },
      }),
      'utf8',
    );
    const lines2: string[] = [];
    void runPaletteShellCommand('mcps', { ...io, print: (t) => lines2.push(t) }, '');
    expect(lines2).toEqual(['fs  [stdio] node fs.js', 'web  [url] http://127.0.0.1:9/mcp']);
  });
});
