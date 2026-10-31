// P1-2 审查统一单测：buildSubprocessSafeEnv（子进程安全环境白名单单一共享出口）。
// 断言面：关键系统变量透传（含 buildHookEnv 既有集合的超集口径）、宿主密钥类变量不透传、
// 未列入键一律不透传、空串/undefined 值语义与原 6 份 buildSafeEnv 副本一致（仅滤 undefined）。
import { describe, expect, it } from 'vitest';
import { buildSubprocessSafeEnv } from '../src/tools/process-env.js';

describe('buildSubprocessSafeEnv：子进程安全环境白名单（P1-2 单一共享出口）', () => {
  it('透传白名单关键变量（含 buildHookEnv 系统变量集与 6 份副本既有集合）', () => {
    const env = buildSubprocessSafeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      USERPROFILE: 'C:\\Users\\u',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\u',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      TMPDIR: '/tmp',
      PATHEXT: '.COM;.EXE',
      ComSpec: 'C:\\Windows\\cmd.exe',
      GIT_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      USER: 'u',
      USERNAME: 'u',
      SYSTEMROOT: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      SYSTEMDRIVE: 'C:',
      SystemDrive: 'C:',
      windir: 'C:\\Windows',
      OS: 'Windows_NT',
      PROGRAMFILES: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      PROCESSOR_ARCHITECTURE: 'AMD64',
    });
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/u');
    expect(env['USERPROFILE']).toBe('C:\\Users\\u');
    expect(env['HOMEDRIVE']).toBe('C:');
    expect(env['HOMEPATH']).toBe('\\Users\\u');
    expect(env['TEMP']).toBe('C:\\Temp');
    expect(env['TMPDIR']).toBe('/tmp');
    expect(env['PATHEXT']).toBe('.COM;.EXE');
    expect(env['ComSpec']).toBe('C:\\Windows\\cmd.exe');
    expect(env['GIT_BASH']).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(env['LANG']).toBe('zh_CN.UTF-8');
    expect(env['LC_ALL']).toBe('zh_CN.UTF-8');
    expect(env['USER']).toBe('u');
    expect(env['USERNAME']).toBe('u');
    expect(env['SYSTEMROOT']).toBe('C:\\Windows');
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(env['SYSTEMDRIVE']).toBe('C:');
    expect(env['windir']).toBe('C:\\Windows');
    expect(env['OS']).toBe('Windows_NT');
    expect(env['PROGRAMFILES']).toBe('C:\\Program Files');
    expect(env['APPDATA']).toBe('C:\\Users\\u\\AppData\\Roaming');
    expect(env['LOCALAPPDATA']).toBe('C:\\Users\\u\\AppData\\Local');
    expect(env['ALLUSERSPROFILE']).toBe('C:\\ProgramData');
    expect(env['PROCESSOR_ARCHITECTURE']).toBe('AMD64');
  });

  it('宿主密钥类变量不透传；未列入键一律不透传（注入 SK=sensitive 构造 env）', () => {
    const env = buildSubprocessSafeEnv({
      PATH: '/usr/bin',
      SK: 'sensitive',
      API_KEY: 'sk-should-not-leak',
      ANTHROPIC_API_KEY: 'nope',
      OPENAI_API_KEY: 'nope',
      AWS_SECRET_ACCESS_KEY: 'nope',
      DATABASE_URL: 'postgres://…',
      HARNESS2_HOOK_EVENT: 'should-not-leak-either',
    });
    expect(env['SK']).toBeUndefined();
    expect(env['API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HARNESS2_HOOK_EVENT']).toBeUndefined();
  });

  it('白名单内值为空串仍透传、undefined 不透传（与原 6 份副本滤 undefined 口径一致）', () => {
    const env = buildSubprocessSafeEnv({ PATH: '', LANG: undefined });
    expect(env['PATH']).toBe('');
    expect(env['LANG']).toBeUndefined();
  });
});
