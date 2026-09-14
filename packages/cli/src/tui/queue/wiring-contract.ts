// wiring-contract.ts — G-26/G-27/G-28/G-30 四条语义的接缝状态机（输入注入式，headless 可测）。
//
// 规格依据：refs-grok-build.md G-26～G-30 与上游 03-keyboard-shortcuts.md「Follow-ups
// mid-turn」节（L282～L302）。本文件把「回合循环与队列/转向的接缝」钉成**纯状态机**：
// 输入（已解析的语义按键）+ 上下文（回合相位 / 草稿 / 队列 / 行为 / turnId）→ 队列新状态 +
// 单一效果指令。装配层（下一棒）只做三件事：把 KeyEvent 解析成本模块的语义输入（解析器
// 也在本文件）、按效果执行（submit / abortTurn / sink.push / 报告文案）、把回帧反馈进来。
// 本层不持有任何运行时句柄（不 import chat-setup / SessionSteerSink 实例）——steer 语义
// 的执行仍归 core SessionSteerSink，本机只构造请求（queue.ts 复用 cli steer.ts 纯函数）。
//
// ── 四条语义（逐条对齐上游文本）────────────────────────────────────────────────
//  G-26 回合运行中普通 Enter（草稿非空）：
//    - follow_up_behavior = 'queue'（缺省）：**入队不打断**——效果 enqueue，无取消；
//    - 'steer'：同一 Enter 仍入队展示 + 构造 SteerRequest 交装配层 push（安全 step 边界
//      注入）；turnId 未知 → steer-unknown（草稿保留，绝不猜 turnId，对齐 submitSteer）。
//  G-27 空 composer 再 Enter：发送**队首**一条（double-Enter）；空队列 → no-op。
//  G-28 send-now 和弦 = **cancel-and-send**（取消当前回合、余量与后台任务照常）：
//    - 草稿非空 → 取消并立即发送草稿文本；
//    - 草稿空 + 队列非空 → 取消并立即发送队首；
//    - 队列面板打开 → 发送**高亮行**（同和弦或 [Send now]）；
//    - 空闲，或空草稿且无排队 → 该键 no-op（G-28 明文；Ctrl+Enter 空闲态不提交新回合）。
//  G-30 阻塞等待中（卡片 / 后台任务 / 子代理等待）：普通 Enter + 草稿非空 → **直送**（取消
//    阻塞回合、消息作为下一回合执行）——不入队；草稿空 → no-op。
//  附带：idle + Enter + 草稿非空 → submit-normal（普通发送，既有基线路径，状态机完整接管
//  Enter 路由；空闲提交不属于 G-5x，单列效果供装配层走原路径）。
//
// ── 键位解析（和弦 → 语义输入；表即文档）────────────────────────────────────────
//  send-now 和弦三终端族（G-28 上游表）：
//    default        主 Ctrl+Enter（kitty 编码 key='enter'+ctrl），备 Ctrl+I（kitty 'i'+ctrl；
//                   legacy 0x09 与 Tab 同字节不可达——上游 Windows 提示改用 Ctrl+I 指的正是
//                   letter-key 和弦更稳，本表 kitty 位照收，legacy 位由 Ctrl+L/O 承担）；
//    apple-terminal 主 Ctrl+O（legacy 0x0f 可达），备 Ctrl+Enter / Ctrl+I；
//    vscode-family  仅 Ctrl+L（legacy 0x0c 可达；上游明文 Ctrl+I 不用、无备用）。
//  面板内 Enter / e（队列焦点）：见 panel.ts；解析器据 panel 上下文折叠成语义输入。
import { chordMatches, type Chord } from '../input/keymaps.js';
import type { KeyEvent } from '../../input/types.js';
import type { SteerRequest } from '@harness2/core';
import {
  buildFollowUpSteer,
  dequeueHead,
  enqueueFollowUp,
  removeFollowUpById,
  type QueuedFollowUp,
  type QueueState,
} from './queue.js';

/** 回合相位（G-26 running / G-30 blocked / 其余 idle；blocked = 卡片或任务/子代理等待） */
export type TurnPhase = 'idle' | 'running' | 'blocked';

/** 终端族（G-28 send-now 和弦差异的维度；与 capability.ts 的终端能力面正交，装配层裁定） */
export type SendNowTerminalFamily = 'default' | 'apple-terminal' | 'vscode-family';

