// 右栏文件文本预览（D-86 ① 的**消费端**：`openFile` 路由的落点）。
//
// 定位：D-76（`ui-sidebar-documentpreview`）尚未装配前的过渡实现 —— 只做「按路径读文本并如实显示」：
//   读取通道 = 宿主能力端口 `HostBridge.readFileForRef`（桌面 = preload IPC；web = serve HTTP）；
//   主进程/服务端侧有 cwd 半径边界校验 + 64KB 截断 → 越界/截断/失败都**如实显示**，不假装成功。
//   Markdown/PDF/HTML 分页渲染、`dsh-resource://` 资源模型属 D-76，落地后本组件让位移交。
//
// 只读、无副作用：不写文件、不落浏览器存储。
//
// Z4-02（文件行内评论）：文本预览的整行 hover → 行号槽位出现「评论」入口，点击把该行
// 以引用块（`路径:行号` + `> 行文本`，shared/quote-block）交还宿主预填 composer。
// 交互粒度（刻意选择，见实现计划）：**行级**（整行 hover + 行号槽位入口），不做文本级
// 选区 —— 文件 tab 是只读预览非编辑器，行号是预览自带的稳定坐标，文本级选区属 D-76
// 编辑器形态的范畴；跨行引用由 `buildFileQuote` 的行号区间能力预留（本期入口只发单行）。
// 入口显隐：`onQuote` 缺省 = 宿主无可预填目标（无会话）→ 整个文件不渲染入口（红线⑩）；
// 空白行同样无入口（无可引用内容）。
import { useEffect, useState } from 'react';
import type { ToolFilePreview } from './tool-navigation.js';
import { useHostBridge } from '../host-bridge.js';
import { buildFileQuote } from '../../shared/quote-block.js';

/** 读取结果（与宿主 `readFileForRef` 同形） */
export interface FilePreviewReadResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

/** 读取通道（测试注入；缺省走宿主能力端口 `HostBridge.readFileForRef`） */
export type FilePreviewReader = (path: string, cwd: string) => Promise<FilePreviewReadResult>;

export interface ToolFilePreviewProps {
  /** 待预览文件（null = 尚未打开任何文件） */
  readonly preview: ToolFilePreview | null;
  /** 读取边界（`readFileForRef` 的 cwd；缺省空串 → 壳用 serve root 兜底） */
  readonly cwd?: string;
  /** 读取通道（缺省 = 宿主能力端口；端口也没有 → 如实报「此壳未提供文件读取通道」） */
  readonly readFile?: FilePreviewReader;
  /** 清空预览（宿主回收；缺省不渲染清空入口） */
  readonly onClear?: () => void;
  /**
   * Z4-02：行级评论回调（参数 = 构造好的引用块文本）。缺省 = 不渲染行评论入口
   * （宿主无可预填目标时如实不摆入口 —— 红线⑩；预填落点由宿主接 composer 预填通道）。
   */
  readonly onQuote?: (quote: string) => void;
}

export function ToolFilePreviewPanel({
  preview,
  cwd,
  readFile,
  onClear,
  onQuote,
}: ToolFilePreviewProps): React.ReactNode {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = useHostBridge();

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
    const reader: FilePreviewReader | undefined =
      readFile ?? (bridge?.readFileForRef ? (p, c) => bridge.readFileForRef!(p, c) : undefined);
    setContent(null);
    setError(null);
    setTruncated(false);
    if (reader === undefined) {
      // 该壳没有文件读取通道：如实说明，不假装加载中
      setError('此壳未提供文件读取通道（HostBridge.readFileForRef 缺失）');
      return;
    }
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
  }, [path, cwd, readFile, bridge]);

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
          {lines.map((text, i) => {
            const lineNo = i + 1;
            // 空白行无可引用内容 → 不摆入口（红线⑩的「无可引用内容」分支）
            const quotable = onQuote !== undefined && text.trim().length > 0;
            return (
              <div
                key={i}
                className={`file-preview-row group/row${line === lineNo ? ' file-preview-row-hit' : ''}`}
                data-line={lineNo}
              >
                <span className="file-preview-gutter relative inline-block min-w-[2.5rem] pr-2 text-right select-none">
                  {lineNo}
                  {quotable && (
                    <button
                      type="button"
                      // 行号槽位入口：整行 hover（或键盘聚焦）才显现，覆盖行号不挤压行布局
                      className="absolute inset-0 hidden rounded-sm bg-background text-center text-ui-xs leading-[1.4rem] text-foreground-subtle group-focus-within/row:block group-hover/row:block hover:bg-surface-hover hover:text-foreground"
                      data-file-preview-quote={lineNo}
                      title={`引用第 ${lineNo} 行到对话输入`}
                      onClick={() => {
                        if (onQuote === undefined) return;
                        const quote = buildFileQuote({ path: preview.path, lines, startLine: lineNo });
                        if (quote !== null) onQuote(quote);
                      }}
                    >
                      评论
                    </button>
                  )}
                </span>
                <span className="file-preview-text">{text}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}
