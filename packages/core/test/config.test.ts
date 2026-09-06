// 配置体系测试：两级加载/深合并/${VAR} 展开/schema 校验/脱敏/auth 读写与损坏容错。
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    const base = { providers: { a: { protocol: 'openai', baseUrl: 'https://x' } }, roles: { main: { channel: 'a', model: 'm' } } };
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