/** send-now 和弦表（G-28 三终端族；字母小写 + ctrl 位，口径同 keymaps.ts） */
export const SEND_NOW_CHORDS: Readonly<
  Record<SendNowTerminalFamily, readonly { label: string; chords: readonly Chord[] }[]>
> = {
  default: [
    { label: 'Ctrl+Enter', chords: [{ key: 'enter', ctrl: true }] },
    { label: 'Ctrl+I', chords: [{ key: 'i', ctrl: true }] },
  ],
  'apple-terminal': [
    { label: 'Ctrl+O', chords: [{ key: 'o', ctrl: true }] },
    { label: 'Ctrl+Enter', chords: [{ key: 'enter', ctrl: true }] },
    { label: 'Ctrl+I', chords: [{ key: 'i', ctrl: true }] },
  ],
  'vscode-family': [{ label: 'Ctrl+L', chords: [{ key: 'l', ctrl: true }] }],
};

/** send-now 和弦的展示名（按终端族；cheatsheet / 状态提示复用） */
export function sendNowLabel(family: SendNowTerminalFamily): string {
  return SEND_NOW_CHORDS[family][0]?.label ?? 'Ctrl+Enter';
}

/** 键事件是否命中 send-now 和弦（按终端族取表） */
export function matchesSendNow(ev: KeyEvent, family: SendNowTerminalFamily): boolean {
  return SEND_NOW_CHORDS[family].some((binding) => binding.chords.some((chord) => chordMatches(chord, ev)));
}

// —— 语义输入（KeyEvent → 语义事件的解析产物；状态机只认这一层）─────────────────

export type FollowUpInput =
  /** 普通 Enter（含面板内 Enter——由 resolveFollowUpInput 折叠） */
  | { type: 'enter' }
  /** send-now 和弦（G-28） */
  | { type: 'send-now' }
  /** 队列面板内对高亮行「立即发送」（Enter on focused row，上游 L236） */
  | { type: 'panel-send-selected' }
  /** 队列面板内编辑高亮行（`e`，上游 L236：文本落回 composer 并移出行） */
  | { type: 'panel-edit-selected' };

/** 面板上下文（panel.ts 的状态投影；装配层传入，避免反向依赖面板状态机实例） */
export interface PanelSelectionContext {
  readonly open: boolean;
  readonly focus: 'queue' | 'history';
  readonly activeIndex: number;
}

/** 语义输入解析（KeyEvent → FollowUpInput；无匹配 = null，装配层继续给别的层处理） */
export function resolveFollowUpInput(
  ev: KeyEvent,
  opts: { family: SendNowTerminalFamily; panel?: PanelSelectionContext; queueCount: number },
): FollowUpInput | null {
  // 面板内按键优先（面板接管键盘：Enter/e 只作用高亮行，不再走全局路由）
  if (opts.panel?.open === true && opts.panel.focus === 'queue' && opts.queueCount > 0) {
    if (chordMatches({ key: 'enter' }, ev)) return { type: 'panel-send-selected' };
    if (chordMatches({ key: 'e' }, ev)) return { type: 'panel-edit-selected' };
    return null; // 面板打开期间其余键归面板/浮层处理（装配层裁决），状态机不吞
  }
  if (matchesSendNow(ev, opts.family)) return { type: 'send-now' };
  if (chordMatches({ key: 'enter' }, ev)) return { type: 'enter' };
  return null;
}

// —— 效果指令（装配层据此执行；单一效果，副作用清单即接缝契约）──────────────────

