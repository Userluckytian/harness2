// ChatEmptyState.tsx — Z-18 草稿空态 + Z-17 空态显隐对齐。
//
// 对齐 docs/refs/refs-zcode-layout.md Z-18：isDraft（会话还没有任何条目）时 Timeline 的
// 空态 = **按时段问候语**（边界 5/9/12/14/18/23 点）+ 品牌 Logo 水印（大号、低对比度）；
// 配套的 composer 下方建议提示（SuggestionChips）由会话席位（conversation/seat）在
// composer 之下渲染 —— 两者共同构成空态，空态之外「有会话才有意义」的区块一律不渲染。
//
// 诚实口径：
//   - 建议 chip 的文本是**会被真实提交**的提示词（点击 = 写入 composer 草稿，由用户 Enter 提交，
//     走既有提交边界：@引用解析 / 附件 / ack 三态一个不少）；没有任何摆设性假 chip。
//   - 本仓没有「显示思考过程」设置项，也不在此摆假设置。
import type { ReactNode } from 'react';

/**
 * 按时段问候语（Z-18 边界：5/9/12/14/18/23 点）。
 * [23,5) 深夜 · [5,9) 早晨 · [9,12) 上午 · [12,14) 中午 · [14,18) 下午 · [18,23) 晚间。
 */
export function chatGreetingForHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 23 || h < 5) return '夜深了，灵感却正清醒';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** 品牌 Logo 水印（大号、低对比度；纯内联 SVG，不引外部资源；装饰性 aria-hidden） */
function BrandWatermark(): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2" aria-hidden>
      {/* 终端提示符徽标：圆角方框 + `>` + 光标条，尺寸用几何宽高（不受 text-ui-* 字号约束） */}
      <svg width="104" height="104" viewBox="0 0 104 104" fill="none" className="text-foreground-subtlest opacity-80">
        <rect x="6" y="6" width="92" height="92" rx="22" stroke="currentColor" strokeWidth="5" />
        <path
          d="M30 34 L50 52 L30 70"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M58 72 L78 72" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
      </svg>
      <span className="text-ui-xl tracking-[0.35em] text-foreground-subtlest">harness2</span>
    </div>
  );
}

/**
 * 空态正文（Timeline 的 emptyState）：Logo 水印 + 时段问候 + 引导语。
 * `now` 注入便于测试；生产缺省取当前时间。
 */
export function ChatEmptyState({ now = new Date() }: { now?: Date }): ReactNode {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center gap-4 py-16" data-testid="chat-empty">
      <BrandWatermark />
      <p className="text-ui-lg text-foreground" data-testid="chat-empty-greeting">
        {chatGreetingForHour(now.getHours())}
      </p>
      <p className="text-ui-caption text-foreground-subtlest">发送第一条消息开始对话</p>
    </div>
  );
}

/** 建议提示（点击后写入 composer 草稿、由用户提交的真实提示词；都是对本仓可执行的问题） */
export interface SuggestedPrompt {
  readonly label: string;
  readonly prompt: string;
}

export const SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    label: '解释会话事件模型',
    prompt:
      '请解释 packages/core 的会话事件模型：SessionEvent、delta 水位与重放合并如何协作？渲染端需要保证哪些不变量？',
  },
  {
    label: '审查渲染端数据流',
    prompt: '请审查 packages/ui-shared 从事件缓冲到渲染的数据流，指出状态一致性与竞态方面的风险，并按严重程度排序。',
  },
  {
    label: '补一份 provider 迁移方案',
    prompt:
      '请为 harness2 补一份 provider 迁移方案：从 mock provider 切换到真实 LLM provider，列出阶段划分、契约边界与验收标准。',
  },
  {
    label: '对比桌面与 Web 壳差异',
    prompt: '请对比 desktop 与 web 两个壳在会话装配、composer 接线与能力注入缝上的差异，并指出哪些缺口是如实登记的。',
  },
];

/**
 * composer 下方的建议提示（Z-18 配套；Z-17 的 DraftSuggestedPrompts 位置语义）。
 * `onPick` 由席位注入（写入 composer 草稿）；没给回调时本组件不渲染（不摆无效 chip）。
 */
export function SuggestionChips({
  prompts = SUGGESTED_PROMPTS,
  onPick,
}: {
  prompts?: readonly SuggestedPrompt[];
  onPick?: (prompt: string) => void;
}): ReactNode {
  if (onPick === undefined || prompts.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-4 pb-2"
      data-testid="suggested-prompts"
      aria-label="建议提示"
    >
      <span className="text-ui-2xs text-foreground-subtlest">试着问：</span>
      {prompts.map((p) => (
        <button
          key={p.label}
          type="button"
          data-testid="suggested-prompt"
          title={p.prompt}
          className="rounded-full border border-border bg-card px-2.5 py-0.5 text-ui-caption text-foreground-subtle transition-colors hover:border-border-hover hover:bg-hover hover:text-foreground"
          onClick={() => onPick(p.prompt)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
