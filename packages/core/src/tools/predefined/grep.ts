// grep 工具：内容正则搜索。优先 spawn ripgrep（普通输出按行解析）；
// rg 不可用（ENOENT）时回退纯 JS 扫描（跳过 node_modules/.git/二进制/大文件）。safe。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ToolDefinition, ToolOutput } from '../types.js';
import { expectObject, expectString, optionalString } from './common.js';

export const MAX_GREP_RESULTS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents with a regex. Emits `path:line:text` per match (sorted by directory walk). ' +
    'Skips node_modules/.git and binary files. Safe for parallel execution.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
    },
    required: ['pattern'],
  },
  concurrencySafe: true,
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'grep');
    const pattern = expectString(args, 'pattern', 'grep');
    const pathArg = optionalString(args, 'path');
    const searchPath = pathArg !== undefined ? resolve(ctx.cwd, pathArg) : ctx.cwd;

    const viaRg = await grepWithRipgrep(pattern, ctx.cwd, searchPath, ctx.signal);
    if (viaRg !== null) return viaRg; // rg 可用（含“无匹配”）
    return scanTextFiles(pattern, ctx.cwd, searchPath, ctx.signal);
  },
};

/** rg 路径；返回 null 表示 rg 不可用（回退 JS 扫描） */
function grepWithRipgrep(pattern: string, cwd: string, searchPath: string, signal: AbortSignal): Promise<ToolOutput | null> {
  return new Promise((resolve) => {
    const relTarget = relative(cwd, searchPath) || '.';
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (value: ToolOutput | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'rg',
        [
          '--line-number',
          '--no-heading',
          '--color',
          'never',
          '--with-filename',
          // 与 JS 回退扫描保持一致：无条件跳过 node_modules/.git
          //（rg 默认只尊重 .gitignore，无 git 仓库的目录会搜进去）
          '--glob',
          '!node_modules',
          '--glob',
          '!.git',
          '-e',
          pattern,
          relTarget,
        ],
        { cwd, signal, windowsHide: true },
      );
    } catch {
      done(null); // 平台不支持 spawn 时直接回退
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_RG_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') done(null); // rg 未安装 → 回退
      else if (signal.aborted) done({ error: 'cancelled' });
      else done({ error: `rg failed: ${e.message}` });
    });
    child.on('close', (code) => {
      if (signal.aborted) return done({ error: 'cancelled' });
      // 0=有匹配；1=无匹配（rg 约定，不算错误）
      if (code === 0 || code === 1) done(formatMatches(stdout));
      else done({ error: `rg exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
    });
  });
}

/** 解析 rg 普通行输出 `path:line:text`（统一为正斜杠相对路径） */
function formatMatches(stdout: string): ToolOutput {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const matches = lines.map((l) => l.replace(/\\/g, '/'));
  if (matches.length === 0) return { output: '(no matches)' };
  const truncated = matches.length > MAX_GREP_RESULTS;
  const shown = truncated ? matches.slice(0, MAX_GREP_RESULTS) : matches;
  const note = truncated ? `\n... [truncated at ${MAX_GREP_RESULTS} results]` : '';
  return { output: shown.join('\n') + note };
}

/** 纯 JS 回退扫描（导出供直接测试）；路径分隔符统一为 / */
export function scanTextFiles(pattern: string, cwd: string, searchPath: string, signal: AbortSignal): ToolOutput {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    return { error: `invalid regex: ${(e as Error).message}` };
  }
  const results: string[] = [];

  const scanFile = (fullPath: string): void => {
    if (results.length >= MAX_GREP_RESULTS) return;
    let buf: Buffer;
    try {
      if (statSync(fullPath).size > MAX_FILE_BYTES) return;
      buf = readFileSync(fullPath);
    } catch {
      return;
    }
    // 二进制探测：首 8KB 出现 NUL 视为二进制文件跳过
    if (buf.subarray(0, 8192).includes(0)) return;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const rel = relative(cwd, fullPath).split(sep).join('/');
    for (const [i, line] of lines.entries()) {
      if (regex.test(line)) {
        results.push(`${rel}:${i + 1}:${line}`);
        if (results.length >= MAX_GREP_RESULTS) return;
      }
    }
  };

  const walk = (dir: string): void => {
    if (signal.aborted || results.length >= MAX_GREP_RESULTS) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (signal.aborted || results.length >= MAX_GREP_RESULTS) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(full);
      } else if (ent.isFile()) {
        scanFile(full);
      }
    }
  };

  let searchIsFile = false;
  try {
    searchIsFile = statSync(searchPath).isFile();
  } catch {
    return { error: `search path not found: ${searchPath}` };
  }
  if (searchIsFile) scanFile(searchPath);
  else walk(searchPath);

  if (signal.aborted) return { error: 'cancelled' };
  if (results.length === 0) return { output: '(no matches)' };
  const truncated = results.length >= MAX_GREP_RESULTS;
  const note = truncated ? `\n... [truncated at ${MAX_GREP_RESULTS} results]` : '';
  return { output: results.join('\n') + note };
}
