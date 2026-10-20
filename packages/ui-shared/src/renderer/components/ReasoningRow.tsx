// ReasoningRow.tsx — Z-92：思考块一等行（触发行 + 内容区两段式）。
//
// 对齐 docs/refs/refs-zcode.md Z-92 的 `reasoning` 行规格：
//   - 独立可折叠行（不再是 assistant 气泡的内嵌 <details>）；
//   - 流式时触发行「正在思考」用渐变扫光（背景裁切文字 + background-position 动画；
//     色值只在 --color-foreground 与 --color-foreground-subtlest 之间过渡，不新增 token）；
//   - 完成态显示「思考 · 持续了 N 秒」——**本仓没有思考时长数据源**（store.attempts 无时间戳、
//     协议无 reasoning 开始/结束事件，见 Z3-02 交付说明），故按「不臆造协议外数据」只显示「思考」；
//   - 内容区 max-h 限高 + 纵向滚动 + 纯文本（不解析 Markdown）；收起后 ~300ms 延迟卸载；
//   - 流式时在触发行下方显示思考文本**最后一行**的摘要（超宽单行向左溢出、两端渐隐）；
//   - 默认折叠；唯一的自动折叠发生在「流式 → 完成」转换处，且不覆盖用户已做的手动开合。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';

/** 收起后内容延迟卸载间隔（Z-92：~300ms；略高于内容淡出动画时长，避免动画被截断） */
const COLLAPSE_UNMOUNT_DELAY_MS = 300;

/** 取思考文本最后一行非空内容（流式摘要行数据源；全是空行 → ''） */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line;
  }
  return '';
}

/**
 * 思考块一等行。流式（`streaming`）与完成态共用同一组件：
 * 流式条目落盘为 assistant 消息时会重挂载为完成态行 —— 那次重挂载本身就是
 * 「流式 → 完成」的一次自动折叠（重挂载后回到默认折叠）。
 */
export function ReasoningRow({ text, streaming }: { text: string; streaming?: boolean }): ReactNode {
  const isStreaming = streaming === true;
  const [open, setOpen] = useState(false);
  const [contentMounted, setContentMounted] = useState(false);
  /** 用户手动开合过（此后同实例内不再被自动折叠覆盖） */
  const userToggledRef = useRef(false);
  /** 「流式 → 完成」的自动折叠只执行一次 */
  const autoCollapsedRef = useRef(false);
  const prevStreamingRef = useRef(isStreaming);
  const unmountTimerRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 唯一的自动折叠：状态从流式转完成时执行一次；用户已手动开合则尊重用户选择。
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && !userToggledRef.current && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setOpen(false);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // 展开即挂载内容；收起后延迟卸载（期间淡出动画可见）。
  useEffect(() => {
    if (open) {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      setContentMounted(true);
      return undefined;
    }
    unmountTimerRef.current = window.setTimeout(() => {
      unmountTimerRef.current = null;
      setContentMounted(false);
    }, COLLAPSE_UNMOUNT_DELAY_MS);
    return () => {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [open]);

  // 流式 + 展开：内容贴底滚动，最新思考始终可见。
  useEffect(() => {
    if (open && isStreaming && contentRef.current !== null) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [text, open, isStreaming]);

  const toggle = (): void => {
    userToggledRef.current = true;
    setOpen((v) => !v);
  };

  // 流式摘要行：最新一行非空思考；完成后不再显示（完成内容以正文与展开区为准）。
  const tail = isStreaming ? lastNonEmptyLine(text) : '';

  return (
    <div
      className="self-start"
      data-testid="reasoning-row"
      data-state={isStreaming ? 'streaming' : 'complete'}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        aria-expanded={open}
        data-testid="reasoning-toggle"
        onClick={toggle}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-ui-caption text-foreground-subtle transition-colors hover:text-foreground"
      >
        <ChevronRightIcon size={12} aria-hidden className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={isStreaming ? 'reasoning-shimmer-text' : undefined}>{isStreaming ? '正在思考' : '思考'}</span>
      </button>
      {tail.length > 0 && (
        <div
          className="reasoning-tail-mask overflow-hidden text-ui-xs text-foreground-subtlest"
          data-testid="reasoning-tail"
          aria-hidden
        >
          {/* justify-end + 不收缩内容：超宽时溢出被裁在左端（起点），右端（最新内容）始终可见 */}
          <div className="flex justify-end">
            <span className="flex-none whitespace-nowrap">{tail}</span>
          </div>
        </div>
      )}
      {contentMounted && (
        <div
          ref={contentRef}
          data-testid="reasoning-content"
          className={`max-h-60 overflow-y-auto border-l border-border pl-2 text-ui-sm whitespace-pre-wrap text-foreground-subtle duration-300 ${
            open ? 'animate-in fade-in slide-in-from-top-1' : 'animate-out fade-out'
          }`}
        >
          {text}
        </div>
      )}
    </div>
  );
}
