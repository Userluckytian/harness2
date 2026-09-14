// 配置体系测试：两级加载/深合并/${VAR} 展开/schema 校验/脱敏/auth 读写与损坏容错。
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { parseConfig } from '../src/config/schema.js';
import { emptyAuth, readAuthFile, writeAuthFile } from '../src/config/auth.js';
import { redactObject, redactSecrets, redactedSummary } from '../src/config/redact.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-config-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeConfig(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

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
  approval: { mode: 'default', tools: { bash: 'ask' } },
});

describe('loadConfig 两级加载与深合并', () => {
  it('两文件都不存在：config 为 null + 一条缺失错误', () => {
    const dir = tmpDir();
    const r = loadConfig({ globalPath: join(dir, 'no-global.json'), projectPath: join(dir, 'no-project.json') });
    expect(r.config).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('未找到任何配置文件');
    expect(r.sources).toEqual({ global: false, project: false });
  });

  it('仅全局配置：直接通过；sources 标记真实存在性', () => {
    const dir = tmpDir();
    const r = loadConfig({ globalPath: writeConfig(dir, 'g.json', BASE_CONFIG), projectPath: join(dir, 'none.json') });
    expect(r.errors).toEqual([]);
    expect(r.config?.providers['deepseek']?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.sources).toEqual({ global: true, project: false });
  });

  it('项目覆盖全局：标量直接覆盖、对象递归合并（models 增补不丢失全局条目）', () => {
    const dir = tmpDir();
    const globalPath = writeConfig(
      dir,
      'g.json',
      JSON.stringify({
        providers: {
          deepseek: {
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            models: { 'deepseek-chat': { contextWindow: 128000 }, 'deepseek-reasoner': {} },
          },
        },
        roles: { main: { channel: 'deepseek', model: 'deepseek-chat' } },
      }),
    );
    const projectPath = writeConfig(
      dir,
      'p.json',
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: 'https://mirror.local/v1', // 标量覆盖
            models: { 'deepseek-chat': { maxOutputTokens: 4096 } }, // 对象递归：同一 model 补字段
          },
        },
        roles: { small: { channel: 'deepseek', model: 'deepseek-chat' } },
      }),
    );
    const r = loadConfig({ globalPath, projectPath });
    expect(r.errors).toEqual([]);
    const ds = r.config?.providers['deepseek'];
    expect(ds?.baseUrl).toBe('https://mirror.local/v1');
    expect(ds?.protocol).toBe('openai'); // 全局字段保留
    expect(ds?.models?.['deepseek-chat']).toEqual({ contextWindow: 128000, maxOutputTokens: 4096 });
    expect(ds?.models?.['deepseek-reasoner']).toEqual({}); // 全局另一 model 保留
    expect(Object.keys(r.config?.roles ?? {}).sort()).toEqual(['main', 'small']);
  });

  it('数组与 null 以项目为准（整体覆盖不递归）', () => {
    const dir = tmpDir();
    // schema v1 没有数组字段，用 mergedRaw 断言合并语义本身
    const globalPath = writeConfig(dir, 'g.json', JSON.stringify({ providers: { a: { tags: [1, 2] } } }));
    const projectPath = writeConfig(dir, 'p.json', JSON.stringify({ providers: { a: { tags: [3] } } }));
    const r = loadConfig({ globalPath, projectPath });
    expect(r.mergedRaw).toMatchObject({ providers: { a: { tags: [3] } } });
  });
});

