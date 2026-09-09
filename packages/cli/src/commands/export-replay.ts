// packages/cli/src/commands/export-replay.ts
// B3-1 拆分产物：原 index.ts 第 97–135 行逐字搬入，零逻辑改动。
// export / replay 命令（阶段 10 Task 1）：轨迹作为资产——只读打包导出 + 回放校验投影摘要。
import { Command } from 'commander';
import { exportSession, importReplay } from '@harness2/core';

export function registerExportReplayCommands(program: Command): void {
  /** export/replay（阶段 10 Task 1）：轨迹作为资产——只读打包导出 + 回放校验投影摘要。 */
  program
    .command('export')
    .description('导出会话轨迹为 ZIP（只读打包；含子代理会话 subagents/<id>/）')
    .argument('<sessionDir>', '会话目录（含 session.v1.jsonl）')
    .option('-o, --out <file>', '输出 zip 路径（缺省：当前目录/<sessionId>.zip）')
    .action((sessionDir: string, opts: { out?: string }) => {
      try {
        const r = exportSession(sessionDir, opts.out);
        console.log(`已导出 ${r.sessionId} → ${r.outFile}（${r.entryCount} 个文件）`);
        if (r.subagentIds.length > 0) {
          console.log(`子代理会话：${r.subagentIds.join(', ')}`);
        }
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('replay')
    .description('回放校验导出的 ZIP（逐事件解析 + 投影摘要；坏行报告；CI 零 key 可跑）')
    .argument('<zip>', 'export 产出的 zip 文件')
    .action((zipPath: string) => {
      try {
        const report = importReplay(zipPath);
        for (const s of report.sessions) {
          const label = s.source === 'session.v1.jsonl' ? '主会话' : '子会话';
          console.log(
            `${label} ${s.id}  events=${s.events}  messages=${s.messageCount}  lastSeq=${s.lastSeq}  badLines=${s.badLines}`,
          );
          for (const w of s.warnings) console.log(`  warning: ${w}`);
        }
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
