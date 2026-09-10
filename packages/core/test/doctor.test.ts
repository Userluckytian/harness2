// doctor 自检测试（阶段 11 Task 4）：node 版本 / config+auth（脱敏）/ 目录可写 /
// MCP（--probe 由 CLI 集成覆盖，此处仅未配置与列出口径）/ 会话库完整性 / skills 扫描 /
// 崩溃报告落盘与脱敏（crash.ts）。全部注入临时 home，零真实用户数据。
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, renderDoctorReport } from '../src/doctor/index.js';
import {
  crashReportDir,
  crashReportFileName,
  formatCrashReport,
  noteCrashSessionId,
  writeCrashReport,
} from '../src/doctor/crash.js';
import { CORE_VERSION } from '../src/version.js';
import { SessionWriter } from '../src/session/writer.js';

const dirs: string[] = [];
function tmpHome(prefix = 'h2-doctor-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  noteCrashSessionId(undefined); // 清崩溃上下文，避免跨用例泄漏
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 最小合法 config（与 core config.test 同款基线） */
const BASE_CONFIG = JSON.stringify({
  providers: {
    deepseek: {
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      envKey: 'DEEPSEEK_API_KEY',
      models: { 'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 } },
    },
  },
  roles: {
    main: { channel: 'deepseek', model: 'deepseek-chat' },
    small: { channel: 'deepseek', model: 'deepseek-chat' },
    subagent: { channel: 'deepseek', model: 'deepseek-chat' },
  },
  approval: { mode: 'default' },
});

function writeGlobalConfig(home: string, content: string): void {
  const dir = join(home, '.harness2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), content, 'utf8');
}

describe('runDoctor 分节检查', () => {
  it('全新环境（空 home）：config WARN 其余 OK，exit 0（WARN 不影响退出码）', async () => {
    const home = tmpHome();
    const r = await runDoctor({ home });
    const byId = new Map(r.checks.map((c) => [c.id, c]));
    expect(byId.get('node')!.status).toBe('ok');
    expect(byId.get('config')!.status).toBe('warn'); // 未配置 = 全新环境提示
    expect(byId.get('config')!.summary).toContain('未找到配置文件');
    expect(byId.get('home')!.status).toBe('ok');
    // A1-1：doctor 报告 bash 工具实际使用的 shell（探测结果，不是配置里写的值）。
    // 不依赖本机是否装了 Git Bash：命中与否由 shell.ts 的注入用例保证，这里只锁「实际使用」这条契约；
    // 状态放宽为 ok | warn（装了 Git Bash → ok，没装 → warn 回退 cmd），exit code 仍必须为 0。
    expect(['ok', 'warn']).toContain(byId.get('bash')!.status);
    expect(byId.get('bash')!.summary).toContain('实际使用');
    expect(byId.get('mcp')!.status).toBe('ok');
    expect(byId.get('sessions')!.status).toBe('ok');
    expect(byId.get('skills')!.status).toBe('ok');
    expect(r.exitCode).toBe(0);
  });

  it('config 正常：key 来源标签脱敏展示（env:XXX / **missing**），无明文 key', async () => {
    const home = tmpHome();
    writeGlobalConfig(home, BASE_CONFIG);
    const prev = process.env['DEEPSEEK_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'sk-test-doctor-123456';
    try {
      const r = await runDoctor({ home });
      const config = r.checks.find((c) => c.id === 'config')!;
      expect(config.status).toBe('ok');
      const joined = [config.summary, ...(config.details ?? [])].join('\n');
      expect(joined).toContain('env:DEEPSEEK_API_KEY');
      expect(joined).not.toContain('sk-test-doctor-123456'); // 明文永不出现
    } finally {
      if (prev === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = prev;
    }
  });

  it('config 解析失败 → FAIL，exit 1（明细过 redactSecrets）；mcp 检查显示「未知」而非「未配置」', async () => {
    const home = tmpHome();
    writeGlobalConfig(home, '{ invalid json !!!');
    const r = await runDoctor({ home });
    const config = r.checks.find((c) => c.id === 'config')!;
    expect(config.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    // 审查 P2-6：配置文件存在但解析失败 → mcp「未知」（未知 ≠ 未配置）
    const mcp = r.checks.find((c) => c.id === 'mcp')!;
    expect(mcp.status).toBe('warn');
    expect(mcp.summary).toContain('未知（config 解析失败');
    // 对照：全新环境（无配置文件）mcp 照常显示「未配置」
    const fresh = await runDoctor({ home: tmpHome() });
    expect(fresh.checks.find((c) => c.id === 'mcp')!.summary).toContain('未配置 MCP 服务器');
  });

  it('会话库坏行 → sessions WARN，明细含坏行位置；干净库 OK', async () => {
    const home = tmpHome();
    // 干净库（空）
    const clean = await runDoctor({ home });
    expect(clean.checks.find((c) => c.id === 'sessions')!.status).toBe('ok');
    // 一个会话 + 手工追加坏行（模拟崩溃撕裂残留被 reader 告警的形态）
    const group = join(home, '.harness2', 'sessions', 'D--work');
    const dir = join(group, '20260907-000000-000001');
    mkdirSync(dir, { recursive: true });
    const w = SessionWriter.create(dir, { sessionId: '20260907-000000-000001' }, { fsync: false });
    w.append('user/message', { text: 'hello' });
    w.close();
    appendFileSync(join(dir, 'session.v1.jsonl'), 'this is not json\n', 'utf8');
    const r = await runDoctor({ home });
    const sessions = r.checks.find((c) => c.id === 'sessions')!;
    expect(sessions.status).toBe('warn');
    expect(sessions.summary).toContain('1 个含坏行');
    expect(sessions.details?.some((d) => d.includes('skipped invalid line'))).toBe(true);
  });

  it('skills 坏文件 → skills WARN（计数 + 告警明细）', async () => {
    const home = tmpHome();
    // 全局 skills 目录 = <home>/.harness2/skills（与 defaultSkillsRoot 同源）
    const skillsDir = join(home, '.harness2', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'bad.md'), '没有 frontmatter 的普通 markdown', 'utf8');
    const r = await runDoctor({ home });
    const skills = r.checks.find((c) => c.id === 'skills')!;
    expect(skills.status).toBe('warn');
    expect(skills.summary).toContain('1 条告警');
  });

  it('renderDoctorReport：分节标记与结果行齐全', async () => {
    const home = tmpHome();
    writeGlobalConfig(home, '{ broken');
    const r = await runDoctor({ home });
    const lines = renderDoctorReport(r);
    const joined = lines.join('\n');
    expect(joined).toContain('[FAIL] config');
    expect(joined).toContain('[OK]  node');
    expect(joined).toContain('1 FAIL');
    expect(joined).toContain(CORE_VERSION);
  });
});

describe('崩溃报告（doctor/crash.ts，无遥测）', () => {
  it('writeCrashReport：落盘 + 脱敏（sk- 密钥与 key= 字段）+ 内容含版本/平台/会话 id', () => {
    const home = tmpHome();
    noteCrashSessionId('20260907-000000-000042');
    try {
      const err = new Error('request failed: sk-abcdef123456 key=supersecret123 token=ghp_abcdef123456');
      const path = writeCrashReport(err, { home });
      expect(path).not.toBeNull();
      expect(existsSync(path!)).toBe(true);
      const content = readText(path!);
      expect(content).toContain(`version: ${CORE_VERSION}`);
      // 平台/架构动态取，勿写死 win32（crash.ts 写的是 `${platform} ${arch}`，非 windows 会红）
      expect(content).toContain(`platform: ${process.platform} ${process.arch}`);
      expect(content).toContain('session: 20260907-000000-000042');
      expect(content).toContain('request failed');
      expect(content).not.toContain('sk-abcdef123456');
      expect(content).not.toContain('supersecret123');
      expect(content).toContain('[REDACTED]');
      // 文件名合法（Windows 无冒号；毫秒位的点合法保留）
      expect(path!.split(/[\\/]/).at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.log$/);
    } finally {
      noteCrashSessionId(undefined);
    }
  });

  it('未登记会话 id：session 字段为 "-"；非 Error 值亦可报告；目录不存在时自动创建', () => {
    const home = tmpHome();
    const path = writeCrashReport('boom-string-error', { home });
    expect(path).not.toBeNull();
    const content = readText(path!);
    expect(content).toContain('session: -');
    expect(content).toContain('boom-string-error');
    expect(existsSync(crashReportDir(home))).toBe(true);
  });

  it('crashReportFileName：ISO 冒号全部替换为 -（Windows 文件名合法）', () => {
    const name = crashReportFileName(new Date('2026-09-07T01:23:45.678Z'));
    expect(name).toBe('2026-09-07T01-23-45.678Z.log');
    expect(name).not.toContain(':');
    // formatCrashReport 纯函数：含栈与脱敏，不触盘
    const text = formatCrashReport(new Error('x key=abc123def'), { now: new Date('2026-09-07T00:00:00Z') });
    expect(text).toContain('2026-09-07T00:00:00.000Z');
    expect(text).not.toContain('abc123def');
  });
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
