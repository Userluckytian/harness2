// 检查器（D-44）：选中记录的**局部**检查器（就地展开，不弹窗、不新开路由）。
//
// 字段：token 用量 / 耗时 / 输入 / 输出 / 计时 / 图片与文件附件摘要。
// 缺数据一律显示「未记录」「无」——不显示 0 或空行（诚实性口径与 D-47 同源）。
import type { ReactNode } from 'react';
import type { SessionImageUrlResolver } from '@harness2/ui-shared/renderer/conversation/views/image-url-cache.js';
import type { TrajectoryInspectorView } from './inspector.js';
import type { TrajectoryAttachment } from './types.js';

export interface InspectorPanelProps {
  /** 由 `deriveInspectorForRow` 得到；null = 未选中任何可选记录 */
  readonly view: TrajectoryInspectorView | null;
  readonly onClose?: () => void;
  /** D-39：图片 URL 解析器（与 Chat 视图共用缓存；无 → 缩略图位置显示「无图」） */
  readonly imageUrl?: SessionImageUrlResolver;
  readonly title?: string;
}

export function InspectorPanel(props: InspectorPanelProps): ReactNode {
  const { view, onClose, imageUrl, title = '检查器' } = props;

  if (view === null) {
    return (
      <aside className="trajectory-inspector" data-testid="trajectory-inspector" data-empty="true">
        <header className="trajectory-inspector-head">
          <span className="trajectory-inspector-title">{title}</span>
        </header>
        <p className="trajectory-inspector-empty">选中一条记录查看 token 用量、耗时、输入输出与附件摘要</p>
      </aside>
    );
  }

  return (
    <aside
      className="trajectory-inspector"
      data-testid="trajectory-inspector"
      data-empty="false"
      data-inspector-key={view.key}
      data-role={view.role}
      data-state={view.state}
    >
      <header className="trajectory-inspector-head">
        <span className="trajectory-inspector-title">{title}</span>
        <span className="trajectory-inspector-subject">{view.title}</span>
        {onClose !== undefined && (
          <button type="button" className="trajectory-inspector-close" onClick={onClose} aria-label="关闭检查器">
            关闭
          </button>
        )}
      </header>
      <dl className="trajectory-inspector-fields">
        {view.entries.map((entry) => (
          <div key={entry.label} className="trajectory-inspector-field" data-field={entry.label}>
            <dt>{entry.label}</dt>
            <dd className={entry.missing ? 'is-missing' : undefined} data-missing={entry.missing}>
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>
      <section className="trajectory-inspector-attachments" data-testid="trajectory-inspector-attachments">
        <h4>附件</h4>
        <p className="trajectory-inspector-attachment-summary" data-empty={view.attachments.empty}>
          {view.attachments.summary}
        </p>
        {view.attachments.images.length > 0 && (
          <ul className="trajectory-inspector-image-list">
            {view.attachments.images.map((image) => (
              <li key={image.id ?? image.name ?? 'image'} className="trajectory-inspector-image">
                <ImageThumb attachment={image} {...(imageUrl !== undefined ? { imageUrl } : {})} />
              </li>
            ))}
          </ul>
        )}
        {view.attachments.files.length > 0 && (
          <ul className="trajectory-inspector-file-list">
            {view.attachments.files.map((file, index) => (
              <li key={file.name ?? `file-${index}`} className="trajectory-inspector-file">
                {file.name ?? '（未命名文件）'}
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* 输入/输出全文（正文预览可能较长：单独成块，便于滚动阅读） */}
      <section className="trajectory-inspector-io">
        <h4>{'输入'}</h4>
        <pre className="trajectory-inspector-pre" data-testid="trajectory-inspector-input">
          {view.inputText}
        </pre>
        <h4>{'输出'}</h4>
        <pre className="trajectory-inspector-pre" data-testid="trajectory-inspector-output">
          {view.outputText}
        </pre>
      </section>
    </aside>
  );
}

function ImageThumb({
  attachment,
  imageUrl,
}: {
  readonly attachment: TrajectoryAttachment;
  readonly imageUrl?: SessionImageUrlResolver;
}): ReactNode {
  // 无 id / 无解析器 → 数据不足：显示「无图」，绝不伪造 URL
  const url =
    imageUrl !== undefined && attachment.id !== undefined
      ? imageUrl({
          id: attachment.id,
          ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.name !== undefined ? { name: attachment.name } : {}),
        })
      : null;
  if (url === null) {
    return <span className="trajectory-inspector-image-missing">{attachment.name ?? '（无图）'}</span>;
  }
  return <img className="trajectory-inspector-image-thumb" src={url} alt={attachment.name ?? '附件图片'} />;
}
