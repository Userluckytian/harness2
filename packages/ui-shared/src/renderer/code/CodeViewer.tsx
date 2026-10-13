// 代码查看器（Z10-7）—— 壳无关的**只读**代码呈现：行号 + 等宽字体 + 按代码主题语法高亮
// + 可选自动换行 + 字号跟随设置。
//
// 分两层：
//   * `CodeViewer`（本组件，纯呈现）：只吃 props（内容 / 语言 / 主题 / 行号 / 换行 / 字号），
//     异步懒加载 shiki 高亮（加载期间先按纯文本渲染，绝不阻塞、绝不摆假高亮）；
//   * `CodeViewerPane`（./CodeViewerPane.tsx）：数据 + 偏好（读文件、读代码偏好、解析生效主题）。
//
// 高亮失败 / 语言未支持 → 回落**纯文本**行渲染（诚实：宁可无色，不假装高亮）。
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CodeThemeId } from '../../shared/settings.js';
import type { CodeLanguage } from './code-theme.js';
import { loadCodeHighlighter, type CodeTokensResult } from './shiki-loader.js';

/** 等宽字体栈（跨壳一致；系统字体，不引外部字体） */
const MONO_FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace';

/** token 的 fontStyle 位掩码（shiki 口径：1=italic, 2=bold, 4=underline）→ CSS */
function tokenStyle(token: { color?: string; fontStyle?: number }): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (token.color !== undefined) style.color = token.color;
  const fs = token.fontStyle ?? 0;
  if (fs & 1) style.fontStyle = 'italic';
  if (fs & 2) style.fontWeight = 700;
  if (fs & 4) style.textDecoration = 'underline';
  return style;
}

/** 懒加载高亮 tokens（content/语言/主题变化即重算；纯文本语言 null → 不做高亮） */
function useCodeTokens(content: string, language: CodeLanguage | null, themeId: CodeThemeId): CodeTokensResult | null {
  const [tokens, setTokens] = useState<CodeTokensResult | null>(null);
  useEffect(() => {
    if (language === null) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    setTokens(null); // 换语言/主题先清旧高亮（避免用旧主题色渲染新内容）
    loadCodeHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          setTokens(hl.codeToTokens(content, { lang: language, theme: themeId }));
        } catch {
          setTokens(null); // 高亮失败 → 纯文本回落
        }
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [content, language, themeId]);
  return tokens;
}

export interface CodeViewerProps {
  /** 文件内容（已读到的文本；空串 = 空文件，仍渲染一行空行） */
  readonly content: string;
  /** 高亮语言（null = 纯文本渲染，不假装高亮） */
  readonly language: CodeLanguage | null;
  /** 生效代码主题 id */
  readonly themeId: CodeThemeId;
  /** 显示行号 */
  readonly lineNumbers: boolean;
  /** 长行自动换行 */
  readonly wordWrap: boolean;
  /** 代码字号（px） */
  readonly fontSize: number;
  /**
   * 背景色覆盖（预览卡按 refs 规格固定 #f8f8f8 / #161616）；缺省 = 主题自带底色。
   * 前景色始终取主题 fg（保证对比度由主题负责）。
   */
  readonly background?: string;
  /** 最高高度（预览卡限高用）；缺省不限。 */
  readonly maxHeight?: string;
}

export function CodeViewer({
  content,
  language,
  themeId,
  lineNumbers,
  wordWrap,
  fontSize,
  background,
  maxHeight,
}: CodeViewerProps): ReactNode {
  const tokens = useCodeTokens(content, language, themeId);
  // 行以**纯文本切分**为准（shiki 行数应与之一致；不等时用纯文本兜底该行，不丢内容）
  const plainLines = useMemo(() => content.split('\n'), [content]);
  const bg = background ?? tokens?.bg;
  const fg = tokens?.fg;

  return (
    <div
      className="code-viewer-body min-h-0 overflow-auto"
      data-code-viewer-body
      data-code-theme={themeId}
      data-code-line-numbers={lineNumbers ? 'true' : 'false'}
      data-code-wrap={wordWrap ? 'true' : 'false'}
      data-code-font-size={fontSize}
      style={{ background: bg, maxHeight }}
    >
      <pre
        className="m-0 py-2"
        style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: `${fontSize}px`,
          lineHeight: 1.5,
          color: fg,
          whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
          wordBreak: wordWrap ? 'break-word' : 'normal',
          minWidth: wordWrap ? undefined : 'max-content',
        }}
      >
        {plainLines.map((text, i) => {
          const lineTokens = tokens?.tokens[i];
          const gutterWidth = `${String(plainLines.length).length + 1}ch`;
          return (
            <div key={i} className="flex" data-code-line={i + 1}>
              {lineNumbers && (
                <span
                  aria-hidden="true"
                  className="flex-none select-none pr-3 pl-3 text-right tabular-nums opacity-50"
                  style={{ minWidth: gutterWidth }}
                  data-code-gutter
                >
                  {i + 1}
                </span>
              )}
              <code className="pr-3" data-code-line-text>
                {lineTokens !== undefined && lineTokens.length > 0
                  ? lineTokens.map((t, j) => (
                      <span key={j} style={tokenStyle(t)}>
                        {t.content}
                      </span>
                    ))
                  : text}
              </code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
