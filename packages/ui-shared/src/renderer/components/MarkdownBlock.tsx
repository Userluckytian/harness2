// U2 批E（E-a）：助手正文 Markdown 渲染块（对齐 ZCode 基线，证据 refs-zcode.md 已核）。
//
// ZCode 实战约束（照抄，不得自行发挥）：
//   1. 完成态/历史消息一律 `mode="static"` —— ZCode 实证 streaming 模式用于历史消息会触发
//      React #185（无限更新）；只有**在途流式**那一条才用 `mode="streaming"` +
//      `parseIncompleteMarkdown`（闭合半截语法）。
//   2. `animated={false}`（流式逐字动画关掉，与 ZCode 壳一致）。
//   3. 整块包 ErrorBoundary：单条渲染异常降级为纯文本 `<pre class="md-raw">`，
//      坏消息不得拖垮整个转录。
//   4. 代码块**不用** streamdown 内置 shiki renderer —— harness2 已有 `renderer/code/`
//      （CodeViewer + shiki 懒加载）。经 `components.code` 覆盖：块级（pre 克隆注入
//      `data-block`，streamdown 源码实证）→ CodeViewer；行内 → `md-inline-code`
//      （语义 = 规格 rounded bg-muted px-1 font-mono，本仓不赌工具类扫描，落 shell.css）。
//
// 构建约束（与 ./shiki-loader.ts 同因）：streamdown 是 ESM-only（exports 无 require 条件），
// 双构建的 CJS 产物静态 import 会触发 TS1479 / 运行期 ERR_REQUIRE_ESM → 必须走
// **动态 import + React.lazy**；Suspense fallback 即纯文本降级（边界=加载期也不闪白）。
// ESM dist 由 vite 壳（desktop renderer / web）消费，chunk 拆分是加分项：
// 不用 Markdown 的界面不会下载解析器。
import { Component, lazy, memo, Suspense, type ReactNode } from 'react';
// streamdown 是 ESM-only：静态值 import 会让 CJS 产物触发 TS1479 / 运行期 ERR_REQUIRE_ESM，
// 静态 type-only import 在 CJS 构建下又触发 TS1541（须 resolution-mode 属性）。
// → 值走**动态 import + React.lazy**（下方 StreamdownLazy），类型走**内联 `import()` 类型**
//   （与 ./shiki-loader.ts 的 CodeHighlighter 同一手法：不引包类型名，结构子集自持）。
import { CodeViewer } from '../code/CodeViewer.js';
import { useActiveCodeThemeId, useCodePreferences } from '../code/code-preferences.js';
import { CODE_LANGUAGES, type CodeLanguage } from '../code/code-theme.js';

/** streamdown 懒加载（default = 其 memo 组件；类型经 import() 保留） */
const StreamdownLazy = lazy(() => import('streamdown').then((m) => ({ default: m.Streamdown })));

/** streamdown components 映射类型：**从 lazy 值派生**（ComponentProps 走值通道，
 * CJS 构建无静态 ESM 类型引用；不引包类型名，见上方注释） */
type StreamdownComponents = NonNullable<React.ComponentProps<typeof StreamdownLazy>['components']>;

/** ReactNode → 纯文本（提取 code 子树原文；与 streamdown 默认 code 组件的取文语义等价） */
function nodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

/** 围栏常见别名 → CODE_LANGUAGES 白名单 id（未命中 → null = CodeViewer 纯文本渲染，不假装高亮） */
const LANG_ALIAS: Readonly<Record<string, CodeLanguage>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  md: 'markdown',
  yml: 'yaml',
  htm: 'html',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
};

/** className（streamdown 注入 `language-xxx`）→ CodeLanguage | null */
function classNameToLanguage(className: string | undefined): CodeLanguage | null {
  const m = /language-([^\s]+)/.exec(className ?? '');
  const raw = m?.[1];
  if (raw === undefined) return null;
  return toCodeLanguage(raw);
}

