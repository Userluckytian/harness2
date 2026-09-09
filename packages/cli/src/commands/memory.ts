// packages/cli/src/commands/memory.ts
// B3-1 拆分产物：原 index.ts 第 292–414 行逐字搬入，零逻辑改动。
// memory 命令（阶段 6）：MEMORY.md/USER.md 查看/清空 + ask 模式待审批暂存管理（只延迟不丢弃）。
import { Command } from 'commander';
import {
  MemoryStore,
  PendingMemoryStore,
  defaultMemoriesRoot,
  defaultPendingRoot,
  type MemoryTarget,
} from '@harness2/core';

export function registerMemoryCommand(program: Command): void {
  /** memory 命令（阶段 6）：MEMORY.md/USER.md 查看/清空 + ask 模式待审批暂存管理。
   *  只延迟不丢弃：approve 重放 ops 到 store（失败保留暂存），reject 显式丢弃。 */
  const memoryCmd = new Command('memory').description('长期记忆管理（MEMORY.md/USER.md + 待审批暂存）');

  interface MemoryHomeOptions {
    home?: string;
  }

  memoryCmd
    .command('show')
    .description('查看记忆条目与用量（含漂移告警）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (opts: MemoryHomeOptions) => {
      const store = new MemoryStore(defaultMemoriesRoot(opts.home));
      for (const target of ['memory', 'user'] as const) {
        const v = await store.read(target);
        console.log(`${v.file}（${v.entriesCount} 条，${v.usedChars}/${v.budget} 字符，剩余 ${v.remainingChars}）`);
        if (v.drift) {
          console.log(`  warning: 结构被外部修改（§ 结构漂移），写入将被拒绝并备份 .bak`);
        }
        for (const [i, entry] of v.entries.entries()) {
          console.log(`  [${i + 1}] ${entry.replace(/\r?\n/g, '\\n')}`);
        }
        console.log('');
      }
    });

  memoryCmd
    .command('clear')
    .description('清空记忆条目（--target memory|user|all，默认 all；不可恢复）')
    .option('--target <t>', 'memory | user | all', 'all')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (opts: MemoryHomeOptions & { target: string }) => {
      const targets: MemoryTarget[] = opts.target === 'all' ? ['memory', 'user'] : [opts.target as MemoryTarget];
      if (opts.target !== 'all' && !['memory', 'user'].includes(opts.target)) {
        console.error(`error: --target 必须是 memory | user | all，实际为 ${opts.target}`);
        process.exit(1);
      }
      const store = new MemoryStore(defaultMemoriesRoot(opts.home));
      for (const target of targets) {
        const v = await store.read(target);
        if (v.drift) {
          console.error(`error: ${v.file} 结构漂移，拒绝清空（未做备份，请先手工恢复 § 结构或删除该文件后重试）`);
          process.exitCode = 1;
          continue;
        }
        if (v.entries.length === 0) {
          console.log(`${v.file}: 无条目`);
          continue;
        }
        const ops = v.entries.map((e) => ({ operation: 'remove' as const, target, oldText: e }));
        const r = await store.apply(ops);
        if (r.ok) console.log(`${v.file}: 已清空 ${ops.length} 条`);
        else {
          console.error(`error: ${v.file} 清空失败: ${r.error}`);
          process.exitCode = 1;
        }
      }
    });

  memoryCmd
    .command('pending')
    .description('列出待审批的记忆写入（ask 模式暂存，先到先审）')
    .option('--clear', '清空全部待审批项（不可恢复），输出清除条数')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (opts: MemoryHomeOptions & { clear?: boolean }) => {
      const pending = new PendingMemoryStore(defaultPendingRoot(opts.home));
      if (opts.clear === true) {
        const cleared = await pending.clearAll();
        console.log(`已清除 ${cleared} 条待审批项`);
        return;
      }
      const items = await pending.list();
      if (items.length === 0) {
        console.log('（无待审批项）');
        return;
      }
      for (const p of items) {
        console.log(`${p.id}  ${p.createdAt}  会话 ${p.sessionId}`);
        for (const [i, op] of p.ops.entries()) {
          const text = op.operation === 'remove' ? (op.oldText ?? '') : (op.text ?? '');
          console.log(`  [${i + 1}] ${op.operation} ${op.target}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
    });

  memoryCmd
    .command('approve')
    .description('批准并重放执行一条待审批写入（预算/漂移校验照常生效）')
    .argument('<id>', '待审批项 id')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (id: string, opts: MemoryHomeOptions) => {
      // approve 重放需要绑定目标 store（预算/漂移校验照常生效）
      const pending = new PendingMemoryStore(
        defaultPendingRoot(opts.home),
        new MemoryStore(defaultMemoriesRoot(opts.home)),
      );
      const r = await pending.approve(id);
      if (!r.ok) {
        console.error(`error: ${r.error}`);
        process.exit(1);
      }
      const usage = r.result?.files.map((f) => `${f.target} ${f.usedChars}/${f.budget}`).join(', ');
      console.log(`已写入${usage ? `（${usage}）` : ''}`);
    });

  memoryCmd
    .command('reject')
    .description('拒绝并丢弃一条待审批写入')
    .argument('<id>', '待审批项 id')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (id: string, opts: MemoryHomeOptions) => {
      const pending = new PendingMemoryStore(defaultPendingRoot(opts.home));
      const ok = await pending.reject(id);
      if (!ok) {
        console.error(`error: 未找到待审批项 ${id}`);
        process.exit(1);
      }
      console.log(`已丢弃 ${id}`);
    });

  program.addCommand(memoryCmd);
}
