// PD5（D-P2）：F8 配置写路径加固 —— updateSettingsConfig（全局 config.json 白名单写）：
//   1) JSONC 损坏拒绝：损坏文件不静默覆盖（错误可行动 + 用户原文保留）；
//   2) 非法值拒绝（parseConfig 校验）不落盘；
//   3) 原子写（临时文件 + rename，修复前直写）；
//   4) 写入生效可追溯：写下的模型/审批模式被新 serve 的会话真实装载（「新会话/重启生效」有据）。
// 密钥类字段拒绝由 test/settings.test.ts 覆盖（此处不重复）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServe, type ServeHandle } from '@harness2/core';
import { globalConfigPath, readSettingsConfig, updateSettingsConfig } from '../src/main/config-file.js';

// node:fs 的 ESM namespace 不可 spy：以工厂 mock 只包一层 renameSync（默认透传真实实现）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const renameMock = vi.mocked(renameSync);

const dirs: string[] = [];
const handles: ServeHandle[] = [];
afterEach(async () => {
  renameMock.mockClear();
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cfg-home-'));
  dirs.push(d);
  return d;
}
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cfg-root-'));
  dirs.push(d);
  return d;
}
function writeGlobalConfig(home: string, raw: string): void {
  mkdirSync(join(home, '.harness2'), { recursive: true });
  writeFileSync(globalConfigPath(home), raw, 'utf8');
  // 配置派生装配要求渠道 key 存在性（auth.json 或环境变量）；测试用中性假 key，不进任何输出
  writeFileSync(
    join(home, '.harness2', 'auth.json'),
    JSON.stringify({ channels: { 'local-oai': { apiKey: 'sk-fixture-local-0000' } } }),
    'utf8',
  );
}
const BASE_CONFIG = JSON.stringify({
  providers: {
    'local-oai': {
      protocol: 'openai',
      baseUrl: 'https://api.test/v1',
      envKey: 'LOCAL_UNIFIED_KEY',
      models: { 'big-pickle': { contextWindow: 200000, maxOutputTokens: 8192 } },
    },
  },
  roles: { main: { channel: 'local-oai', model: 'big-pickle' } },
  approval: { mode: 'default' },
  memory: { mode: 'off', nudgeInterval: 10 },
  subagent: { maxDepth: 2, maxTurns: 10 },
});

describe('PD5：updateSettingsConfig 写路径加固', () => {
  it('JSONC 损坏拒绝：不静默覆盖用户损坏文件（错误可行动 + 原文保留）', () => {
    const home = tmpHome();
    const corrupted = '{ "roles": { "main": { '; // 截断的 JSONC
    writeGlobalConfig(home, corrupted);
    const res = updateSettingsConfig(home, home, { approval: { mode: 'plan' } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('无法解析');
    expect(readFileSync(globalConfigPath(home), 'utf8')).toBe(corrupted); // 原文未动（含注释/半截内容不丢）
  });

  it('非法值拒绝（parseConfig 校验）：approval.mode 非法不落盘', () => {
    const home = tmpHome();
    writeGlobalConfig(home, BASE_CONFIG);
    const res = updateSettingsConfig(home, home, { approval: { mode: 'bogus' } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval.mode');
    const onDisk = JSON.parse(readFileSync(globalConfigPath(home), 'utf8')) as { approval: { mode: string } };
    expect(onDisk.approval.mode).toBe('default'); // 未被污染
  });

  it('原子写：临时文件 + rename 覆盖，成功后无 .tmp 残留（修复前直写，本断言必红）', () => {
    const home = tmpHome();
    writeGlobalConfig(home, BASE_CONFIG);
    const path = globalConfigPath(home);
    const res = updateSettingsConfig(home, home, { approval: { mode: 'plan' } });
    expect(res.ok).toBe(true);
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock.mock.calls[0]?.[0]).toBe(`${path}.tmp`); // 临时文件与目标同目录（同卷才原子）
    expect(renameMock.mock.calls[0]?.[1]).toBe(path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { approval: { mode: string } }).approval.mode).toBe('plan');
  });

  it('rename 失败（如文件被占用）回落直写：写入仍成功、无 .tmp 残留', () => {
    const home = tmpHome();
    writeGlobalConfig(home, BASE_CONFIG);
    renameMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    });
    const res = updateSettingsConfig(home, home, { approval: { mode: 'plan' } });
    expect(res.ok).toBe(true);
    expect(existsSync(`${globalConfigPath(home)}.tmp`)).toBe(false);
    expect(
      (JSON.parse(readFileSync(globalConfigPath(home), 'utf8')) as { approval: { mode: string } }).approval.mode,
    ).toBe('plan');
  });
});

describe('PD5：写入生效可追溯（真实 serve 装配新配置）', () => {
  it('写下的模型/审批模式被新 serve 的会话真实装载（「新会话/重启生效」有据）', async () => {
    const home = tmpHome();
    writeGlobalConfig(home, BASE_CONFIG);
    const res = updateSettingsConfig(home, home, {
      approval: { mode: 'plan' },
      roles: { main: { channel: 'local-oai', model: 'new-pickle' } },
      providers: { 'local-oai': { models: { 'new-pickle': { contextWindow: 100000, maxOutputTokens: 4096 } } } },
    });
    expect(res.ok).toBe(true);
    // 读写视图一致：主进程回读即见新值（密钥脱敏，不出现明文）
    const view = readSettingsConfig(home, tmpRoot());
    expect(view.roles['main']?.model).toBe('new-pickle');
    expect(view.approval.mode).toBe('plan');
    expect(JSON.stringify(view)).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);

    // 重启口径：同一 home 上新起的 serve（配置派生装配）把新值装进会话
    const handle = await startServe({ port: 0, home, root: tmpRoot() }); // 无 provider 注入 → 配置派生
    handles.push(handle);
    const created = (await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness2-token': handle.token },
      body: JSON.stringify({ cwd: tmpRoot() }),
    }).then((r) => r.json())) as { id: string };
    const rc = (await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${created.id}/run-config`, {
      headers: { 'x-harness2-token': handle.token },
    }).then((r) => r.json())) as { approval: { mode: string }; provider: { model: string } };
    expect(rc.approval.mode).toBe('plan');
    expect(rc.provider.model).toBe('new-pickle');
  }, 30000);
});
