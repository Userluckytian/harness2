import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { DENIED_MESSAGE, ToolExecutor, type ToolExecutionRequest } from '../src/tools/executor.js';
import type { ApprovalHandler, ToolContext, ToolDefinition } from '../src/tools/types.js';
import { bashTool } from '../src/tools/predefined/bash.js';
import { readTool } from '../src/tools/predefined/read.js';
import { writeTool } from '../src/tools/predefined/write.js';
import { editTool } from '../src/tools/predefined/edit.js';
import { globTool } from '../src/tools/predefined/glob.js';
import { grepTool, scanTextFiles } from '../src/tools/predefined/grep.js';
import { builtinTools, registerBuiltinTools } from '../src/tools/predefined/index.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** rg 可用性探测（P2-3 对齐测试注明覆盖路径：可用时双实现同测，缺失时仅回退路径） */
const rgAvailable = (() => {
  try {
    return spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  execute: async (args) => ({ output: JSON.stringify(args) }),
};

describe('ToolRegistry', () => {
  it('register 返回 disposer：dispose 后 get/list 不再包含，且可重新注册同名', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(echoTool);
    expect(reg.get('echo')).toBe(echoTool);
    expect(reg.list()).toEqual([echoTool]);
    expect(reg.size).toBe(1);

    dispose();
    expect(reg.get('echo')).toBeUndefined();
    expect(reg.list()).toEqual([]);
    expect(reg.size).toBe(0);

    const dispose2 = reg.register(echoTool); // dispose 后允许重注册
    expect(reg.get('echo')).toBe(echoTool);
    dispose2();
  });

  it('重名注册抛错（不静默覆盖）；disposer 不误伤后来者', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/);
    expect(reg.get('echo')).toBe(echoTool);
    dispose();
    expect(reg.get('echo')).toBeUndefined();
  });

  it('非法工具名抛错；名称约束 ^[a-z0-9_]+$', () => {
    const reg = new ToolRegistry();
    for (const bad of ['Echo', 'with-dash', 'with space', '', '中文']) {
      expect(() => reg.register({ ...echoTool, name: bad })).toThrow(/invalid tool name/);
    }
    for (const good of ['read', 'edit_file', 'g9']) {
      expect(good).toMatch(/^[a-z0-9_]+$/);
      expect(() => reg.register({ ...echoTool, name: good })).not.toThrow();
    }
  });
});

// ---- 基础工具集（Task 3）----

const fixtureTree = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tool-tree');

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-tools-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const realTree = realpathSync(fixtureTree); // Windows tmpdir 大小写/8.3 路径差异防护
function ctxFor(cwd: string, signal = new AbortController().signal): ToolContext {
  return { signal, cwd };
}
async function run(def: ToolDefinition, args: unknown, cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const reg = new ToolRegistry();
  reg.register(def);
  return new ToolExecutor(reg).execute({ callId: 't', tool: def.name, args }, ctxFor(cwd));
}

