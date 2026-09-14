// G-45 stdin JSON 契约单测（build → serialize → parse 全链路快照；不造假数据红线）+
// G-49 子进程环境（行尺寸 COLUMNS/LINES、GIT_OPTIONAL_LOCKS=0、BASH_ENV/ENV 清空）。
import { describe, expect, it } from 'vitest';
import {
  STATUS_LINE_SCHEMA_VERSION,
  buildStatusLinePayload,
  parseStatusLinePayload,
  serializeStatusLinePayload,
  statusLineChildEnv,
  type StatusLineDataSource,
} from '../../../src/tui/status-line/contract.js';

/** 数据源：G-45 最小集全量（真实形状；装配层从会话状态喂入同形状数据） */
function fullSource(): StatusLineDataSource {
  return {
    cwd: '/repo/sub',
    sessionId: 'sess-20260913-1',
    sessionName: 'P3-C 队列',
    promptId: 'turn-uuid-777',
    transcriptPath: '/home/me/.harness2/sessions/sess-20260913-1/updates.jsonl',
    modelId: 'glm-5.3-flash',
    modelDisplayName: 'GLM 5.3 Flash',
    repoRoot: '/repo',
    branch: 'feat/phase-p3-cli-surface',
    version: '1.0.0',
    costUsd: 0.0234,
    totalDurationMs: 654_321,
    totalApiDurationMs: 12_345,
    contextTokens: 12_000,
    contextWindowSize: 200_000,
    autoCompactThresholdPercent: 85,
    sessionInputTokens: 45_000,
    sessionOutputTokens: 3_200,
    sessionUsage: {
      inputTokens: 40_000,
      outputTokens: 3_200,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 3_000,
    },
    effortLevel: 'high',
    turnStartedAtMs: 1_700_000_000_000,
  };
}

describe('G-45 payload 构造（不造假：不可 sourced 的字段省略而非占位）', () => {
  it('全量数据源 → 最小集字段齐备（workspace.repo_root / context_tokens / session_usage / transcript_path / prompt_id / trigger）', () => {
    const p = buildStatusLinePayload(fullSource(), 'state');
    expect(p.workspace.repo_root).toBe('/repo');
    expect(p.context_window.context_tokens).toBe(12_000);
    expect(p.context_window.session_usage).toEqual({
      input_tokens: 40_000,
      output_tokens: 3_200,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 3_000,
    });
    expect(p.transcript_path).toContain('updates.jsonl');
    expect(p.prompt_id).toBe('turn-uuid-777');
    expect(p.trigger).toBe('state');
    expect(p.schema_version).toBe(STATUS_LINE_SCHEMA_VERSION);
  });

  it('百分比派生：used/remaining 为 0..100 整数且互补（12000/200000 → 6% / 94%）', () => {
    const p = buildStatusLinePayload(fullSource(), 'state');
    expect(p.context_window.used_percentage).toBe(6);
    expect(p.context_window.remaining_percentage).toBe(94);
  });

  it('缺数据字段被省略（绝不填 0/null）：仓库外、无模型名、无费用、窗口未知、回合间', () => {
    const p = buildStatusLinePayload(
      {
        cwd: '/tmp/plain',
        sessionId: 's1',
        transcriptPath: '/t/updates.jsonl',
        // 无 repoRoot / branch / model / cost / contextTokens / windowSize / usage / promptId / turn
      },
      'refresh_interval',
    );
    expect(p.workspace.repo_root).toBeUndefined();
    expect(p.workspace.branch).toBeUndefined();
    expect(p.model).toBeUndefined();
    expect(p.cost).toBeUndefined();
    expect(p.prompt_id).toBeUndefined();
    expect(p.turn).toBeUndefined();
    expect(p.context_window.context_tokens).toBeUndefined();
    expect(p.context_window.used_percentage).toBeUndefined(); // 未知窗口的百分比不是数字
    expect(p.context_window.session_usage).toBeUndefined();
    expect(p.trigger).toBe('refresh_interval'); // G-45：trigger 两值
  });

  it('prompt_id 仅回合中提供（构造即由数据源控制；builder 原样透传/省略）', () => {
    const idle = buildStatusLinePayload({ ...fullSource(), promptId: undefined }, 'state');
    expect(idle.prompt_id).toBeUndefined();
    expect(idle.turn).toBeDefined(); // turn 数据独立于 prompt_id
  });
});

