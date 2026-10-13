// MessageActions.tsx — P0-1：消息行内动作（对齐 ZCode `ConversationAssistantTextActions`）。
//
// ZCode 权威顺序（refs/ZCode/packages/ui/src/v4/ConversationRowView.tsx:1407-1473，i18n
// zh-CN.ts:4275-4288）：复制 → 赞 → 踩 → 分叉（其后是时间戳）。
// 本仓落地与**如实边界**：
//   * 复制：客户端真实能力（`navigator.clipboard.writeText`）。成功 → 「已复制」，2s 后还原；
//     剪贴板通道缺失/写入失败 → 保持「复制」且不显示已复制（**不假报成功**，红线⑩）。
//   * 赞/踩：**刻意不做**（2026-10-11 用户口径）。本仓无任何后端反馈通道，做了只能是
//     本地内存态（刷新/切会话即丢），等于摆一个假装能用的按钮 —— 与红线⑩「无数据不显示」
//     冲突，故不渲染（ZCode 的赞/踩有服务端反馈语义，我们没有）。相关 state/prop 已删除。
//   * 分叉：由调用方给 `onFork` 才渲染（有 serve `POST /fork` 通道，经既有
//     `controller.forkSession(sessionId, seq)`）；运行中（`forkEnabled=false`）禁用并提示
//     「任务结束后可分叉」（ZCode 同文案）。
//   * 重试 / 编辑 / 恢复：本仓无对应通道 → **不渲染**（不摆死按钮），登记于交付报告。
//
// 显隐：ZCode 完成态动作行 hover 显现。父行 `.bubble-assistant` 通过 CSS 在
// `:hover` / `:focus-within` 时揭示 `.message-actions`（见 shell.css）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckIcon, CopyIcon, GitForkIcon } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { toast } from '../toast/index.js';

/** 「已复制」还原间隔（验收要求 2s；ZCode CopyRowAction 为 1200ms） */
export const COPIED_REVERT_MS = 2000;

/**
 * 复制文本到剪贴板。返回 false = 无剪贴板通道 / 写入失败（调用方据此**不显示**已复制，
 * 不把失败伪装成成功）。空文本直接 false。
 */
export async function copyMessageText(text: string): Promise<boolean> {
  if (text.length === 0) return false;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface MessageActionsProps {
  /** 本行可复制正文（空文本 → 复制按钮禁用） */
  readonly text: string;
  /**
   * 分叉回调（返回 Promise 时动作行显示「正在分叉...」直到落定）。
   * undefined = 本行/本仓无分叉通道 → **不渲染**分叉按钮。
   */
  readonly onFork?: () => void | Promise<void>;
  /** 分叉可用性：false（如会话运行中）→ 禁用 + 「任务结束后可分叉」 */
  readonly forkEnabled?: boolean;
}

export function MessageActions(props: MessageActionsProps): ReactNode {
  const { text } = props;
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const revertTimerRef = useRef<number | null>(null);

  // 卸载时清掉还原定时器（避免对已卸载组件 setState）
  useEffect(
    () => () => {
      if (revertTimerRef.current !== null) window.clearTimeout(revertTimerRef.current);
    },
    [],
  );

  const onCopy = useCallback((): void => {
    void copyMessageText(text).then((ok) => {
      if (!ok) {
        // Z10-8b：原来静默（只不显示「已复制」）→ 现在如实报一条失败通知，
        // 让用户知道是复制没成功，而不是以为点了没反应。
        toast({ kind: 'error', message: '复制失败', detail: '剪贴板不可用或写入被拒绝' });
        return;
      }
      setCopied(true);
      if (revertTimerRef.current !== null) window.clearTimeout(revertTimerRef.current);
      revertTimerRef.current = window.setTimeout(() => {
        revertTimerRef.current = null;
        setCopied(false);
      }, COPIED_REVERT_MS);
    });
  }, [text]);

  const onFork = (): void => {
    if (props.onFork === undefined || props.forkEnabled === false || forking) return;
    setForking(true);
    void Promise.resolve(props.onFork()).finally(() => setForking(false));
  };

  const copyLabel = copied ? '已复制' : '复制';
  const forkLabel = forking ? '正在分叉...' : '分叉';
  const forkDisabled = props.forkEnabled === false || forking;

  return (
    <div className="message-actions" data-testid="message-actions">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="message-action-copy"
        data-copied={copied ? 'true' : 'false'}
        aria-label={copyLabel}
        title={copyLabel}
        disabled={text.length === 0}
        onClick={onCopy}
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      </Button>
      {props.onFork !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="message-action-fork"
          data-fork-enabled={props.forkEnabled === false ? 'false' : 'true'}
          aria-label={forkLabel}
          title={props.forkEnabled === false ? '任务结束后可分叉' : forkLabel}
          disabled={forkDisabled}
          onClick={onFork}
        >
          <GitForkIcon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