describe('loadConfig ${VAR} 展开', () => {
  it('env 存在 → 替换；env 缺失 → 保留原样 + 告警', () => {
    const dir = tmpDir();
    const cfg = JSON.stringify({
      providers: { deepseek: { protocol: 'openai', baseUrl: '${BASE_URL}/v1', envKey: 'DEEPSEEK_API_KEY' } },
      roles: { main: { channel: 'deepseek', model: '${MODEL_NAME}' } },
    });
    const r = loadConfig({
      globalPath: writeConfig(dir, 'g.json', cfg),
      projectPath: join(dir, 'none.json'),
      env: { BASE_URL: 'https://api.test' },
    });
    expect(r.config?.providers['deepseek']?.baseUrl).toBe('https://api.test/v1');
    expect(r.config?.roles['main']?.model).toBe('${MODEL_NAME}'); // 保留原样
    expect(r.warnings.some((w) => w.includes('MODEL_NAME'))).toBe(true);
    expect(r.errors).toEqual([]); // 告警不致命
  });

  it('envKey 字段是变量名引用，不做展开；schema 校验放行未解析的 roles.model? 不——model 未声明时报错', () => {
    const dir = tmpDir();
    const cfg = JSON.stringify({
      providers: { deepseek: { protocol: 'openai', baseUrl: 'https://x', envKey: '${WRONG}' } },
      roles: { main: { channel: 'deepseek', model: 'm' } },
    });
    const r = loadConfig({
      globalPath: writeConfig(dir, 'g.json', cfg),
      projectPath: join(dir, 'none.json'),
      env: {},
    });
    expect(r.config?.providers['deepseek']?.envKey).toBe('${WRONG}'); // 原样保留且无告警
    expect(r.warnings).toEqual([]);
  });

  it('env 值可以展开进 models 声明之外的位置；roles.model 展开后须命中 models 声明', () => {
    const dir = tmpDir();
    const cfg = JSON.stringify({
      providers: {
        deepseek: { protocol: 'openai', baseUrl: 'https://x', models: { 'ds-chat': {} } },
      },
      roles: { main: { channel: 'deepseek', model: '${DS_MODEL}' } },
    });
    const ok = loadConfig({
      globalPath: writeConfig(dir, 'g1.json', cfg),
      projectPath: join(dir, 'none.json'),
      env: { DS_MODEL: 'ds-chat' },
    });
    expect(ok.errors).toEqual([]);
    const bad = loadConfig({
      globalPath: writeConfig(dir, 'g2.json', cfg),
      projectPath: join(dir, 'none.json'),
      env: {},
    });
    expect(bad.config).toBeNull();
    expect(bad.errors.join('\n')).toContain('未在 providers.deepseek.models 中声明');
  });
});