export type FollowUpEffect =
  /** 无操作（含 G-27 空队列 / G-28 空闲与空+无排队 / G-30 空草稿等边界） */
  | { kind: 'none'; reason: string }
  /** 普通空闲提交（非 G-5x 范围；装配层走既有 runUserTurn 路径，不入队） */
  | { kind: 'submit-normal'; text: string }
  /** G-26 queue：入队展示，不打断当前回合（无取消语义） */
  | { kind: 'enqueue'; entry: QueuedFollowUp; message: string }
  /** G-26 steer：入队展示 + 构造好的 SteerRequest（装配层 push 进 core SessionSteerSink） */
  | { kind: 'steer'; entry: QueuedFollowUp; request: SteerRequest; message: string }
  /** G-26 steer 边界：turnId 未知（尚无首个流事件）——草稿保留，不猜 turnId */
  | { kind: 'steer-unknown'; reason: string; draftKept: true; message: string }
  /** G-27：发送队首一条（已出队；装配层提交为下一回合） */
  | { kind: 'send-head'; entry: QueuedFollowUp }
  /** G-28：取消当前回合并立即发送草稿文本（余量/后台任务照常） */
  | { kind: 'send-now-text'; text: string; cancelTurn: true }
  /** G-28：取消当前回合并立即发送队首（已出队） */
  | { kind: 'send-now-head'; entry: QueuedFollowUp; cancelTurn: true }
  /** G-28（面板打开）：取消当前回合并立即发送高亮行（已出队） */
  | { kind: 'send-now-selected'; entry: QueuedFollowUp; cancelTurn: true }
  /** G-30：阻塞等待中直送——取消阻塞回合、立即作为下一回合执行，不入队 */
  | { kind: 'direct-send'; text: string; cancelTurn: true }
  /** 面板内 `e`：编辑高亮行——文本落回 composer、行移出队列 */
  | { kind: 'edit-selected'; entry: QueuedFollowUp };

export interface FollowUpContext {
  readonly phase: TurnPhase;
  /** composer 当前草稿（空串 = 空 composer） */
  readonly draft: string;
  /** 当前运行回合的 turnId（首个流事件起可知；未知 = undefined——steer 构造按 unknown 处理） */
  readonly turnId?: string;
  /** steer id 序列号（装配层单调维护；与 chat-setup 的 steerSeq 同口径） */
  readonly steerSeq: number;
  /** 队列面板选择上下文（未打开 = undefined） */
  readonly panel?: PanelSelectionContext;
}

export interface FollowUpReduction {
  /** 队列新状态（本函数永不修改入参） */
  readonly state: QueueState;
  /** 草稿处置：true = 装配层应清空 composer（入队/发送成功后）；false/缺省 = 保留 */
  readonly draftCleared: boolean;
  readonly effect: FollowUpEffect;
}

const none = (reason: string): FollowUpEffect => ({ kind: 'none', reason });

/**
 * follow-up 语义状态机主入口（纯函数：同输入恒同输出）。
 * 输入为已解析的 FollowUpInput（解析见 resolveFollowUpInput）；队列状态与效果一同返回。
 */
export function reduceFollowUpInput(state: QueueState, ctx: FollowUpContext, input: FollowUpInput): FollowUpReduction {
  switch (input.type) {
    case 'enter':
      return reduceEnter(state, ctx);
    case 'send-now':
      return reduceSendNow(state, ctx);
    case 'panel-send-selected':
      return reducePanelSendSelected(state, ctx);
    case 'panel-edit-selected':
      return reducePanelEditSelected(state, ctx);
  }
}

/** Enter 路由：G-30（blocked）> G-27/G-26（running）> 空闲普通提交 */
function reduceEnter(state: QueueState, ctx: FollowUpContext): FollowUpReduction {
  const draftEmpty = ctx.draft.trim().length === 0;
  if (ctx.phase === 'blocked') {
    // G-30：卡片/任务等待中，Enter 直送（不入队）；空草稿 no-op
    if (draftEmpty) return { state, draftCleared: false, effect: none('blocked 等待中空草稿 Enter：无可直送文本') };
    return { state, draftCleared: true, effect: { kind: 'direct-send', text: ctx.draft, cancelTurn: true } };
  }
  if (ctx.phase === 'running') {
    if (!draftEmpty) {
      if (state.behavior === 'queue') {
        // G-26 queue：入队不打断
        const { state: next, outcome } = enqueueFollowUp(state, ctx.draft);
        if (outcome.kind === 'enqueued') {
          return {
            state: next,
            draftCleared: true,
            effect: { kind: 'enqueue', entry: outcome.entry, message: '已入队，不打断当前回合（收尾后按序执行）' },
          };
        }
        return { state: next, draftCleared: false, effect: none(outcome.message) };
      }
      // G-26 steer：仍入队展示 + 构造 steer 请求（core SessionSteerSink 执行）
      const request = buildFollowUpSteer({ turnId: ctx.turnId, seq: ctx.steerSeq, text: ctx.draft });
      if (request === null) {
        return {
          state,
          draftCleared: false,
          effect: {
            kind: 'steer-unknown',
            reason: '当前没有可绑定的 turn（尚无 turnId）',
            draftKept: true,
            message: 'steer 未提交：尚无进行中的 turn（草稿保留）',
          },
        };
      }
      const { state: next, outcome } = enqueueFollowUp(state, ctx.draft);
      if (outcome.kind !== 'enqueued') {
        // 容量满/空白拒绝：steer 也不提交（展示行都没进去，注入失去载体）
        return { state: next, draftCleared: false, effect: none(outcome.message) };
      }
      return {
        state: next,
        draftCleared: true,
        effect: {
          kind: 'steer',
          entry: outcome.entry,
          request,
          message: 'steer 已提交：将在安全 step 边界注入当前回合',
        },
      };
    }
    // G-27：空 composer 再 Enter = 发送队首一条；空队列 no-op
    const { state: next, entry } = dequeueHead(state);
    if (entry === undefined) {
      return { state, draftCleared: false, effect: none('队列为空：空 composer Enter 无可发送条目') };
    }
    return { state: next, draftCleared: false, effect: { kind: 'send-head', entry } };
  }
  // 空闲：普通提交（既有基线路径）；空草稿 no-op
  if (draftEmpty) return { state, draftCleared: false, effect: none('空闲且空草稿：Enter 无操作') };
  return { state, draftCleared: true, effect: { kind: 'submit-normal', text: ctx.draft } };
}

