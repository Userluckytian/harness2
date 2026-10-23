import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleUncaughtException, handleUnhandledRejection } from '../src/real/host-crash.js';

describe('host-crash (ZS5-T2)', () => {
  it('uncaughtException 注入抛错 -> 临时 home crash/ 出 .log，内容含 version 行与栈', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zs5-crash-'));
    const err = new Error('zs5-unit-boom');
    err.stack = 'Error: zs5-unit-boom\n    at foo (bar.js:1:2)';

    const reportPath = handleUncaughtException(err, { home });

    expect(reportPath).toBeTruthy();
    const crashDir = path.join(home, '.harness2', 'crash');
    expect(fs.existsSync(crashDir)).toBe(true);
    const files = fs.readdirSync(crashDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(reportPath as string, 'utf8');
    expect(content).toMatch(/^version:/m);
    expect(content).toContain('zs5-unit-boom');
    expect(content).toContain('stack:');
    expect(content).toContain('bar.js:1:2');
  });

  it('SECRET 样例在 error message 里 -> 报告文件不含明文', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zs5-crash-'));
    // P2#8（ZS6 尾巴登记）：夹具保留 sk- 前缀是刻意——core redactSecrets SK_KEY_PATTERN
    // 只识别该形态，改前缀=测不到 redact 本体。若未来引入 secret 扫描 CI 门，此值应进
    // allowlist（它不是凭据，只是被 redact 的输入样例）。
    const secret = 'sk-supersecret-ABCDEFGHIJKLMNOP';
    const err = new Error(`boom token=${secret}`);

    const reportPath = handleUncaughtException(err, { home });
    expect(reportPath).toBeTruthy();
    const content = fs.readFileSync(reportPath as string, 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('[REDACTED]');
  });

  it('writeCrashReport 本身失败（mock writer 抛）-> 钩子不炸宿主', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zs5-crash-'));
    const writer = vi.fn(() => {
      throw new Error('disk full');
    });

    expect(() => handleUncaughtException(new Error('x'), { home, writeCrashReport: writer })).not.toThrow();
    expect(() => handleUnhandledRejection(new Error('y'), { home, writeCrashReport: writer })).not.toThrow();
  });

  it('重复崩溃多次 -> 多文件不互相覆盖（文件名时间戳规则）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zs5-crash-'));
    for (let i = 0; i < 3; i++) {
      handleUncaughtException(new Error(`boom-${i}`), {
        home,
        now: () => new Date(2026, 9, 22, 0, 0, i),
      });
    }
    const crashDir = path.join(home, '.harness2', 'crash');
    const files = fs.readdirSync(crashDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(3);
  });

  it('unhandledRejection 路径也写出报告', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zs5-crash-'));
    const reportPath = handleUnhandledRejection(new Error('zs5-reject-probe'), { home });
    expect(reportPath).toBeTruthy();
    const content = fs.readFileSync(reportPath as string, 'utf8');
    expect(content).toContain('zs5-reject-probe');
  });
});
