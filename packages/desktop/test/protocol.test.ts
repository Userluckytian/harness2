// preload 内联 IPC 常量与 shared/protocol.ts 的一致性校验。
// 背景：sandbox preload 不允许 require 相对模块，通道名在 preload.ts 内联——
// 本测试静态比对两处源码，防止改名漂移。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { IPC_EVENT, IPC_INVOKE, IPC_SETTINGS_EVENT, IPC_STATUS, IPC_STOP_ALL } from '../src/shared/protocol.js';

function extractConstant(source: string, name: string): string | null {
  const m = new RegExp(`const ${name} = '([^']+)'`).exec(source);
  return m?.[1] ?? null;
}

/** P6-B 新增命令：三处必须同名（protocol 类型 / preload 内联 / bridge 分发） */
const MODELS_COMMANDS = [
  'settings:getModels',
  'settings:updateModels',
  'settings:deleteProvider',
  'settings:writeChannelKey',
  'settings:getCredentialStatus',
  'settings:ackModelsDeclaration',
  'settings:discoverModels',
] as const;

describe('preload IPC 常量一致性', () => {
  const preloadSource = readFileSync(join(__dirname, '..', 'src', 'preload', 'preload.ts'), 'utf8');
  const bridgeSource = readFileSync(join(__dirname, '..', 'src', 'main', 'bridge.ts'), 'utf8');
  const protocolSource = readFileSync(join(__dirname, '..', 'src', 'shared', 'protocol.ts'), 'utf8');

  it('preload 内联通道名与 shared/protocol.ts 完全一致', () => {
    expect(extractConstant(preloadSource, 'IPC_INVOKE')).toBe(IPC_INVOKE);
    expect(extractConstant(preloadSource, 'IPC_EVENT')).toBe(IPC_EVENT);
    expect(extractConstant(preloadSource, 'IPC_STATUS')).toBe(IPC_STATUS);
    expect(extractConstant(preloadSource, 'IPC_STOP_ALL')).toBe(IPC_STOP_ALL);
    // P6-B（D-58）：设置域事件通道
    expect(extractConstant(preloadSource, 'IPC_SETTINGS_EVENT')).toBe(IPC_SETTINGS_EVENT);
    expect(IPC_SETTINGS_EVENT).toBe('harness2:settings-event');
  });

  it('P6-B 模型配置命令在 protocol / preload / bridge 三处同名', () => {
    for (const cmd of MODELS_COMMANDS) {
      expect(protocolSource, `protocol 缺少 ${cmd}`).toContain(`'${cmd}'`);
      expect(preloadSource, `preload 缺少 ${cmd}`).toContain(`'${cmd}'`);
      expect(bridgeSource, `bridge 未分发 ${cmd}`).toContain(`case '${cmd}'`);
    }
  });

  it('preload 源码不允许 require 相对模块 / Node 内建（sandbox 红线）', () => {
    const requires = [...preloadSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2] ?? '');
    for (const spec of requires) {
      expect(spec.startsWith('.')).toBe(false); // 相对模块在 sandbox preload 不可用
      expect(['electron', 'events', 'timers', 'url']).toContain(spec);
    }
  });
});