describe('builtin tools 装配', () => {
  it('registerBuiltinTools 一次注册 6 个工具且 disposer 可整体撤销', () => {
    const reg = new ToolRegistry();
    const dispose = registerBuiltinTools(reg);
    expect(reg.size).toBe(6);
    expect(reg.list().map((d) => d.name)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep']);
    dispose();
    expect(reg.size).toBe(0);
  });

  it('builtinTools 名称全部符合 ^[a-z0-9_]+$', () => {
    for (const t of builtinTools) expect(t.name).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('bash 工具', () => {
  it('成功：命令在 ctx.cwd 中执行', async () => {
    const dir = tmpDir();
    const r = await run(bashTool, { command: 'node -e "console.log(process.cwd())"' }, dir);
    expect(r.ok).toBe(true);
    expect(r.output?.toLowerCase()).toContain(dir.toLowerCase());
  }, 15000);

  it('成功：echo 内容进 output', async () => {
    const r = await run(bashTool, { command: 'node -e "console.log(\'hello-bash-42\')"' }, tmpDir());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('hello-bash-42');
  }, 15000);

  it('失败：非零退出码进 error，输出保留供诊断', async () => {
    const r = await run(bashTool, { command: 'node -e "console.log(\'before-fail\'); process.exit(3)"' }, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('exit code 3');
    expect(r.output).toContain('before-fail');
  }, 15000);

  it('边界：超长输出截断到 32KB 并带截断标记', async () => {
    const r = await run(bashTool, { command: 'node -e "console.log(\'x\'.repeat(40000))"' }, tmpDir());
    expect(r.ok).toBe(true);
    expect((r.output as string).length).toBeLessThan(40000);
    expect(r.output).toContain('[truncated');
  }, 15000);

  it('P1-3 回归：超时杀死整棵进程树——延时副作用文件不再出现', async () => {
    const dir = tmpDir();
    const sideEffect = join(dir, 'late-side-effect.txt');
    // 跨平台长副作用命令：node 起来后先睡 2s 再写文件（工作进程若在超时后存活，文件终将出现）
    const r = await run(
      bashTool,
      {
        command: `node -e "setTimeout(function(){require('fs').writeFileSync(process.argv[1],'late')},2000)" "${sideEffect}"`,
        timeoutMs: 600,
      },
      dir,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after 600ms/);
    // 留足缓冲（避免竞态）：副作用最迟在命令启动 ~2s 后出现；4s 后仍不存在即证明进程树已死
    await sleep(4000);
    expect(existsSync(sideEffect)).toBe(false);
  }, 20000);
});

describe('read 工具', () => {
  it('成功：全文读取带 cat -n 行号', async () => {
    const r = await run(readTool, { file_path: 'src/util.ts' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1\texport function helloUtil');
    expect(r.output).toContain('2\t  return `hello, ${name}!`;');
  });

  it('offset/limit：按 1 基行号切片读取', async () => {
    const r = await run(readTool, { file_path: 'src/util.ts', offset: 2, limit: 1 }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('2\t');
    expect(r.output).not.toContain('1\t');
  });

  it('失败：文件不存在返回 error', async () => {
    const r = await run(readTool, { file_path: 'no-such-file.txt' }, realTree);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read failed/);
  });

  it('边界：超 2000 行截断并附提示', async () => {
    const dir = tmpDir();
    const big = join(dir, 'big.txt');
    writeFileSync(big, Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`).join('\n'), 'utf8');
    const r = await run(readTool, { file_path: big }, dir);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('line-1\n');
    expect(r.output).not.toContain('line-2001');
    expect(r.output).toContain('of 2100]');
  });

  it('边界：offset 超出文件末尾报错', async () => {
    const r = await run(readTool, { file_path: 'src/util.ts', offset: 99 }, realTree);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/beyond end of file/);
  });
});

describe('write 工具', () => {
  it('成功：写入内容并自动创建父目录', async () => {
    const dir = tmpDir();
    const r = await run(writeTool, { file_path: 'deep/nested/新文件.txt', content: '你好\nworld\n' }, dir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'deep', 'nested', '新文件.txt'), 'utf8')).toBe('你好\nworld\n');
  });

  it('边界：覆盖已有文件（原子替换成功）', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'f.txt'), 'old', 'utf8');
    const r = await run(writeTool, { file_path: 'f.txt', content: 'new-content' }, dir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('new-content');
    // 目录内不残留临时文件
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual(['f.txt']);
  });

  it('失败：缺 content 参数报错', async () => {
    const r = await run(writeTool, { file_path: 'x.txt' }, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/content/);
  });

  it('P2-4 回归：成功消息 cwd 内显示相对路径、cwd 外回退绝对路径', async () => {
    const dir = tmpDir();
    const inside = await run(writeTool, { file_path: join(dir, 'a', 'b.txt'), content: 'x' }, dir);
    expect(inside.ok).toBe(true);
    expect(inside.output).toBe(`wrote 1 bytes to ${join('a', 'b.txt')}`);

    const other = tmpDir(); // cwd 之外（另一个临时目录）
    const outside = await run(writeTool, { file_path: join(other, 'x.txt'), content: 'y' }, dir);
    expect(outside.ok).toBe(true);
    expect(outside.output).toBe(`wrote 1 bytes to ${join(other, 'x.txt')}`);
  });
});

describe('edit 工具', () => {
  it('成功：唯一匹配被替换', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'f.txt'), 'alpha beta gamma', 'utf8');
    const r = await run(editTool, { file_path: 'f.txt', old_text: 'beta', new_text: 'βETA' }, dir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('alpha βETA gamma');
  });

  it('失败：old_text 未找到', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'f.txt'), 'hello', 'utf8');
    const r = await run(editTool, { file_path: 'f.txt', old_text: 'missing', new_text: 'x' }, dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('失败：old_text 多次匹配拒绝替换', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'f.txt'), 'a b a b a', 'utf8');
    const r = await run(editTool, { file_path: 'f.txt', old_text: 'a', new_text: 'x' }, dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3 times/);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('a b a b a'); // 未被改动
  });

  it('P1-2 回归：new_text 含替换模式符号（$& $$ $` $\'）时按字面写入不解释', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'f.txt'), 'alpha beta gamma', 'utf8');
    // 字符串形式的 String.replace 会解释这些符号（$&=匹配串、$$=字面 $、$'=匹配后缀等）
    const newText = "$& $$ $` $' \\$1";
    const r = await run(editTool, { file_path: 'f.txt', old_text: 'beta', new_text: newText }, dir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe(`alpha ${newText} gamma`);
  });
});

describe('glob 工具', () => {
  it('成功：**/*.ts 找到 src 下两个文件（排序输出）', async () => {
    const r = await run(globTool, { pattern: '**/*.ts' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output?.split('\n')).toEqual(['src/main.ts', 'src/util.ts']);
  });

  it('边界：无匹配返回 (no matches)', async () => {
    const r = await run(globTool, { pattern: '**/*.python' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('(no matches)');
  });

  it('path 参数：限定子目录（data 下的 .bin）', async () => {
    const r = await run(globTool, { pattern: '*.bin', path: 'data' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('blob.bin');
  });

  it('P2-5 回归：排除 node_modules/.git（目录本身与子树）', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'real.ts'), 'export {};', 'utf8');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'dep.ts'), 'export {};', 'utf8');
    writeFileSync(join(dir, '.git', 'hook.ts'), 'export {};', 'utf8');
    const r = await run(globTool, { pattern: '**/*.ts' }, dir);
    expect(r.ok).toBe(true);
    expect(r.output?.split('\n')).toEqual(['real.ts']);
    // 顶层列举时目录名本身也不出现
    const top = await run(globTool, { pattern: '*' }, dir);
    expect(top.ok).toBe(true);
    expect(top.output).not.toContain('node_modules');
    expect(top.output).not.toContain('.git');
  });
});

describe('grep 工具', () => {
  it('成功：匹配中文关键词，输出 path:line:text（rg 或 JS 回退均可）', async () => {
    const r = await run(grepTool, { pattern: '导出函数' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('README.md:');
    expect(r.output).toMatch(/README\.md:5:.*导出函数/);
  });

  it('回退扫描 scanTextFiles：与 rg 输出形态一致', () => {
    const r = scanTextFiles('helloUtil', realTree, realTree, new AbortController().signal);
    expect(r.error).toBeUndefined();
    expect(r.output).toMatch(/src\/util\.ts:1:.*helloUtil/);
    expect(r.output).toMatch(/src\/main\.ts:1:.*helloUtil/);
    expect(r.output).toMatch(/src\/main\.ts:4:.*helloUtil/);
  });

  it('边界：跳过二进制文件（blob.bin 含 NUL）与 node_modules/.git', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'hit.js'), 'const needle = 1;', 'utf8');
    writeFileSync(join(dir, '.git', 'hit.js'), 'const needle = 2;', 'utf8');
    writeFileSync(join(dir, 'a.txt'), 'needle here', 'utf8');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(realTree, 'data', 'blob.bin'), join(dir, 'blob.bin'));

    const r = await run(grepTool, { pattern: 'needle' }, dir);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('a.txt:1:needle here');
    expect(r.output).not.toContain('node_modules');
    expect(r.output).not.toContain('.git');
    // 二进制文件即使含可匹配文本也被跳过（此处 blob.bin 无文本行）
    const fallback = scanTextFiles('needle', dir, dir, new AbortController().signal);
    expect(fallback.output).not.toContain('blob.bin');
  });

  it('边界：无匹配返回 (no matches)', async () => {
    const r = await run(grepTool, { pattern: '绝不存在的词xyzzy' }, realTree);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('(no matches)');
  });

  it('失败：非法正则返回 error', async () => {
    const r = await run(grepTool, { pattern: '[unclosed' }, realTree);
    // rg 视为错误退出；回退扫描报 invalid regex —— 两者都必须 ok:false
    expect(r.ok).toBe(false);
  });

  it('P2-3 回归：回退扫描跳过隐藏文件/目录与 .env（与 rg 默认行为对齐）', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'visible.txt'), 'needle visible', 'utf8');
    writeFileSync(join(dir, '.env'), 'SECRET=needle', 'utf8');
    writeFileSync(join(dir, '.hidden', 'x.txt'), 'needle hidden', 'utf8');

    const fallback = scanTextFiles('needle', dir, dir, new AbortController().signal);
    expect(fallback.error).toBeUndefined();
    expect(fallback.output).toBe('visible.txt:1:needle visible'); // .env / .hidden 不出现（隐藏规则覆盖 .env*）

    const viaTool = await run(grepTool, { pattern: 'needle' }, dir);
    expect(viaTool.ok).toBe(true);
    // 双实现一致：rg 可用时此断言走 rg 路径；rg 缺失时工具自动回退（仅覆盖回退路径，显式注明）
    expect(viaTool.output).toBe(fallback.output);
    if (!rgAvailable) console.warn('[grep P2-3] rg unavailable — only the JS fallback path is covered');
  });

  it('P2-3 回归：仅路径段归一化分隔符——匹配文本中的反斜杠/冒号保持原样', async () => {
    const dir = tmpDir();
    const line = 'const p = "C:\\Users\\tmp" /* note a:1:b */';
    writeFileSync(join(dir, 'winpath.txt'), `${line}\n`, 'utf8');
    const r = await run(grepTool, { pattern: 'Users' }, dir);
    expect(r.ok).toBe(true);
    // 旧实现整行 \→/ 会把文本篡改为 C:/Users/tmp；修复后文本必须逐字保留
    expect(r.output).toBe(`winpath.txt:1:${line}`);
  });

  it('P2-3 回归：两实现默认大小写敏感', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'lower.txt'), 'needle here', 'utf8');
    writeFileSync(join(dir, 'upper.txt'), 'NEEDLE here', 'utf8');
    const r = await run(grepTool, { pattern: 'needle' }, dir);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('lower.txt:1:needle here'); // 不匹配 NEEDLE
    const fallbackUpper = scanTextFiles('NEEDLE', dir, dir, new AbortController().signal);
    expect(fallbackUpper.output).toBe('upper.txt:1:NEEDLE here'); // 不匹配 needle
  });
});
