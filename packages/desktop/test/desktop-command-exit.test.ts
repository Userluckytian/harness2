// D2 命令日志测试：真实 shell / cwd / exit code 归属 + 大输出范围读取。
// 契约红线：仅计划（planned-only）绝不显示为已执行，也不虚构退出码。
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_WINDOW_LINES,
  buildToolRow,
  commandSourceLabel,
  exitCodeLabel,
  sliceOutputLines,
  splitOutputLines,
  statusLabel,
} from '../src/renderer/features/timeline/execution-log.js';
import type { ChatItem } from '../src/renderer/chat-model.js';
import type { ToolExecutionViewShape } from '../src/shared/protocol.js';

function view(over: Partial<ToolExecutionViewShape> = {}): ToolExecutionViewShape {
  return {
    callId: 'call-1',
    tool: 'bash',
    args: {},
    commandSource: 'executed',
    cwd: 'C:/proj',
    outputRef: '',
    outputTruncated: false,
    exitCodeSource: 'none',
    status: 'success',
    readOnly: true,
    ...over,
  };
}

const item = (over: Partial<ChatItem> = {}): ChatItem => ({ kind: 'tool', callId: 'call-1', tool: 'bash', ...over });

describe('buildToolRow：真实归属', () => {
  it('executed：actualCommand + shell + cwd + 真实退出码（来源标注）', () => {
    const row = buildToolRow(
      item(),
      view({
        actualCommand: 'npm test',
        plannedCommand: 'npm test',
        shell: 'C:\\Windows\\System32\\cmd.exe',
        exitCode: 7,
        exitCodeSource: 'bash-error',
        outputRef: 'fail',
        status: 'failed',
      }),
    );
    expect(row.commandSource).toBe('executed');
    expect(row.actualCommand).toBe('npm test');
    expect(row.shell).toContain('cmd.exe');
    expect(row.cwd).toBe('C:/proj');
    expect(row.exitCode).toBe(7);
    expect(exitCodeLabel(row)).toBe('exit 7（命令报错）');
    expect(statusLabel(row.status)).toBe('失败');
  });

  it('planned-only（审批拒绝/未启动）：不冒充已执行、不虚构退出码', () => {
    const row = buildToolRow(
      item(),
      view({
        commandSource: 'planned-only',
        plannedCommand: 'rm -rf build',
        actualCommand: undefined,
        status: 'not-executed',
        exitCodeSource: 'none',
      }),
    );
    expect(row.commandSource).toBe('planned-only');
    expect(row.actualCommand).toBeUndefined();
    expect(row.exitCode).toBeUndefined();
    expect(exitCodeLabel(row)).toBe('');
    expect(commandSourceLabel(row.commandSource)).toContain('未执行');
    expect(statusLabel(row.status)).toBe('未执行');
  });

  it('cancelled：如实标注取消（cancel ≠ undo，也不假报成功）', () => {
    const row = buildToolRow(item(), view({ status: 'cancelled', error: 'cancelled: 用户取消' }));
    expect(statusLabel(row.status)).toBe('已取消');
    expect(row.error).toContain('cancelled');
  });

  it('视图缺失（旧 serve / 查询未到）：仅按条目推状态，不声明命令归属/退出码', () => {
    const row = buildToolRow(item({ result: { ok: false, error: 'boom' } }), undefined);
    expect(row.commandSource).toBe('none');
    expect(row.exitCode).toBeUndefined();
    expect(row.exitCodeSource).toBe('none');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('boom');
  });

  it('视图缺失且结果未回：running（不当作失败）', () => {
    const row = buildToolRow(item({ result: undefined }), undefined);
    expect(row.status).toBe('running');
  });
});

describe('大输出范围读取（不把全量灌进 DOM）', () => {
  it('splitOutputLines：CRLF 归一、空行保留', () => {
    expect(splitOutputLines('a\r\nb\n\nc')).toEqual(['a', 'b', '', 'c']);
    expect(splitOutputLines('')).toEqual([]);
  });

  it('sliceOutputLines：默认窗口 = 前 200 行，标记还有后续', () => {
    const text = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n');
    const win = sliceOutputLines(text);
    expect(win.lines).toHaveLength(OUTPUT_WINDOW_LINES);
    expect(win.from).toBe(0);
    expect(win.to).toBe(OUTPUT_WINDOW_LINES);
    expect(win.total).toBe(500);
    expect(win.hasBefore).toBe(false);
    expect(win.hasAfter).toBe(true);
  });

  it('sliceOutputLines：任意起点窗口 + hasBefore/hasAfter', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const win = sliceOutputLines(text, 5, 3);
    expect(win.lines).toEqual(['L5', 'L6', 'L7']);
    expect(win.hasBefore).toBe(true);
    expect(win.hasAfter).toBe(true);
  });

  it('越界/非法起点被夹紧（不抛错）', () => {
    const win = sliceOutputLines('a\nb', 99, 10);
    expect(win.lines).toEqual([]);
    expect(win.from).toBe(2);
    expect(win.hasBefore).toBe(true);
    const neg = sliceOutputLines('a\nb', -5, 1);
    expect(neg.lines).toEqual(['a']);
  });
});
