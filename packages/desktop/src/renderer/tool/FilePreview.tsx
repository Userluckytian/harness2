// 右栏文件文本预览（D-86 ① 的**消费端**：`openFile` 路由的落点）。
//
// 定位：D-76（`ui-sidebar-documentpreview`）尚未装配前的过渡实现 —— 只做「按路径读文本并如实显示」：
//   读取通道 = preload 既有 IPC `readFileForRef(path, cwd)`（渲染进程零 Node，不碰文件系统）；
//   主进程侧有 cwd 半径边界校验 + 64KB 截断 → 越界/截断/失败都**如实显示**，不假装成功。
//   Markdown/PDF/HTML 分页渲染、`dsh-resource://` 资源模型属 D-76，落地后本组件让位移交。
//
// 只读、无副作用：不写文件、不落浏览器存储。
import { useEffect, useState } from 'react';
import type { ToolFilePreview } from './tool-navigation.js';

/** 读取结果（与 preload `readFileForRef` 同形） */
export interface FilePreviewReadResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

/** 读取通道（测试注入；缺省走 preload 的既有 IPC） */
export type FilePreviewReader = (path: string, cwd: string) => Promise<FilePreviewReadResult>;

const defaultReader: FilePreviewReader = (path, cwd) => window.harness2.readFileForRef(path, cwd);

export interface ToolFilePreviewProps {
  /** 待预览文件（null = 尚未打开任何文件） */
  readonly preview: ToolFilePreview | null;
  /** 读取边界（`readFileForRef` 的 cwd；缺省空串 → 主进程用 serve root 兜底） */
  readonly cwd?: string;
  /** 读取通道（缺省 = window.harness2.readFileForRef） */
  readonly readFile?: FilePreviewReader;
  /** 清空预览（宿主回收；缺省不渲染清空入口） */
  readonly onClear?: () => void;
}

export function ToolFilePreviewPanel({ preview, cwd, readFile, onClear }: ToolFilePreviewProps): React.ReactNode {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = preview?.path ?? null;
  const line = preview?.line;

  useEffect(() => {
    if (path === null) {
      setContent(null);
      setError(null);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    const reader = readFile ?? defaultReader;
    setContent(null);
    setError(null);
    setTruncated(false);
    void reader(path, cwd ?? '')
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setContent(res.content ?? '');
          setTruncated(res.truncated === true);
        } else {
          setError(res.error ?? '读取失败');
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwd, readFile]);

  if (preview === null) {
    return (
      <div className="file-preview file-preview-empty" data-file-preview="empty">
        <p className="settings-desc">尚未打开文件：点工具卡里的「打开文件」</p>
      </div>
    );
  }

  const lines = content === null ? [] : content.split('\n');

  return (
    <div className="file-preview" data-file-preview="open" data-file-path={preview.path}>
      <div className="file-preview-head">
        <span className="file-preview-path" title={preview.path}>
          {preview.path}
        </span>
        {line !== undefined && <span className="file-preview-line">第 {line} 行</span>}
        {truncated && <span className="file-preview-truncated">已截断（64KB 上限）</span>}
        {onClear !== undefined && (
          <button type="button" className="file-preview-clear" onClick={onClear}>
            关闭预览
          </button>
        )}
      </div>
      {error !== null && <p className="settings-warn">{error}</p>}
      {content === null && error === null && <p className="settings-desc">加载中…</p>}
      {content !== null && (
        <pre className="file-preview-body">
          {lines.map((text, i) => (
            <div
              key={i}
              className={`file-preview-row${line === i + 1 ? ' file-preview-row-hit' : ''}`}
              data-line={i + 1}
            >
              <span className="file-preview-gutter">{i + 1}</span>
              <span className="file-preview-text">{text}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
