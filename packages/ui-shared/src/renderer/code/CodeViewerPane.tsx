// 代码查看器 pane（Z10-7）：数据 + 偏好装配层。
//
// 职责（与呈现层 ./CodeViewer.tsx 分离）：
//   1. 读文件内容 —— 通道 = 注入的 readFile，缺省回落宿主能力端口 `HostBridge.readFileForRef`
//      （桌面 = preload IPC；web = serve HTTP / 无此通道）。**读不到就如实显示原因**（红线⑩：
//      不摆假代码）；本壳没有读取通道 → 明说「本壳无文件读取通道」。
//   2. 读代码偏好（主题 / 行号 / 换行 / 字号）+ 解析当前界面明暗下**生效**的代码主题 ——
//      设置卡的改动经共享运行时 store 即时被这里消费（否则就是死设置）。
//   3. 头部（路径 / 截断提示 / 关闭入口）+ 交给 CodeViewer 渲染。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useHostBridge } from '../host-bridge.js';
import { detectCodeLanguage } from './code-theme.js';
import { useActiveCodeThemeId, useCodePreferences } from './code-preferences.js';
import { CodeViewer } from './CodeViewer.js';

/** 读取结果（与宿主 readFileForRef 同形） */
export interface CodeViewerReadResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

/** 读取通道（测试注入；缺省走宿主能力端口） */
export type CodeViewerReader = (path: string, cwd: string) => Promise<CodeViewerReadResult>;

export interface CodeViewerPaneProps {
  /** 待查看文件（null = 尚未打开任何文件） */
  readonly path: string | null;
  /** 读取边界（readFileForRef 的 cwd；缺省空串 → 壳用 serve root 兜底） */
  readonly cwd?: string;
  /** 读取通道（缺省 = 宿主能力端口；端口也没有 → 如实报「本壳无文件读取通道」） */
  readonly readFile?: CodeViewerReader;
  /** 清空目标（宿主回收；缺省不渲染关闭入口） */
  readonly onClear?: () => void;
}

export function CodeViewerPane({ path, cwd, readFile, onClear }: CodeViewerPaneProps): ReactNode {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const bridge = useHostBridge();
  const prefs = useCodePreferences();
  const themeId = useActiveCodeThemeId();

  useEffect(() => {
    if (path === null) {
      setContent(null);
      setError(null);
      setTruncated(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const reader: CodeViewerReader | undefined =
      readFile ?? (bridge?.readFileForRef ? (p, c) => bridge.readFileForRef!(p, c) : undefined);
    setContent(null);
    setError(null);
    setTruncated(false);
    if (reader === undefined) {
      // 该壳没有文件读取通道：如实说明（不假装加载中、不摆假代码）
      setLoading(false);
      setError('本壳无文件读取通道（HostBridge.readFileForRef 缺失）');
      return;
    }
    setLoading(true);
    void reader(path, cwd ?? '')
      .then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (res.ok) {
          setContent(res.content ?? '');
          setTruncated(res.truncated === true);
        } else {
          setError(res.error ?? '读取失败');
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLoading(false);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwd, readFile, bridge]);

  if (path === null) {
    return (
      <div className="code-viewer-pane p-3" data-code-viewer="empty">
        <p className="settings-desc">尚未打开文件：在「变更」面板点文件名即可在此查看。</p>
      </div>
    );
  }

  return (
    <div className="code-viewer-pane flex h-full min-h-0 flex-col" data-code-viewer="open" data-code-path={path}>
      <div className="flex flex-none items-center gap-2 border-b px-3 py-1.5 text-ui-sm">
        <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={path}>
          {path}
        </span>
        {truncated && <span className="flex-none text-ui-xs text-foreground-subtlest">已截断（64KB 上限）</span>}
        {onClear !== undefined && (
          <button
            type="button"
            className="flex-none cursor-pointer rounded px-1.5 py-0.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            data-code-viewer-clear
            onClick={onClear}
          >
            关闭
          </button>
        )}
      </div>
      {error !== null && (
        <p className="settings-warn px-3 py-2" data-code-viewer-error>
          {error}
        </p>
      )}
      {loading && <p className="settings-desc px-3 py-2">加载中…</p>}
      {content !== null && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeViewer
            content={content}
            language={detectCodeLanguage(path)}
            themeId={themeId}
            lineNumbers={prefs.lineNumbers}
            wordWrap={prefs.wordWrap}
            fontSize={prefs.fontSize}
          />
        </div>
      )}
    </div>
  );
}
