// chat 命令集：/new /sessions /resume /undo /redo /help /exit。
// 命令是 REPL 状态机的薄操作层：所有会话写入都经 core（undo/redo 只追加 rewind/marker）。
import type { SessionManager, SessionWriter, SnapshotStore } from '@harness2/core';
import { redoLastUndo, undoLastTurn } from '@harness2/core';

export const HELP_TEXT = [
  '命令：',
  '  /new                   新建会话',
  '  /sessions [关键字]     列出当前目录的会话（带关键字时改为全文搜索）',
  '  /resume <id>           恢复指定会话',
  '  /undo [n] [--dry-run]  撤销最近 n 个用户 turn（--dry-run 仅预览，不落盘）',
  '  /redo                  重做最近一次撤销（可连续多次逐层恢复）',
  '  /help                  显示本帮助',
  '  /exit                  退出（等价：Ctrl+C 两次，或空行按 Ctrl+D）',
  '说明：',
  '  - write/edit 工具的文件改动会进文件快照，可被 /undo 恢复（创建的文件将被删除）；',
  '    bash 命令造成的改动不进快照，/undo 无法恢复它（如实声明）。',
  '  - redo 会恢复到撤销前状态，撤销之后新输入的消息将被移出当前上下文',
  '    （仍保留在日志中，可用 traj 查看）。',
  '  - 撤回/重做只追加 rewind 标记（append-only），会话日志永不回改。',
  '  - 审批提示中的 [a] 本会话总是 = 该工具后续所有调用不再询问（仅进程内会话级，不落盘）。',
  '  - 以 / 开头的普通消息会被当作命令，无法直接发送。',
].join('\n');

/** 解析命令行：以 / 开头返回命令名与其余参数；非命令返回 null */
export function parseCommand(line: string): { name: string; rest: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { name: name.toLowerCase(), rest };
}

/** 命令处理所需的 REPL 状态缝（chat.ts 注入；便于单测与替换） */
export interface CommandContext {
  print(text: string): void;
  manager: SessionManager;
  /** 会话分组/搜索的工作目录 */
  cwd: string;
  current(): { id: string; writer: SessionWriter } | null;
  /** id 为 null = 新建会话；否则恢复该会话 */
  switchSession(id: string | null): void;
  requestExit(): void;
  /** 当前会话的快照存储（undo/redo 联动） */
  snapshots(): SnapshotStore | undefined;
}

export function handleCommand(parsed: { name: string; rest: string }, ctx: CommandContext): void {
  switch (parsed.name) {
    case '/help':
    case '/?':
      ctx.print(HELP_TEXT);
      return;
    case '/exit':
    case '/quit':
      ctx.requestExit();
      return;
    case '/new':
      ctx.switchSession(null);
      return;
    case '/resume': {
      const id = parsed.rest.split(/\s+/)[0] ?? '';
      if (id.length === 0) {
        ctx.print('error: 用法 /resume <id>（/sessions 查看 id）');
        return;
      }
      ctx.switchSession(id);
      return;
    }
    case '/sessions':
      handleSessions(parsed.rest, ctx);
      return;
    case '/undo':
      handleUndo(parsed.rest, ctx);
      return;
    case '/redo':
      handleRedo(ctx);
      return;
    default:
      ctx.print(`未知命令 ${parsed.name}（/help 查看命令列表）`);
  }
}

function handleSessions(keyword: string, ctx: CommandContext): void {
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

function handleUndo(rest: string, ctx: CommandContext): void {
  const parsed = parseUndoArgs(rest);
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
      const r = undoLastTurn(current.writer, { ...(snapshots !== undefined ? { snapshots } : {}), dryRun: parsed.dryRun });
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

function handleRedo(ctx: CommandContext): void {
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

/** 打印文件恢复计划/结果（dryRun 与实际执行共用格式） */
function printFiles(files: ReadonlyArray<{ file: string; target: string | null; restored: boolean; externallyModified: boolean; error?: string }>, print: (t: string) => void): void {
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

/** /undo 参数解析：[n] [--dry-run]；非法返回错误消息 */
export function parseUndoArgs(rest: string): { count: number; dryRun: boolean } | string {
  let count = 1;
  let dryRun = false;
  for (const token of rest.split(/\s+/).filter((t) => t.length > 0)) {
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > 100) return `无效的撤回层数 "${token}"（应为 1..100 整数）`;
    count = n;
  }
  return { count, dryRun };
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
