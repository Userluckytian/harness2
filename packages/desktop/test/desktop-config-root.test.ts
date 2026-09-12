// PD6（D-P2）：updateSettingsConfig root 口径一致化。
// 现状缺陷：写入后的回读合并视图用 `process.cwd()` 作项目根（config-file.ts），与
// settings:getConfig 的 deps.root 口径不一致 —— 项目根有 .harness2/config.json 时，
// 返回给渲染端的「合并视图」看不到该项目的覆盖项（跨 root 串口径）。
// 目标：统一以 deps.root 为准；同一 root 读/写视图一致，跨 root 不串。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globalConfigPath, readSettingsConfig, updateSettingsConfig } from '../src/main/config-file.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function tmpHome(): string {
  const d = tmpDir('h2-pd6-home-');
  mkdirSync(join(d, '.harness2'), { recursive: true });
  writeFileSync(
    globalConfigPath(d),
    JSON.stringify({
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
    }),
    'utf8',
  );
  return d;
}
function writeProjectConfig(root: string, mode: string): void {
  mkdirSync(join(root, '.harness2'), { recursive: true });
  writeFileSync(join(root, '.harness2', 'config.json'), JSON.stringify({ approval: { mode } }), 'utf8');
}

describe('PD6：updateSettingsConfig root 口径一致化', () => {
  it('写入后回读合并视图以 deps.root 的项目配置为准（项目覆盖全局）', () => {
    const home = tmpHome();
    const rootA = tmpDir('h2-pd6-rootA-');
    writeProjectConfig(rootA, 'bypass'); // 项目级覆盖
    const res = updateSettingsConfig(home, rootA, { approval: { mode: 'plan' } });
    expect(res.ok).toBe(true);
    // 修复前：回读用 process.cwd() 作项目根 → 看不到 rootA 的项目配置 → 返回 'plan'（假视图）
    expect(res.config?.approval.mode).toBe('bypass');
    // 与 settings:getConfig 同口径：同一 root 的读视图一致
    expect(readSettingsConfig(home, rootA).approval.mode).toBe('bypass');
  });

  it('跨 root 不串：不同项目根各自返回自己的合并视图', () => {
    const home = tmpHome();
    const rootA = tmpDir('h2-pd6-rootA-');
    const rootB = tmpDir('h2-pd6-rootB-');
    writeProjectConfig(rootA, 'bypass');
    // rootB 无项目配置 → 全局写什么生效什么
    const resB = updateSettingsConfig(home, rootB, { approval: { mode: 'acceptEdits' } });
    expect(resB.ok).toBe(true);
    expect(resB.config?.approval.mode).toBe('acceptEdits');
    // rootA 的视图由 rootA 项目配置决定：即便全局随后写入 plan，项目覆盖仍生效（不串）
    const resA = updateSettingsConfig(home, rootA, { approval: { mode: 'plan' } });
    expect(resA.ok).toBe(true);
    expect(resA.config?.approval.mode).toBe('bypass');
    // rootB 无项目配置 → 跟随最新全局值（全局写是共享的，这正是「写全局」的如实语义）
    expect(readSettingsConfig(home, rootB).approval.mode).toBe('plan');
  });
});
