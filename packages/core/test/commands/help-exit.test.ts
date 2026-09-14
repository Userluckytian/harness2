// help/exit/new 命令：HELP_TEXT 结构逐字断言（从 cli commands.ts 搬平）+ 基础缝调用。
import { describe, expect, it } from 'vitest';
import { HELP_TEXT } from '../../src/commands/index.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

describe('HELP_TEXT', () => {
  it('命令清单 29 行（/id 左对齐 16 列 + 中文 summary；P3-A 15→23 + P7 23→29）', () => {
    const commandLines = HELP_TEXT.split('\n').filter((l) => l.startsWith('  /'));
    expect(commandLines.length).toBe(29);
    expect(commandLines[0]).toBe(`  ${'/new'.padEnd(16)}新建会话`);
    expect(commandLines).toContain(`  ${'/sessions'.padEnd(16)}列出当前目录的会话（可选关键字全文搜索）`);
    expect(commandLines).toContain(`  ${'/undo'.padEnd(16)}撤销最近 n 个用户 turn（/undo [n] [--dry-run]）`);
    expect(commandLines).toContain(`  ${'/mode'.padEnd(16)}切换审批模式（/mode [normal|allow-approve|auto|plan]）`);
    expect(commandLines).toContain(`  ${'/tasks'.padEnd(16)}列出 cron 任务（只读）`);
    expect(commandLines).toContain(`  ${'/export'.padEnd(16)}导出当前会话轨迹为 ZIP（只读打包，含子代理会话）`);
    expect(commandLines).toContain(
      `  ${'/doctor'.padEnd(16)}环境自检分节报告（node/config/目录/MCP 配置/会话库/skills）`,
    );
  });

  it('说明区含 core 语义（快照/rewind/分叉/审批 [a]/命令前缀）', () => {
    expect(HELP_TEXT).toContain('说明：');
    expect(HELP_TEXT).toContain('  - write/edit 工具的文件改动会进文件快照，可被 /undo 恢复（创建的文件将被删除）；');
    expect(HELP_TEXT).toContain('  - 撤回/重做只追加 rewind 标记（append-only），会话日志永不回改。');
    expect(HELP_TEXT).toContain('  - 分叉（/fork）= 复制当前会话的活动事件到新会话（血缘入 header）；');
    expect(HELP_TEXT).toContain(
      '  - 审批提示中的 [a] 本会话总是 = 该工具后续所有调用不再询问（仅进程内会话级，不落盘）。',
    );
    expect(HELP_TEXT).toContain('  - 以 / 开头的普通消息会被当作命令，无法直接发送。');
  });

  // P1-3：run_script 的快照/观察面缺口必须写进 /help（钉死声明文案，防「假声明」回退）
  it('说明区声明 run_script 边界：子进程执行、内层改动不进快照/不可 undo、不进观察面', () => {
    expect(HELP_TEXT).toContain(
      '  - run_script 在独立 Node 子进程里执行代码（与 bash 同级的代码执行，审批在工具级）；',
    );
    expect(HELP_TEXT).toContain(
      '    脚本内经 harness.tools 的 write/edit 改动同样不进快照、/undo 无法恢复，内层调用也不进',
    );
    expect(HELP_TEXT).toContain('    会话日志与执行观察面——需要可回滚的写入请直接调 write/edit。');
  });
});

describe('/help /exit /new', () => {
  it('/help 输出 HELP_TEXT（逐字）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/help', ctx);
    expect(ctx.lines).toEqual([HELP_TEXT]);
  });

  it('/exit 与 /quit 请求退出', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/exit', ctx);
    expect(ctx.exitCalls.count).toBe(1);
    expect(ctx.lines).toEqual([]);
    await execCommand('/quit', ctx);
    expect(ctx.exitCalls.count).toBe(2);
  });

  it('/new 切换到新会话（switchSession(null)）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/new', ctx);
    expect(ctx.switched).toEqual([null]);
    expect(ctx.lines).toEqual([]);
  });
});
