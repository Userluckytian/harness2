// packages/cli/src/commands/doctor.ts
// B3-1 拆分产物：原 index.ts 第 214–229 行逐字搬入，零逻辑改动。
// doctor 命令（阶段 3）：环境自检（node/config+auth/目录可写/MCP 探测/会话库/skills）。
import { Command } from 'commander';
import { renderDoctorReport, runDoctor } from '@harness2/core';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('环境自检：node 版本 / config+auth（脱敏）/ 目录可写 / MCP（--probe 实连）/ 会话库完整性 / skills')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .option('--probe', '实连 MCP 服务器探测（每 server 超时 5s；缺省仅列出配置）', false)
    .action(async (opts: { root?: string; home?: string; probe?: boolean }) => {
      const report = await runDoctor({
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.probe === true ? { probe: true } : {}),
      });
      for (const line of renderDoctorReport(report)) console.log(line);
      process.exitCode = report.exitCode;
    });
}
