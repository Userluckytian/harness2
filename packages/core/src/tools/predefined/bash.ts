// bash 工具：shell 执行命令（unsafe：可能产生任意副作用，独占执行）。
import { exec } from 'node:child_process';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, optionalNumber, truncateText } from './common.js';

export const MAX_BASH_OUTPUT_CHARS = 32 * 1024;
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the session working directory. ' +
    'Returns combined stdout+stderr (truncated to 32KB). ' +
    'Non-zero exit codes are reported as errors with the captured output preserved for diagnosis.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeoutMs: { type: 'number', description: 'Kill the command after this many ms (default 30000)' },
    },
    required: ['command'],
  },
  // unsafe（默认）：不声明 concurrencySafe
  execute: (rawArgs, ctx) =>
    new Promise((resolve) => {
      let command: string;
      let timeoutMs: number;
      try {
        const args = expectObject(rawArgs, 'bash');
        command = expectString(args, 'command', 'bash');
        timeoutMs = optionalNumber(args, 'timeoutMs') ?? DEFAULT_BASH_TIMEOUT_MS;
      } catch (e) {
        resolve({ error: (e as Error).message });
        return;
      }
      exec(
        command,
        {
          cwd: ctx.cwd,
          timeout: timeoutMs,
          signal: ctx.signal,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const combined = `${stdout}${stderr}`.replace(/\r\n/g, '\n');
          if (error) {
            if (ctx.signal.aborted) return resolve({ error: 'cancelled' });
            if (error.killed) return resolve({ error: `command timed out after ${timeoutMs}ms` });
            const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
            if (typeof code === 'number') {
              return resolve({ error: `exit code ${code}`, output: truncateText(combined, MAX_BASH_OUTPUT_CHARS) });
            }
            return resolve({ error: error.message }); // spawn 失败（如命令不存在）
          }
          resolve({ output: truncateText(combined, MAX_BASH_OUTPUT_CHARS) || '(no output)' });
        },
      );
    }),
};
