// selection-ask.tsx — 转录划词「询问」浮层（Z4-03；ZCode `selection-side-chat` 的等价物入口）。
//
// 语义参照（docs/refs/refs-zcode-layout.md Z-14 `selection-side-chat` + refs-zcode.md Z-94
// 「四类上下文 chip：…对话选区」）：ZCode 划词后「Ask in side chat」把选区作为上下文发给
// agent。我们没有独立 side-chat 通道（刻意差异，登记在案）——等价物 = 选区引用块预填主
// composer。本组件只负责**入口的显隐与定位**：
//   出现：在 user / assistant 气泡内完成一次鼠标拖选、松开鼠标（mouseup）且选区有可引用
//         文本 → 浮动「询问」按钮出现在选区附近（fixed 定位，视口内夹取）；
//   消失：点击别处（mousedown 在按钮外）、滚动（捕获阶段任一滚动）、选区塌缩
//         （selectionchange）。
// 交互粒度：只认**单个气泡内**的选区（range.commonAncestorContainer 的最近
// `data-quote-origin` 祖先）——跨气泡的选择没有单一来源行类型，如实不出现入口。
// Z-94 的对话选区 chip 在 ZCode 是 composer 的结构化上下文；我们落成纯文本引用块
// （`对话选区（用户消息）` + `>` 逐行前缀，shared/quote-block），chip 形态待 atoms 层
// 有「来源」维度后再升级（登记，不伪造）。
//
// D-14：显隐状态全内存（组件 state），不落任何存储。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { buildTranscriptQuote, type TranscriptQuoteOrigin } from '../../shared/quote-block.js';
import { composerPrefill } from '../conversation/composer/prefill.js';

/** 气泡上的来源标记（ChatItemView 渲染时写入；本组件按它辨认可引用行） */
export const QUOTE_ORIGIN_ATTR = 'data-quote-origin';

/** 划词目标：来源行类型 + 选中文本 + 选区末端视口矩形（定位用） */
export interface SelectionAskTarget {
  readonly origin: TranscriptQuoteOrigin;
  readonly text: string;
  /**
   * 选区首矩形（getBoundingClientRect 的投影）。jsdom 无 Range 几何 → 全 0（如实缺省，
   * 定位只在真机有意义）；真机上若矩形不可测（全 0）按钮退到左上角，仍可用。
   */
  readonly rect: { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number };
}

/**
 * 从当前 Selection 折出划词目标（纯 DOM 读函数，jsdom 可测）。
 * `scope` 给定时，选区必须落在 scope 子树内（Z2-06 分屏：每格转录各自一个浮层，
 * 只认自己容器里的选区 —— 否则跨格误报、点错会话）。
 * 返回 null 的情形：无选区 / 已塌缩 / 选区文本全空白 / 锚点不在可引用气泡内 / 越出 scope。
 */
export function selectionAskTarget(selection: Selection | null, scope?: Element | null): SelectionAskTarget | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (text.trim().length === 0) return null;
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
  const bubble = element?.closest(`[${QUOTE_ORIGIN_ATTR}]`);
  const origin = bubble?.getAttribute(QUOTE_ORIGIN_ATTR);
  if (origin !== 'user' && origin !== 'assistant') return null;
  // scope 给定时必须命中其子树（Z2-06 分屏：不误报别的格子的会话）；未给 scope 不限制
  if (scope !== null && scope !== undefined && (bubble === null || bubble === undefined || !scope.contains(bubble))) {
    return null;
  }
  return { origin, text, rect: rangeRect(range) };
}

/** Range 视口矩形投影；环境无 Range 几何（jsdom）→ 全 0（不抛错、不伪造坐标） */
function rangeRect(range: Range): SelectionAskTarget['rect'] {
  if (typeof range.getBoundingClientRect !== 'function') {
    return { top: 0, left: 0, bottom: 0, right: 0 };
  }
  const box = range.getBoundingClientRect();
  return { top: box.top, left: box.left, bottom: box.bottom, right: box.right };
}

/**
 * 划词「询问」浮层（挂进 ChatTranscript；无会话约束 —— 转录本身只在有会话时渲染）。
 * `containerRef` = 本转录根（Z2-06 分屏作用域：只对本格转录内的选区响应）；
 * `sessionId` = 当前转录的会话；点击 → 引用块经预填通道进该会话 composer（焦点随行）。
 */
export function SelectionAskLayer({
  sessionId,
  containerRef,
}: {
  readonly sessionId: string;
  readonly containerRef?: { readonly current: Element | null };
}): ReactNode {
  const [target, setTarget] = useState<SelectionAskTarget | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const insideButton = (e: MouseEvent): boolean =>
      buttonRef.current !== null && e.target instanceof Node && buttonRef.current.contains(e.target);
    // 松开鼠标：评估当前选区（按钮自己的 mouseup 跳过 —— 那次释放属于点击，不该重算）
    const onMouseUp = (e: MouseEvent): void => {
      if (insideButton(e)) return;
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
      setTarget(selectionAskTarget(selection, containerRef?.current ?? undefined));
    };
    // 点击别处即消失（点按钮本身除外 —— 否则 click 还没来按钮先没了）
    const onMouseDown = (e: MouseEvent): void => {
      if (insideButton(e)) return;
      setTarget(null);
    };
    // 选区塌缩（程序性清除 / 键盘取消选区）即收
    const onSelectionChange = (): void => {
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (selection === null || selection.isCollapsed) setTarget(null);
    };
    // 滚动即消失（捕获：转录滚动叶与任何内层滚动都算）
    const onScroll = (): void => {
      setTarget(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [containerRef]);

  if (target === null) return null;
  // 定位：选区末端下方 6px；越出视口时夹取（jsdom 全 0 矩形 → 退到 8px，可用优先）
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  const top = target.rect.bottom > 0 ? Math.min(target.rect.bottom + 6, Math.max(viewportHeight - 44, 8)) : 8;
  const left = target.rect.right > 0 ? Math.min(target.rect.left, Math.max(viewportWidth - 88, 8)) : 8;

  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid="selection-ask"
      className="fixed z-50 cursor-pointer rounded-md border bg-popover px-2 py-1 text-ui-xs text-foreground shadow-md hover:bg-surface-hover"
      style={{ top, left }}
      // 防止按下按钮时清掉文档选区（target 已在 mouseup 捕获，这里双保险）
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const quote = buildTranscriptQuote({ origin: target.origin, text: target.text });
        setTarget(null);
        if (quote !== null) composerPrefill.request({ sessionId, quote, focus: true });
      }}
    >
      询问
    </button>
  );
}