describe('schema 校验', () => {
  it('protocol 枚举拒绝 + 错误消息脱敏（值形似密钥时被 [REDACTED]）', () => {
    const r = parseConfig({
      providers: { x: { protocol: 'sk-proto-abcdefgh', baseUrl: 'https://x' } },
      roles: {},
    });
    expect(r.config).toBeNull();
    expect(r.errors[0]).toContain('[REDACTED]');
    expect(r.errors[0]).not.toContain('sk-proto-abcdefgh');
  });

  it('roles 引用不存在的 channel 报错；引用存在但非法的 channel 不重复报错', () => {
    const r1 = parseConfig({
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'ghost', model: 'm' } },
    });
    expect(r1.errors.join('\n')).toContain('不存在于 providers');

    const r2 = parseConfig({
      providers: { a: { protocol: 'grpc', baseUrl: '' } }, // 自身非法
      roles: { main: { channel: 'a', model: 'm' } },
    });
    expect(r2.errors.filter((e) => e.includes('ghost'))).toHaveLength(0);
    expect(r2.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('未知字段忽略并告警；缺 providers/roles 报致命错误', () => {
    const r = parseConfig({
      providers: { a: { protocol: 'openai', baseUrl: 'https://x', wat: 1 } },
      roles: { main: { channel: 'a', model: 'm' } },
      approval: { mode: 'default', hack: true },
      topLevelExtra: true,
    });
    expect(r.config).not.toBeNull();
    expect(r.warnings.filter((w) => w.includes('未知字段'))).toHaveLength(3);
    expect(r.config?.approval).toEqual({ mode: 'default' });

    const empty = parseConfig({});
    expect(empty.config).toBeNull();
    expect(empty.errors.some((e) => e.includes('providers 缺失'))).toBe(true);
    expect(empty.errors.some((e) => e.includes('roles 缺失'))).toBe(true);
  });

  it('approval 规则与 mode 枚举校验', () => {
    const r = parseConfig({
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
      approval: { mode: 'yolo', tools: { bash: 'maybe' } },
    });
    expect(r.config).toBeNull();
    expect(r.errors.some((e) => e.includes('approval.mode'))).toBe(true);
    expect(r.errors.some((e) => e.includes('approval.tools.bash'))).toBe(true);
  });

  it('memory 段（阶段 6）：缺省 = off/10；三态枚举；nudgeInterval 1..1000；未知字段告警', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    // 缺省 = off（尊重用户默认隐私）
    const dflt = parseConfig(base);
    expect(dflt.config?.memory).toEqual({ mode: 'off', nudgeInterval: 10 });

    // 三态合法值
    for (const mode of ['off', 'ask', 'auto'] as const) {
      const r = parseConfig({ ...base, memory: { mode } });
      expect(r.errors).toEqual([]);
      expect(r.config?.memory.mode).toBe(mode);
    }

    // 非法 mode / 非法 nudgeInterval
    const bad = parseConfig({ ...base, memory: { mode: 'always', nudgeInterval: 0 } });
    expect(bad.config).toBeNull();
    expect(bad.errors.some((e) => e.includes('memory.mode'))).toBe(true);
    expect(bad.errors.some((e) => e.includes('memory.nudgeInterval'))).toBe(true);

    // 合法自定义 + 未知字段告警
    const ok = parseConfig({ ...base, memory: { mode: 'auto', nudgeInterval: 5, hack: true } });
    expect(ok.config?.memory).toEqual({ mode: 'auto', nudgeInterval: 5 });
    expect(ok.warnings.filter((w) => w.includes('memory'))).toHaveLength(1);
  });

  it('models 容量字段必须为正整数；JSONC 注释与尾逗号被容忍', () => {
    const bad = parseConfig({
      providers: { a: { protocol: 'openai', baseUrl: 'https://x', models: { m: { contextWindow: -1 } } } },
      roles: { main: { channel: 'a', model: 'm' } },
    });
    expect(bad.errors.join('\n')).toContain('必须是正整数');

    const dir = tmpDir();
    const r = loadConfig({
      globalPath: writeConfig(
        dir,
        'g.jsonc',
        // JSONC：允许注释与尾逗号（键名仍需引号）
        `{\n  // 全局配置（允许注释）\n  "providers": { "a": { "protocol": "openai", "baseUrl": "https://x", } },\n  "roles": { "main": { "channel": "a", "model": "m" } },\n}`,
      ),
      projectPath: join(dir, 'none.json'),
    });
    expect(r.errors).toEqual([]);
    expect(r.config?.providers['a']?.baseUrl).toBe('https://x');
  });

  it('subagent：maxDepth 1..10、maxTurns 1..200 分开校验（P1-2：契约示例 {maxDepth:1, maxTurns:25} 可解析）', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    // 计划契约示例即 25——旧上限 10 会令照抄契约的合法配置报错
    const contract = parseConfig({ ...base, subagent: { maxDepth: 1, maxTurns: 25 } });
    expect(contract.errors).toEqual([]);
    expect(contract.config?.subagent).toEqual({ maxDepth: 1, maxTurns: 25 });
    // 边界：maxTurns 200 合法、201 拒绝；maxDepth 10 合法、11 拒绝
    const edge = parseConfig({ ...base, subagent: { maxDepth: 10, maxTurns: 200 } });
    expect(edge.errors).toEqual([]);
    expect(edge.config?.subagent).toEqual({ maxDepth: 10, maxTurns: 200 });
    const badTurns = parseConfig({ ...base, subagent: { maxTurns: 201 } });
    expect(badTurns.config).toBeNull();
    expect(badTurns.errors.join('\n')).toContain('subagent.maxTurns 必须是 1..200 的整数');
    const badDepth = parseConfig({ ...base, subagent: { maxDepth: 11 } });
    expect(badDepth.config).toBeNull();
    expect(badDepth.errors.join('\n')).toContain('subagent.maxDepth 必须是 1..10 的整数');
    // 缺省值不受影响
    const def = parseConfig(base);
    expect(def.config?.subagent).toEqual({ maxDepth: 1, maxTurns: 25 });
  });

  it('ui 段（P2-C 加性）：screen_mode 两值；未配置不透出；未知子键告警；非法值致命', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    // 未配置：段不出现在结果里（加性可选段）
    const none = parseConfig(base);
    expect(none.config).not.toBeNull();
    expect(none.config?.ui).toBeUndefined();
    expect(none.warnings.filter((w) => w.includes('ui'))).toHaveLength(0);
    // 合法值透出
    const minimal = parseConfig({ ...base, ui: { screen_mode: 'minimal' } });
    expect(minimal.config?.ui).toEqual({ screen_mode: 'minimal' });
    const fullscreen = parseConfig({ ...base, ui: { screen_mode: 'fullscreen' } });
    expect(fullscreen.config?.ui).toEqual({ screen_mode: 'fullscreen' });
    // 空对象段 = 已配置但无字段（缺省语义由壳层裁定）
    const empty = parseConfig({ ...base, ui: {} });
    expect(empty.config?.ui).toEqual({});
    expect(empty.errors).toEqual([]);
    // 非法值 → 致命错误（走现有 config 报错通道）
    const badValue = parseConfig({ ...base, ui: { screen_mode: 'cozy' } });
    expect(badValue.config).toBeNull();
    expect(badValue.errors.join('\n')).toContain('ui.screen_mode 必须是 fullscreen | minimal');
    const badType = parseConfig({ ...base, ui: { screen_mode: 42 } });
    expect(badType.config).toBeNull();
    // 非对象段 → 致命错误；未知子键 → 告警
    const badSection = parseConfig({ ...base, ui: 'fullscreen' });
    expect(badSection.config).toBeNull();
    expect(badSection.errors.join('\n')).toContain('config.ui 必须是对象');
    const unknownKey = parseConfig({ ...base, ui: { screen_mode: 'minimal', vim_mode: true } });
    expect(unknownKey.config).not.toBeNull();
    expect(unknownKey.warnings.filter((w) => w.includes('ui'))).toHaveLength(1);
  });

  it('scrollback 段（P2-C 加性）：scroll.respect_manual_folds 布尔；嵌套未知键告警；非法致命', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    // 未配置不透出
    const none = parseConfig(base);
    expect(none.config?.scrollback).toBeUndefined();
    // 合法值透出（false = 自动折叠可覆盖手动折叠；true = 尊重手动折叠，缺省同义）
    const off = parseConfig({ ...base, scrollback: { scroll: { respect_manual_folds: false } } });
    expect(off.config?.scrollback).toEqual({ scroll: { respect_manual_folds: false } });
    const on = parseConfig({ ...base, scrollback: { scroll: { respect_manual_folds: true } } });
    expect(on.config?.scrollback).toEqual({ scroll: { respect_manual_folds: true } });
    // 非布尔 → 致命；嵌套未知键 → 告警
    const badType = parseConfig({ ...base, scrollback: { scroll: { respect_manual_folds: 'yes' } } });
    expect(badType.config).toBeNull();
    expect(badType.errors.join('\n')).toContain('scrollback.scroll.respect_manual_folds 必须是布尔值');
    const unknownKey = parseConfig({ ...base, scrollback: { scroll: { respect_manual_folds: true, extra: 1 } } });
    expect(unknownKey.config).not.toBeNull();
    expect(unknownKey.warnings.filter((w) => w.includes('scrollback.scroll'))).toHaveLength(1);
    // 非对象嵌套 → 致命
    const badScroll = parseConfig({ ...base, scrollback: { scroll: true } });
    expect(badScroll.config).toBeNull();
    expect(badScroll.errors.join('\n')).toContain('scrollback.scroll 必须是对象');
    const badSection = parseConfig({ ...base, scrollback: 7 });
    expect(badSection.config).toBeNull();
    expect(badSection.errors.join('\n')).toContain('config.scrollback 必须是对象');
  });

  it('ui.follow_up_behavior（P3-C 加性）：queue | steer 两值；未配置不透出；非法致命', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    const none = parseConfig(base);
    expect(none.config?.ui?.follow_up_behavior).toBeUndefined();
    const queue = parseConfig({ ...base, ui: { follow_up_behavior: 'queue' } });
    expect(queue.config?.ui).toEqual({ follow_up_behavior: 'queue' });
    const steer = parseConfig({ ...base, ui: { follow_up_behavior: 'steer' } });
    expect(steer.config?.ui).toEqual({ follow_up_behavior: 'steer' });
    const bad = parseConfig({ ...base, ui: { follow_up_behavior: 'interrupt' } });
    expect(bad.config).toBeNull();
    expect(bad.errors.join('\n')).toContain('ui.follow_up_behavior 必须是 queue | steer');
  });

  it('ui.status_line（P3-C 加性）：type 同义归一 off/none/hidden→disabled；items 闭合枚举；padding 钳 16；refresh_interval 1..86400；command 型必带 command', () => {
    const base = {
      providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
      roles: { main: { channel: 'a', model: 'm' } },
    };
    // 未配置不透出；空对象透出（缺省语义由壳层裁定）
    expect(parseConfig(base).config?.ui?.status_line).toBeUndefined();
    expect(parseConfig({ ...base, ui: { status_line: {} } }).config?.ui).toEqual({ status_line: {} });
    // type 三规范值 + 三个同义拼写归一
    for (const t of ['builtin', 'command', 'disabled'] as const) {
      const r = parseConfig({
        ...base,
        ui: { status_line: { type: t, ...(t === 'command' ? { command: 'x' } : {}) } },
      });
      expect(r.config?.ui?.status_line?.type).toBe(t);
    }
    for (const synonym of ['off', 'none', 'hidden']) {
      const r = parseConfig({ ...base, ui: { status_line: { type: synonym } } });
      expect(r.config?.ui?.status_line?.type).toBe('disabled');
    }
    const badType = parseConfig({ ...base, ui: { status_line: { type: 'neon' } } });
    expect(badType.config).toBeNull();
    expect(badType.errors.join('\n')).toContain('ui.status_line.type');
    // items：合法枚举收、未知条目致命、非数组致命
    const items = parseConfig({
      ...base,
      ui: { status_line: { type: 'builtin', items: ['cwd', 'cost', 'turn-timer'] } },
    });
    expect(items.config?.ui?.status_line?.items).toEqual(['cwd', 'cost', 'turn-timer']);
    const badItem = parseConfig({ ...base, ui: { status_line: { items: ['weather'] } } });
    expect(badItem.config).toBeNull();
    expect(badItem.errors.join('\n')).toContain('ui.status_line.items 含未知条目');
    // padding：负数致命；>16 钳到 16（G-46「上限 16」= 钳制语义）
    const badPadding = parseConfig({ ...base, ui: { status_line: { padding: -1 } } });
    expect(badPadding.config).toBeNull();
    expect(parseConfig({ ...base, ui: { status_line: { padding: 99 } } }).config?.ui?.status_line?.padding).toBe(16);
    // refresh_interval：1..86400 之外致命
    const badRefresh = parseConfig({ ...base, ui: { status_line: { refresh_interval: 86_401 } } });
    expect(badRefresh.config).toBeNull();
    expect(badRefresh.errors.join('\n')).toContain('1..86400');
    expect(
      parseConfig({ ...base, ui: { status_line: { refresh_interval: 300 } } }).config?.ui?.status_line
        ?.refresh_interval,
    ).toBe(300);
    // command 型缺 command → 致命（不做无命令的命令行）
    const missing = parseConfig({ ...base, ui: { status_line: { type: 'command' } } });
    expect(missing.config).toBeNull();
    expect(missing.errors.join('\n')).toContain('必须提供 command');
    // 未知子键告警
    const unknownKey = parseConfig({ ...base, ui: { status_line: { type: 'builtin', style: 'bold' } } });
    expect(unknownKey.config).not.toBeNull();
    expect(unknownKey.warnings.filter((w) => w.includes('ui.status_line'))).toHaveLength(1);
    // 非对象段致命
    const badSection = parseConfig({ ...base, ui: { status_line: 'bold' } });
    expect(badSection.config).toBeNull();
    expect(badSection.errors.join('\n')).toContain('ui.status_line 必须是对象');
  });
});

