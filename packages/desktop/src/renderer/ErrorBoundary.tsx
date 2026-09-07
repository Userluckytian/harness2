// 渲染层错误边界：任何渲染/生命周期异常不再导致「整页白屏」，而是显示可读错误 + 重试/重载。
// 便于用户把具体报错发回定位（否则白屏无信息）。
import { Component, type ErrorInfo, type ReactNode } from 'react';

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
            padding: 24,
            fontFamily: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
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
        </div>
      );
    }
    return this.props.children;
  }
}