/** send-now 路由（G-28 cancel-and-send；空闲 no-op——「it does not submit a new idle turn」） */
function reduceSendNow(state: QueueState, ctx: FollowUpContext): FollowUpReduction {
  // G-28 明文：Idle → no-op for that key（空闲态 send-now 不提交新回合、不发草稿）
  if (ctx.phase === 'idle') {
    return { state, draftCleared: false, effect: none('send-now 空闲态无操作（G-28：不提交新回合）') };
  }
  const draftEmpty = ctx.draft.trim().length === 0;
  // 队列面板打开（队列焦点）→ 高亮行优先（上游：On the queue pane, the same chord sends the selected row）
  const selected = selectedEntry(state, ctx.panel);
  if (selected !== undefined) {
    const { state: next } = removeFollowUpById(state, selected.id);
    return {
      state: next,
      draftCleared: false,
      effect: { kind: 'send-now-selected', entry: selected, cancelTurn: true },
    };
  }
  if (!draftEmpty) {
    return { state, draftCleared: true, effect: { kind: 'send-now-text', text: ctx.draft, cancelTurn: true } };
  }
  if (state.entries.length > 0) {
    const { state: next, entry } = dequeueHead(state);
    if (entry !== undefined)
      return { state: next, draftCleared: false, effect: { kind: 'send-now-head', entry, cancelTurn: true } };
  }
  // 空闲，或空草稿且无排队 → no-op（G-28 明文；空闲态 Ctrl+Enter 不提交新回合）
  return { state, draftCleared: false, effect: none('send-now 无目标：空闲或空草稿且无排队（G-28 no-op）') };
}

/** 面板内 Enter：立即发送高亮行（= cancel-and-send 同路径；无高亮行/未打开 no-op） */
function reducePanelSendSelected(state: QueueState, ctx: FollowUpContext): FollowUpReduction {
  const selected = selectedEntry(state, ctx.panel);
  if (selected === undefined) {
    return { state, draftCleared: false, effect: none('面板无高亮行：Enter 无操作') };
  }
  const { state: next } = removeFollowUpById(state, selected.id);
  return { state: next, draftCleared: false, effect: { kind: 'send-now-selected', entry: selected, cancelTurn: true } };
}

/** 面板内 `e`：高亮行文本落回 composer 并移出队列（上游 L236「e edits it」） */
function reducePanelEditSelected(state: QueueState, ctx: FollowUpContext): FollowUpReduction {
  const selected = selectedEntry(state, ctx.panel);
  if (selected === undefined) {
    return { state, draftCleared: false, effect: none('面板无高亮行：e 无操作') };
  }
  const { state: next } = removeFollowUpById(state, selected.id);
  return { state: next, draftCleared: false, effect: { kind: 'edit-selected', entry: selected } };
}

/** 面板上下文 → 当前高亮条目（未打开/焦点不在队列/下标越界 = undefined，不猜） */
function selectedEntry(state: QueueState, panel: PanelSelectionContext | undefined): QueuedFollowUp | undefined {
  if (panel?.open !== true || panel.focus !== 'queue') return undefined;
  return state.entries[panel.activeIndex];
}
