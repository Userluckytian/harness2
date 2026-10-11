// B4 对话头组件：每个对话面板顶部一条头——cwd / git 分支 / 模型 / 上下文占用水条。
// 数据经 window.harness2 IPC 获取（渲染进程零 Node）；切换会话时自动重新拉取。
//
// Z2-01b（Z-01 / Z-04）：本头是 ZCode `WorkspaceHeader` 的等价物，右侧动作区承载
//   * Side Pane 开关（右栏开合；ZCode 的默认位置）；
//   * Windows/Linux 自绘窗控三键（mac 走系统红绿灯，不渲染）。
// 简化登记：Z-04 要求「右栏打开时窗控移到 Side Pane 标签栏右侧」，本仓右栏标签栏尚未落地
//   （Z2-04 未做）→ 本期只实现「会话列头右侧」这一处，右栏开合时窗控不迁移。
import { useEffect, useState } from 'react';
import type { ContextUsageShape } from '../../shared/protocol.js';
import { useOptionalFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { desktopPlatform, usesCustomWindowControls } from '../platform.js';
import { useWindowMaximized } from '../window-state.js';

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

/** 右栏（Side Pane）开关图标 */
function SidePaneIcon(): React.ReactNode {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

/** 最小化 */
function MinimizeIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 6h8" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}

/** 最大化 */
function MaximizeIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1" stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}

/** 还原（最大化态） */
function RestoreIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.2" y="3.6" width="6.2" height="6.2" rx="1" stroke="currentColor" strokeWidth={1.2} />
      <path
        d="M4.2 3.6V2.6a1 1 0 0 1 1-1h4.2a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1H9.4"
        stroke="currentColor"
        strokeWidth={1.2}
      />
    </svg>
  );
}

/** 关闭 */
function CloseIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}

interface ConversationHeaderProps {
  sessionId: string;
  cwd?: string;
}

export function ConversationHeader({ sessionId, cwd }: ConversationHeaderProps): React.ReactNode {
  const [branch, setBranch] = useState<string | null>(null);
  const [model, setModel] = useState<string>('');
  const [usage, setUsage] = useState<ContextUsageShape>({ usage: null, label: '—' });
  // Z2-01b：右栏开关经帧上下文（帧外渲染返回 null → 不摆入口，组件级测试不受影响）
  const frame = useOptionalFrame();
  const platform = desktopPlatform();
  const maximized = useWindowMaximized();
  const api = window.harness2;
  // 自绘窗控只在 win/linux 且主进程真的提供通道时渲染（缺通道不摆假按钮）
  const showWindowControls = usesCustomWindowControls(platform) && typeof api?.windowMinimize === 'function';

  // 切换会话 / cwd 时重新拉取
  useEffect(() => {
    let cancelled = false;

    // git 分支（cwd 为 undefined 或空时不请求）
    if (cwd && cwd.length > 0) {
      window.harness2
        .gitBranch(cwd)
        .then((b) => {
          if (!cancelled) setBranch(b);
        })
        .catch(() => {
          if (!cancelled) setBranch(null);
        });
    } else {
      setBranch(null);
    }

    // 模型（全局配置，只需拉一次；但随会话切换也不影响）
    window.harness2
      .settingsGetConfig()
      .then((cfg) => {
        if (!cancelled) {
          const m = cfg.roles?.main?.model;
          setModel(typeof m === 'string' ? m : 'default');
        }
      })
      .catch(() => {
        if (!cancelled) setModel('default');
      });

    // 上下文占用
    window.harness2
      .getContextUsage(sessionId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        if (!cancelled) setUsage({ usage: null, label: '—' });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, cwd]);

  const pct = usageBarPercent(usage.usage);
  const barClass = usageBarClass(usage.usage);

  return (
    <div className="pane-header">
      <span className="pane-header-cwd mono" title={cwd ?? ''}>
        {cwd ?? '(无 cwd)'}
      </span>
      {branch !== null && (
        <span className="pane-header-branch mono" title={branch}>
          <span className="pane-header-branch-icon" aria-hidden>
            ⎇{' '}
          </span>
          {shortBranch(branch)}
        </span>
      )}
      <span className="pane-header-model mono" title={model}>
        {shortModel(model)}
      </span>
      <span className="pane-header-usage" title={`上下文占用 ${usage.label}`}>
        <span className="ctx-bar">
          <span className={barClass} style={{ width: `${pct}%` }} />
        </span>
        <span className="ctx-label mono">{usage.label}</span>
      </span>
      {/* Z-01 / Z-04：右侧动作区 —— Side Pane 开关 +（win/linux）自绘窗控三键 */}
      <span className="pane-header-actions">
        {frame !== null && (
          <button
            type="button"
            className="pane-header-icon-btn"
            aria-label="右栏开关"
            aria-pressed={frame.state.rightbarOpen}
            title={frame.state.rightbarOpen ? '收起右栏' : '打开右栏'}
            onClick={() => frame.dispatch({ type: 'rightbar/toggle' })}
          >
            <SidePaneIcon />
          </button>
        )}
        {showWindowControls && (
          <span className="window-controls" data-testid="window-controls">
            <button
              type="button"
              className="window-controls-btn"
              aria-label="最小化"
              title="最小化"
              onClick={() => void api.windowMinimize?.()}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              className="window-controls-btn"
              aria-label={maximized ? '还原' : '最大化'}
              title={maximized ? '还原' : '最大化'}
              onClick={() => void api.windowToggleMaximize?.()}
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button
              type="button"
              className="window-controls-btn window-controls-close"
              aria-label="关闭"
              title="关闭"
              onClick={() => void api.windowClose?.()}
            >
              <CloseIcon />
            </button>
          </span>
        )}
      </span>
    </div>
  );
}
