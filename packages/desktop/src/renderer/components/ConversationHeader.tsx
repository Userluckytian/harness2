// B4 对话头组件：每个对话面板顶部一条头——cwd / git 分支 / 模型 / 上下文占用水条。
// 数据经 window.harness2 IPC 获取（渲染进程零 Node）；切换会话时自动重新拉取。
import { useEffect, useState } from 'react';
import type { ContextUsageShape } from '../../shared/protocol.js';

/** 上下文占用水条宽度上限百分比（防止溢出） */
const MAX_BAR_PCT = 100;

/** 水条宽度百分比纯函数（便于单测） */
export function usageBarPercent(usage: number | null): number {
  if (usage === null || usage < 0) return 0;
  return Math.min(MAX_BAR_PCT, Math.round(usage * MAX_BAR_PCT));
}

/** 水条 CSS class（usage < 0.7 = ok，>= 0.7 = warn） */
export function usageBarClass(usage: number | null): string {
  if (usage === null || usage < 0.7) return 'ctx-bar-fill ctx-ok';
  return 'ctx-bar-fill ctx-warn';
}

/** 分支简称：去除 "heads/" 前缀（git 输出格式不固定） */
export function shortBranch(branch: string): string {
  return branch.startsWith('heads/') ? branch.slice(6) : branch;
}

/** 模型简称：取最后一段 "/" 后的部分（如 "anthropic/claude-sonnet" → "claude-sonnet"） */
export function shortModel(model: string): string {
  const idx = model.lastIndexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

interface ConversationHeaderProps {
  sessionId: string;
  cwd?: string;
}

export function ConversationHeader({ sessionId, cwd }: ConversationHeaderProps): React.ReactNode {
  const [branch, setBranch] = useState<string | null>(null);
  const [model, setModel] = useState<string>('');
  const [usage, setUsage] = useState<ContextUsageShape>({ usage: null, label: '—' });

  // 切换会话 / cwd 时重新拉取
  useEffect(() => {
    let cancelled = false;

    // git 分支（cwd 为 undefined 或空时不请求）
    if (cwd && cwd.length > 0) {
      window.harness2.gitBranch(cwd).then((b) => {
        if (!cancelled) setBranch(b);
      }).catch(() => { if (!cancelled) setBranch(null); });
    } else {
      setBranch(null);
    }

    // 模型（全局配置，只需拉一次；但随会话切换也不影响）
    window.harness2.settingsGetConfig().then((cfg) => {
      if (!cancelled) {
        const m = cfg.roles?.main?.model;
        setModel(typeof m === 'string' ? m : 'default');
      }
    }).catch(() => { if (!cancelled) setModel('default'); });

    // 上下文占用
    window.harness2.getContextUsage(sessionId).then((u) => {
      if (!cancelled) setUsage(u);
    }).catch(() => { if (!cancelled) setUsage({ usage: null, label: '—' }); });

    return () => { cancelled = true; };
  }, [sessionId, cwd]);

  const pct = usageBarPercent(usage.usage);
  const barClass = usageBarClass(usage.usage);

  return (
    <div className="pane-header">
      <span className="pane-header-cwd mono" title={cwd ?? ''}>{cwd ?? '(无 cwd)'}</span>
      {branch !== null && (
        <span className="pane-header-branch mono" title={branch}>
          <span className="pane-header-branch-icon" aria-hidden>⎇ </span>{shortBranch(branch)}
        </span>
      )}
      <span className="pane-header-model mono" title={model}>{shortModel(model)}</span>
      <span className="pane-header-usage" title={`上下文占用 ${usage.label}`}>
        <span className="ctx-bar">
          <span className={barClass} style={{ width: `${pct}%` }} />
        </span>
        <span className="ctx-label mono">{usage.label}</span>
      </span>
    </div>
  );
}
