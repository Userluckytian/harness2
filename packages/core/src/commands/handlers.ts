// 11 条 core 命令的业务实现（help/exit/new/resume/sessions/fork/undo/redo/context/compact/tasks）。
// 输出文案从 cli commands.ts 与三处内联实现逐字搬平；只经 ctx.print 产出纯文本行。
// mode/reasoning 不在本文件（shellOnly：实现留壳，见 catalog.ts 与 types.ts 注释）。
import { getContextUsage } from '../agent/contextUsage.js';
import type { CronJob } from '../cron/jobs.js';
import type { SnapshotRestoreItem } from '../session/snapshots.js';
import { redoLastUndo, undoLastTurn } from '../session/undo.js';
import { HELP_TEXT } from './help.js';
import { parseUndoArgs } from './parse.js';
import type { CoreCommandArgs, CoreCommandContext } from './types.js';

// ---- 通用 ----

export function runHelp(ctx: CoreCommandContext): void {
  ctx.print(HELP_TEXT);
}

export function runExit(ctx: CoreCommandContext): void {
  ctx.requestExit();
}

export function runNew(ctx: CoreCommandContext): void {
  ctx.switchSession(null);
}

// ---- 会话 ----

export function runResume(ctx: CoreCommandContext, args: CoreCommandArgs): void {
  const id = args.rest.split(/\s+/)[0] ?? '';
  if (id.length === 0) {
    ctx.print('error: 用法 /resume <id>（/sessions 查看 id）');
    return;
  }
  ctx.switchSession(id);
}

export function runSessions(ctx: CoreCommandContext, args: CoreCommandArgs): void {
  const keyword = args.rest;
  if (keyword.length > 0) {
    const hits = ctx.manager.search(ctx.cwd, keyword);
    if (hits.length === 0) {
      ctx.print(`（无匹配会话：${keyword}）`);
      return;
    }
    for (const s of hits) {
      ctx.print(`${s.id}  ${formatTime(s.mtimeMs)}  ${s.messageCount} 条  ${s.firstUserText}`);
      for (const h of s.hits) {
        ctx.print(`    命中 [${h.role}@${h.seq}]: ${h.snippet}`);
      }
    }
    return;
  }
  const list = ctx.manager.list(ctx.cwd);
  if (list.length === 0) {
    ctx.print('（无会话）');
    return;
  }
  for (const s of list) {
    const marker = ctx.current()?.id === s.id ? ' *' : '';
    ctx.print(`${s.id}  ${formatTime(s.mtimeMs)}  ${s.messageCount} 条${marker}  ${s.firstUserText}`);
  }
}

export function runFork(ctx: CoreCommandContext, args: CoreCommandArgs): void {
  if (ctx.fork === undefined) {
    ctx.print('error: 当前会话不支持分叉');
    return;
  }
  const token = args.rest.split(/\s+/)[0] ?? '';
  if (token.length === 0) {
    ctx.fork();
    return;
  }
  const at = Number(token);
  if (!Number.isInteger(at) || at < 1) {
    ctx.print(`error: 无效的事件序号 "${token}"（应为 >= 1 的整数，或省略分叉全部活动事件）`);
    return;
  }
  ctx.fork(at);
}

// ---- 历史（undo/redo：直接复用 core undoLastTurn/redoLastUndo） ----

export function runUndo(ctx: CoreCommandContext, args: CoreCommandArgs): void {
  const parsed = parseUndoArgs(args.rest);
  if (typeof parsed === 'string') {
    ctx.print(`error: ${parsed}`);
    return;
  }
  const current = ctx.current();
  if (!current) {
    ctx.print('error: 无活动会话');
    return;
  }
  const snapshots = ctx.snapshots();
  for (let i = 0; i < parsed.count; i++) {
    try {
      const r = undoLastTurn(current.writer, {
        ...(snapshots !== undefined ? { snapshots } : {}),
        dryRun: parsed.dryRun,
      });
      if (parsed.dryRun) {
        ctx.print(`预览（未执行）：将撤回 ${r.messages} 条消息，rewind 到 seq ${r.rewindToSeq}`);
      } else {
        ctx.print(`已撤回 ${r.messages} 条消息（rewind 到 seq ${r.rewindToSeq}）`);
      }
      printFiles(r.files, ctx.print);
    } catch (e) {
      if ((e as Error).name === 'UndoRedoError') {
        ctx.print(`error: ${(e as Error).message}`);
        return;
      }
      throw e;
    }
  }
}

