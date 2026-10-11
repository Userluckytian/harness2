// Z-90 FontSizeInput：界面字号数字输入（w-28、右对齐 tabular-nums、右侧固定 px 后缀）。
// 交互契约（Z-90）：范围 [min, max]（界面字号 12–20，默认 14）；失焦 / Enter 提交；Esc 还原；
// 原生步进器隐藏（appearance:textfield + webkit spin buttons appearance-none）。
// 本原语只管「输入 → 提交回调」，不碰 DOM 根变量、不碰存储（生效与持久化由宿主负责）。
import * as React from 'react';

import { cn } from '@/lib/utils';

/** 数字草稿 → 提交值；不可解析（NaN/空）返回 null（由调用方决定还原） */
function parseDraft(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface FontSizeInputProps extends Omit<
  React.ComponentProps<'input'>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'size'
> {
  /** 已提交值（受控；草稿由内部维护） */
  readonly value: number;
  /** 提交（失焦 / Enter）；实参已钳制进 [min, max] */
  readonly onCommit: (value: number) => void;
  /** 下界（缺省 12） */
  readonly min?: number;
  /** 上界（缺省 20） */
  readonly max?: number;
  /** 后缀文案（缺省 'px'） */
  readonly suffix?: string;
}

export function FontSizeInput({
  value,
  onCommit,
  min = 12,
  max = 20,
  suffix = 'px',
  className,
  'aria-label': ariaLabel,
  disabled,
  ...rest
}: FontSizeInputProps): React.ReactNode {
  const [draft, setDraft] = React.useState<string>(() => String(value));
  // 最近一次提交值（回调去重的真源）：宿主未回写 value 前重复提交同值不重复回调
  const lastCommittedRef = React.useRef(value);
  // 外部受控值变化（含宿主回写 / 提交后受控回显）→ 草稿同步到已提交值
  React.useEffect(() => {
    lastCommittedRef.current = value;
    setDraft(String(value));
  }, [value]);

  const clamp = (n: number): number => Math.min(max, Math.max(min, n));

  /** 提交：解析 + 钳制；不可解析 → 还原为当前已提交值（不提交、不造值） */
  const commit = (): void => {
    const parsed = parseDraft(draft);
    if (parsed === null) {
      setDraft(String(lastCommittedRef.current));
      return;
    }
    const next = clamp(parsed);
    setDraft(String(next));
    if (next !== lastCommittedRef.current) {
      lastCommittedRef.current = next;
      onCommit(next);
    }
  };

  const restore = (): void => {
    setDraft(String(lastCommittedRef.current));
  };

  return (
    <div
      data-slot="font-size-input"
      className={cn(
        'flex h-7 w-28 items-center rounded-md border border-input-border bg-input px-2 transition-colors',
        'hover:border-input-border-hover focus-within:border-input-border-focused',
        disabled && 'pointer-events-none opacity-45',
        className,
      )}
    >
      <input
        {...rest}
        type="number"
        data-slot="font-size-input-field"
        aria-label={ariaLabel}
        disabled={disabled}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          commit();
          rest.onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            restore();
          }
          rest.onKeyDown?.(e);
        }}
        className={cn(
          'w-full min-w-0 bg-transparent text-right text-ui-base tabular-nums text-foreground outline-none',
          'placeholder:text-foreground-subtlest disabled:cursor-not-allowed',
          // 隐藏原生步进器（Z-90）：标准 appearance + webkit 内外 spin buttons
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        )}
      />
      <span data-slot="font-size-input-suffix" className="pl-1 text-ui-sm text-foreground-subtlest select-none">
        {suffix}
      </span>
    </div>
  );
}