/** 语言 id（含别名）→ 白名单命中（大小写不敏感；未命中 null） */
export function toCodeLanguage(raw: string): CodeLanguage | null {
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if ((CODE_LANGUAGES as readonly string[]).includes(v)) return v as CodeLanguage;
  const alias = LANG_ALIAS[v];
  return alias ?? null;
}

// —— components 覆盖（模块级常量：引用稳定，不破坏 Streamdown 的 memo 分块）——

/** code 覆盖：块级（props 含 data-block，pre 默认组件克隆注入）→ CodeViewer；行内 → md-inline-code */
function MdCode({
  node: _node,
  className,
  children,
  ...rest
}: {
  node?: unknown;
  className?: string;
  children?: ReactNode;
  'data-block'?: string;
}): ReactNode {
  if (!('data-block' in rest)) {
    return <code className="md-inline-code">{children}</code>;
  }
  return <MdCodeFence code={nodeText(children)} language={classNameToLanguage(className)} />;
}

/** 块级代码围栏（shiki 高亮懒加载在 CodeViewer 内部：加载期先纯文本，绝不阻塞） */
function MdCodeFence({ code, language }: { code: string; language: CodeLanguage | null }): ReactNode {
  const themeId = useActiveCodeThemeId();
  const prefs = useCodePreferences();
  return (
    <div className="md-code-block" data-streamdown="code-block">
      <CodeViewer
        content={code}
        language={language}
        themeId={themeId}
        lineNumbers={prefs.lineNumbers}
        wordWrap={prefs.wordWrap}
        fontSize={prefs.fontSize}
      />
    </div>
  );
}

/** strong 覆盖：streamdown 默认渲染 `<span data-streamdown="strong">`（非真 `<strong>`）→ 归正语义 */
function MdStrong({ children }: { node?: unknown; className?: string; children?: ReactNode }): ReactNode {
  return <strong>{children}</strong>;
}

const MD_COMPONENTS: StreamdownComponents = {
  code: MdCode as StreamdownComponents['code'],
  strong: MdStrong as StreamdownComponents['strong'],
};

// —— ErrorBoundary（E-a 规格第 4 条）——

interface BoundaryProps {
  readonly children: ReactNode;
  readonly fallback: string;
}
interface BoundaryState {
  readonly failed: boolean;
}

/** 单条渲染异常（含 streamdown chunk 加载失败）→ 纯文本 `<pre class="md-raw">`（ZCode ErrorBoundary 同款） */
class MarkdownErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <pre className="md-raw" data-md-fallback="true">
          {this.props.fallback}
        </pre>
      );
    }
    return this.props.children;
  }
}

export interface MarkdownBlockProps {
  /** Markdown 原文 */
  readonly text: string;
  /** 在途流式（唯一允许 mode="streaming" 的条件；完成态/历史恒 false → static） */
  readonly streaming?: boolean;
  /** 附加类名（挂载点微调，`.markdown-body` 恒在） */
  readonly className?: string;
}

/**
 * 助手正文 Markdown 块（memo：文本未变不重渲）。
 * 样式全部走 `.markdown-body` 选择器（shell.css U2-E 块，字号钉 --text-ui-* 刻度）。
 */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  streaming = false,
  className,
}: MarkdownBlockProps): ReactNode {
  return (
    <MarkdownErrorBoundary fallback={text}>
      <Suspense
        fallback={
          <pre className="md-raw" data-md-loading="true">
            {text}
          </pre>
        }
      >
        <StreamdownLazy
          className={className === undefined ? 'markdown-body' : `markdown-body ${className}`}
          mode={streaming ? 'streaming' : 'static'}
          parseIncompleteMarkdown={streaming}
          animated={false}
          controls={false}
          components={MD_COMPONENTS}
        >
          {text}
        </StreamdownLazy>
      </Suspense>
    </MarkdownErrorBoundary>
  );
});