describe('错误消息不回显密钥内容', () => {
  it('损坏 JSON：单行错误只报偏移，不回显文件内容（内容里埋了密钥）', () => {
    const dir = tmpDir();
    const r = loadConfig({
      globalPath: writeConfig(dir, 'g.json', '{ "providers": { "a": { "apiKey": "sk-SUPER-SECRET-123" } }'), // 坏 JSON
      projectPath: join(dir, 'none.json'),
    });
    expect(r.config).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('不是合法的 JSON/JSONC');
    expect(r.errors.join('\n')).not.toContain('sk-SUPER-SECRET-123');
    // 任何一级配置损坏都是致命错误（不静默丢弃全局配置继续跑）
    const r2 = loadConfig({
      globalPath: writeConfig(dir, 'g2.json', '{broken'),
      projectPath: writeConfig(dir, 'p2.json', BASE_CONFIG),
    });
    expect(r2.config).toBeNull();
    expect(r2.errors).toHaveLength(1);
    expect(r2.errors[0]).toContain('g2.json');
  });
});

describe('auth.json 读写与容错', () => {
  it('不存在 = 空表；损坏 = 空表 + 一行错误（不抛异常）', () => {
    const dir = tmpDir();
    expect(readAuthFile(join(dir, 'none.json'))).toEqual({ auth: { channels: {} } });
    const broken = writeConfig(dir, 'broken.json', 'not json at all {');
    const r = readAuthFile(broken);
    expect(r.auth.channels).toEqual({});
    expect(r.error).toMatch(/格式非法/);
    expect(r.error).not.toContain('not json');
  });

  it('写入后可读回；channels 值宽容接受字符串形态；chmod 600（仅 POSIX 断言）', () => {
    const dir = tmpDir();
    const p = join(dir, 'sub', 'auth.json');
    writeAuthFile(p, { channels: { deepseek: { apiKey: 'test-key-abc123' } } });
    expect(existsSync(p)).toBe(true);
    expect(readAuthFile(p).auth.channels['deepseek']?.apiKey).toBe('test-key-abc123');

    // 宽容形态
    const loose = writeConfig(dir, 'loose.json', JSON.stringify({ channels: { glm: 'test-key-glm' } }));
    expect(readAuthFile(loose).auth.channels['glm']?.apiKey).toBe('test-key-glm');

    if (process.platform !== 'win32') {
      // eslint-disable-next-line no-bitwise
      const mode = statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      expect(() => writeAuthFile(p, emptyAuth())).not.toThrow(); // Windows 尽力而为不抛
    }
  });

  it('apiKey 缺失/为空的条目按损坏处理（空表 + 一行错误）', () => {
    const dir = tmpDir();
    const p = writeConfig(dir, 'a.json', JSON.stringify({ channels: { deepseek: { apiKey: '' } } }));
    const r = readAuthFile(p);
    expect(r.auth.channels).toEqual({});
    expect(r.error).toContain('apiKey');
  });

  it('P2-7 回归：多个渠道缺/空 apiKey → 错误消息列出全部渠道名', () => {
    const dir = tmpDir();
    const p = writeConfig(
      dir,
      'multi.json',
      JSON.stringify({ channels: { deepseek: { apiKey: '' }, openai: {}, glm: 'test-key-ok' } }),
    );
    const r = readAuthFile(p);
    expect(r.auth.channels).toEqual({});
    expect(r.error).toContain('deepseek');
    expect(r.error).toContain('openai');
    expect(r.error).not.toContain('glm'); // 合法渠道不进错误消息
  });

  it('auth.json 权限收紧失败不影响内容正确性（覆盖 chmod 异常分支）', () => {
    const dir = tmpDir();
    const p = join(dir, 'auth.json');
    writeAuthFile(p, { channels: {} });
    chmodSync(p, 0o644); // 手动放宽，验证读取不受影响
    expect(readAuthFile(p).auth).toEqual({ channels: {} });
  });
});

