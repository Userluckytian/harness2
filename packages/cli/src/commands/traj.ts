// packages/cli/src/commands/traj.ts
// B3-1 拆分产物：原 index.ts 第 62–96 行逐字搬入，零逻辑改动。
// traj 命令（阶段 1）：轨迹时间线查看（export/replay 在 export-replay.ts）。
import { Command } from 'commander';
import { computeProjection, loadSession, renderTrajectory } from '@harness2/core';

export function registerTrajCommands(program: Command): void {
  interface TrajOptions {
    json: boolean;
    all: boolean;
  }

  program
    .command('traj')
    .description('查看会话轨迹时间线')
    .argument('<sessionDir>', '会话目录（含 session.v1.jsonl）')
    .option('--json', '输出结构化 JSON（事件 + 投影 + 告警）', false)
    .option('--all', '包含被回退遮蔽的影子事件', false)
    .action((sessionDir: string, opts: TrajOptions) => {
      try {
        const session = loadSession(sessionDir);
        if (opts.json) {
          const projection = computeProjection(session);
          const events = session.events.map(({ event, active }) => ({ ...event, active }));
          console.log(
            JSON.stringify({ header: session.header, warnings: session.warnings, projection, events }, null, 2),
          );
          return;
        }
        for (const line of renderTrajectory(session, { includeShadowed: opts.all })) {
          console.log(line);
        }
        for (const w of session.warnings) {
          console.error(`warning: ${w}`);
        }
      } catch (e) {
        // 友好错误：一行摘要 + exit 1，不打印堆栈（P2-5）
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}
