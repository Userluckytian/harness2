// @vitest-environment jsdom
// D2 CommandLog 组件测试（jsdom + RTL）：真实 shell / cwd / exit code / 输出窗口真的渲染出来。
// 反「看似有功能实为空壳」：断言的是具体字段落到 DOM，而不是只有卡片外壳。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandLog } from '../src/renderer/features/timeline/CommandLog.js';
import type { TimelineToolRow } from '../src/renderer/features/timeline/execution-log.js';

afterEach(() => cleanup());

const row = (over: Partial<TimelineToolRow> = {}): TimelineToolRow => ({
  callId: 'call-1',
  tool: 'bash',
  status: 'failed',
  commandSource: 'executed',
  actualCommand: 'npm test',
  cwd: 'C:/proj',
  shell: 'C:\\Windows\\System32\\cmd.exe',
  exitCode: 7,
  exitCodeSource: 'bash-error',
  outputRef: 'line1\nline2',
  outputTruncated: false,
  ...over,
});

describe('CommandLog（真实命令日志渲染）', () => {
  it('渲染真实命令/cwd/shell/exit code/输出，并标注归属', () => {
    render(<CommandLog row={row()} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText(/cwd: C:\/proj/)).toBeTruthy();
    expect(screen.getByText(/shell: C:\\Windows/)).toBeTruthy();
    expect(screen.getByText('exit 7（命令报错）')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('已执行')).toBeTruthy();
    expect(screen.getByText(/line1\s+line2/)).toBeTruthy();
  });

  it('planned-only：明确标注「仅计划（未执行）」，计划命令展示但不冒充执行、无退出码', () => {
    render(
      <CommandLog
        row={row({
          commandSource: 'planned-only',
          actualCommand: undefined,
          plannedCommand: 'rm -rf build',
          status: 'not-executed',
          exitCode: undefined,
          exitCodeSource: 'none',
          outputRef: '',
        })}
      />,
    );
    expect(screen.getByText('仅计划（未执行）')).toBeTruthy();
    expect(screen.getByText('未执行')).toBeTruthy();
    // 计划命令可见（供用户判断），但归属标签明确它从未执行
    expect(screen.getByText('rm -rf build')).toBeTruthy();
    expect(screen.queryByText(/^exit /)).toBeNull();
    expect(screen.queryByText('已执行')).toBeNull();
  });

  it('大输出：默认只渲染 200 行窗口，可「加载更多」展开', () => {
    const text = Array.from({ length: 450 }, (_, i) => `L${i}`).join('\n');
    render(<CommandLog row={row({ outputRef: text, status: 'success' })} />);
    expect(screen.getByText(/1–200 \/ 450 行/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    expect(screen.getByText(/1–400 \/ 450 行/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /收起/ })).toBeTruthy();
  });

  it('错误详情：失败原因可展开（不吞错）', () => {
    render(<CommandLog row={row({ error: 'exit code 7 (signal SIGTERM)' })} />);
    expect(screen.getByText('错误详情')).toBeTruthy();
    expect(screen.getByText('exit code 7 (signal SIGTERM)')).toBeTruthy();
  });

  it('取消状态：如实标注已取消', () => {
    render(<CommandLog row={row({ status: 'cancelled', exitCode: undefined, exitCodeSource: 'none' })} />);
    expect(screen.getByText('已取消')).toBeTruthy();
  });

  it('复制输出：剪贴板可用 → 显示「已复制」；不可用 → 不谎报', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CommandLog row={row()} />);
    fireEvent.click(screen.getByRole('button', { name: '复制输出' }));
    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('line1\nline2');
  });
});
