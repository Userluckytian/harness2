// 渲染层错误边界：任何渲染/生命周期异常不再导致「整页白屏」，而是显示可读错误 + 重试/重载。
// 便于用户把具体报错发回定位（否则白屏无信息）。
// Z-46：fallback 也挂常驻窗控 overlay（win/linux；mac/web 返回 null）——错误页不困住窗口，
// 用户仍能最小化/最大化/关闭（ZCode 的 ErrorBoundary 是已知缺口，这里按其 §Z-46「复刻时补上」执行）。
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { WindowControlsOverlay } from './components/WindowControls.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 本地日志（渲染进程 console；用户可复制发回）
    console.error('[harness2 renderer] render error', error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          style={{
            position: 'relative',
            padding: 24,
            // D6（2026-10-11）：与 shell.css / ZCode 的 body 字体栈对齐（保留中文回退）。
            fontFamily:
              'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
            color: '#3B2E21',
            background: '#F6EFE3',
            minHeight: '100%',
          }}
        >
          <h2 style={{ marginTop: 0 }}>界面渲染出错</h2>
          <p>harness2 客户端遇到一个渲染错误：</p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '40vh',
              overflow: 'auto',
              background: '#FFFCF6',
              border: '1px solid #E6D9C3',
              borderRadius: 8,
              padding: 12,
            }}
          >
            {this.state.error.message}
          </pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              重载应用
            </button>
          </div>
          {/* Z-46：错误页也不困住窗口——常驻窗控 overlay（win/linux + 有通道才渲染；
              样式随 main.tsx 全局引入 desktop-window.css，边界触发时已就位）。 */}
          <WindowControlsOverlay />
        </div>
      );
    }
    return this.props.children;
  }
}