export function runRedo(ctx: CoreCommandContext): void {
  const current = ctx.current();
  if (!current) {
    ctx.print('error: 无活动会话');
    return;
  }
  const snapshots = ctx.snapshots();
  try {
    const r = redoLastUndo(current.writer, snapshots !== undefined ? { snapshots } : {});
    ctx.print(`已重做 ${r.messages} 条消息（rewind 到 seq ${r.rewindToSeq}）`);
    printFiles(r.files, ctx.print);
  } catch (e) {
    if ((e as Error).name === 'UndoRedoError') {
      ctx.print(`error: ${(e as Error).message}`);
      return;
    }
    throw e;
  }
}

// ---- 上下文（context/compact：可选缝未注入时如实降级，对齐现有壳行为） ----

export function runContext(ctx: CoreCommandContext): void {
  const usage = ctx.contextUsage !== undefined ? ctx.contextUsage() : fallbackContextUsage(ctx);
  ctx.print(`上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`);
}

/** 缺省占用口径：core getContextUsage（与 cli 三处内联实现同源同算法） */
function fallbackContextUsage(ctx: CoreCommandContext): number | undefined {
  const current = ctx.current();
  return current !== null ? getContextUsage(current.writer.dir) : undefined;
}

export function runCompact(ctx: CoreCommandContext): void | Promise<void> {
  if (ctx.compact === undefined) {
    ctx.print('压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。');
    return;
  }
  const seam = ctx.compact;
  return Promise.resolve()
    .then(() => seam())
    .then((applied) => {
      ctx.print(
        applied ? '已执行上下文压缩。' : '未执行压缩：未达阈值或摘要生成失败（下一次 turn 开始时会自动重试）。',
      );
    });
}

// ---- 调度 ----

export function runTasks(ctx: CoreCommandContext): void {
  if (ctx.cronJobs === undefined) {
    ctx.print('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
    return;
  }
  const jobs: readonly CronJob[] = ctx.cronJobs();
  if (jobs.length === 0) {
    ctx.print('（无任务）');
    return;
  }
  for (const j of jobs) {
    const state = j.enabled ? '启用' : '停用';
    ctx.print(`${j.id}  ${j.schedule}  ${state}  ${clipText(j.instruction, 60)}`);
  }
}

// ---- 私有输出助手（从 cli commands.ts 搬平） ----

/** 打印文件恢复计划/结果（dryRun 与实际执行共用格式） */
function printFiles(files: ReadonlyArray<SnapshotRestoreItem>, print: (t: string) => void): void {
  for (const f of files) {
    const action = f.target === null ? '删除创建的文件' : `恢复内容 ${previewOf(f.target)}`;
    const state = f.error !== undefined ? `失败（${f.error}）` : f.restored ? '已执行' : '待执行';
    const flag = f.externallyModified ? ' [外部修改]' : '';
    print(`  - ${f.file} → ${action}${flag}（${state}）`);
  }
  if (files.length === 0) print('  - 文件快照：无（本 turn 未通过 write/edit 改动文件，或未启用快照）');
}

function previewOf(target: string): string {
  const oneLine = target.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length <= 40 ? oneLine : `${oneLine.slice(0, 40)}…`;
  return JSON.stringify(clipped);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 长文本一行摘要（≤max 字，超长加省略号；对齐 SessionManager 的摘要口径） */
function clipText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