describe('G-45 serialize / parse（stdin JSON + 尾随换行契约；快照钉死形状）', () => {
  it('serialize 尾随一个换行（read -r line 与 input=$(cat) 均可用的上游契约）', () => {
    const text = serializeStatusLinePayload(buildStatusLinePayload(fullSource(), 'state'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('契约快照：全量 payload 的键形钉死（加字段不 bump schema_version 的口径由测试看守）', () => {
    const p = buildStatusLinePayload(fullSource(), 'refresh_interval');
    expect(Object.keys(p).sort()).toEqual([
      'context_window',
      'cost',
      'cwd',
      'effort',
      'model',
      'prompt_id',
      'schema_version',
      'session_id',
      'session_name',
      'transcript_path',
      'trigger',
      'turn',
      'version',
      'workspace',
    ]);
    expect(p.trigger).toBe('refresh_interval');
    expect(p.context_window.used_percentage).toBe(6);
  });

  it('parse 往返：serialize → parse 等价还原（形状校验不补造缺省）', () => {
    const text = serializeStatusLinePayload(buildStatusLinePayload(fullSource(), 'state'));
    const r = parseStatusLinePayload(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual(buildStatusLinePayload(fullSource(), 'state'));
  });

  it('parse 拒绝：非 JSON / 缺必填 / schema_version 非法 / trigger 非法 / 结构破坏', () => {
    expect(parseStatusLinePayload('not json').ok).toBe(false);
    expect(parseStatusLinePayload('{}').ok).toBe(false);
    expect(
      parseStatusLinePayload(
        JSON.stringify({
          cwd: 'x',
          session_id: 's',
          transcript_path: 't',
          workspace: { current_dir: 'x' },
          schema_version: 0,
          trigger: 'state',
          context_window: {},
        }),
      ).ok,
    ).toBe(false);
    const badTrigger = parseStatusLinePayload(
      JSON.stringify({
        cwd: 'x',
        session_id: 's',
        transcript_path: 't',
        workspace: { current_dir: 'x' },
        schema_version: 1,
        trigger: 'cron',
        context_window: {},
      }),
    );
    if (badTrigger.ok) throw new Error('trigger=cron 应被拒绝');
    expect(badTrigger.error).toContain('state | refresh_interval');
    expect(
      parseStatusLinePayload(
        JSON.stringify({
          cwd: 'x',
          session_id: 's',
          transcript_path: 't',
          workspace: 'not-object',
          schema_version: 1,
          trigger: 'state',
          context_window: {},
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseStatusLinePayload(
        JSON.stringify({
          cwd: 'x',
          session_id: 's',
          transcript_path: 't',
          workspace: { current_dir: 'x' },
          schema_version: 1,
          trigger: 'state',
          context_window: { session_usage: { input_tokens: 'x' } },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('G-49 子进程环境（行尺寸 + 锁与 rc 清理；纯函数不改 base）', () => {
  it('COLUMNS/LINES = 状态行自身尺寸（非窗口）；GIT_OPTIONAL_LOCKS=0', () => {
    const env = statusLineChildEnv({ PATH: '/usr/bin' }, { cols: 87, rows: 1 });
    expect(env['COLUMNS']).toBe('87');
    expect(env['LINES']).toBe('1');
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('BASH_ENV / ENV 清空（不跑 shell rc）；其余变量原样继承', () => {
    const env = statusLineChildEnv(
      { BASH_ENV: '~/.bashrc', ENV: '~/.profile', EDITOR: 'vi', COLUMNS: '200' },
      { cols: 40, rows: 1 },
    );
    expect(env['BASH_ENV']).toBeUndefined();
    expect(env['ENV']).toBeUndefined();
    expect(env['EDITOR']).toBe('vi');
    expect(env['COLUMNS']).toBe('40'); // 覆盖为行尺寸，不是窗口的 200
  });

  it('纯函数：不改写传入的 base env；尺寸下限钳 1（0/负数不产出非法值）', () => {
    const base: NodeJS.ProcessEnv = { COLUMNS: '999', LINES: '999' };
    statusLineChildEnv(base, { cols: 0, rows: -3 });
    expect(base['COLUMNS']).toBe('999'); // base 未被原地修改
    const env = statusLineChildEnv({}, { cols: 0, rows: -3 });
    expect(env['COLUMNS']).toBe('1');
    expect(env['LINES']).toBe('1');
  });
});