describe('redactSecrets / redactedSummary / redactObject', () => {
  it('覆盖 sk- 前缀、Bearer、x-api-key、常见密钥字段名', () => {
    const out = redactSecrets(
      'bad request with sk-abc123XYZ_def-456 in url; Authorization: Bearer tok-987654321; x-api-key: rawkey12345; {"apiKey":"leak-value-1"}',
    );
    expect(out).not.toContain('sk-abc123XYZ_def-456');
    expect(out).not.toContain('tok-987654321');
    expect(out).not.toContain('rawkey12345');
    expect(out).not.toContain('leak-value-1');
    expect(out).toContain('Authorization: [REDACTED]');
    expect(out).toContain('x-api-key: [REDACTED]');
    expect(out).toContain('"apiKey":[REDACTED]');
  });

  it('不误伤普通字段（monkey/model 等含 key 子串的词）', () => {
    const out = redactSecrets('{"monkey":"banana","model":"glm-5.3"}');
    expect(out).toContain('"monkey":"banana"');
    expect(out).toContain('"model":"glm-5.3"');
  });

  it('URL userinfo 凭据：scheme://user:pass@host 的凭据段替换（MCP url 出口脱敏，审查 P2-2）', () => {
    const out = redactSecrets('连接 https://alice:s3cret-token@example.com/mcp?x=1 失败');
    expect(out).toBe('连接 https://[REDACTED]@example.com/mcp?x=1 失败');
    // host:port（无 userinfo）不误伤
    expect(redactSecrets('https://example.com:8080/path')).toBe('https://example.com:8080/path');
    // 既有字段名模式在查询串中仍生效
    expect(redactSecrets('https://example.com/api?token=abc123xyz')).not.toContain('abc123xyz');
  });

  it('redactedSummary 先脱敏再截断（≤200 字符）', () => {
    const long = `error detail: ${'x'.repeat(300)} token=secret-value-987654321 tail`;
    const s = redactedSummary(long);
    expect(s.length).toBeLessThanOrEqual(200); // 总长不超过 maxLen
    expect(s.endsWith('…(truncated)')).toBe(true);
    expect(s).not.toContain('secret-value-987654321');
  });

  it('redactObject 深拷贝并按字段名脱敏', () => {
    const obj = redactObject({
      status: 401,
      error: { message: 'wrong key: sk-zzz-123456789', apiKey: 'real-key-42', nested: { token: 't-123456' } },
      list: [{ password: 'p-1234567' }],
    });
    expect(JSON.stringify(obj)).not.toContain('sk-zzz');
    expect(JSON.stringify(obj)).not.toContain('real-key-42');
    expect(JSON.stringify(obj)).not.toContain('t-123456');
    expect(JSON.stringify(obj)).not.toContain('p-1234567');
    expect((obj as { status: number }).status).toBe(401);
  });
});

// P7-A H-22 加性配置段：skills.authoring（off|on，缺省不出现 = off）
describe('skills.authoring（P7-A 加性配置段）', () => {
  const base = (): Record<string, unknown> => JSON.parse(BASE_CONFIG) as Record<string, unknown>;

  it('缺省：不出现 skills 段（authoring 缺省 off，旧字面量配置零回归）', () => {
    const r = parseConfig(base());
    expect(r.errors).toEqual([]);
    expect(r.config?.skills).toBeUndefined();
  });

  it("authoring='on' 透出；非法值报错", () => {
    const r = parseConfig({ ...base(), skills: { authoring: 'on' } });
    expect(r.errors).toEqual([]);
    expect(r.config?.skills?.authoring).toBe('on');

    const bad = parseConfig({ ...base(), skills: { authoring: 'yes' } });
    expect(bad.config).toBeNull();
    expect(bad.errors.some((e) => e.includes('skills.authoring'))).toBe(true);
  });

  it('未知字段告警（不静默）', () => {
    const r = parseConfig({ ...base(), skills: { authoring: 'off', nope: 1 } });
    expect(r.warnings.some((w) => w.includes('skills: 未知字段 "nope"'))).toBe(true);
    expect(r.config?.skills?.authoring).toBe('off');
  });
});
