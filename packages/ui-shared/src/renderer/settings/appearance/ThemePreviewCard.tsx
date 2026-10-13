// 代码主题预览卡（Z10-7；refs-zcode.md:358 的 `ThemePreviewCard`）。
//
// 形态（逐项对齐 refs 规格）：
//   * 头部：title（浅色预览 / 深色预览）+ themeName（主题展示名）+ 徽标（当前生效 / 浅色 / 深色）；
//   * 主体：渲染**一段固定 TS 预览代码**（CODE_PREVIEW_SAMPLE），按给定代码主题高亮；
//   * 背景：浅色预览固定 `#f8f8f8`、深色预览固定 `#161616`（覆盖主题自带底色，规格钉死）；
//   * 两卡由外观设置以 `grid gap-4 sm:grid-cols-2` 并排（见 AppearanceSettings）。
import type { ReactNode } from 'react';
import type { CodeThemeId } from '../../../shared/settings.js';
import { codeThemeLabel } from '../../code/code-theme.js';
import { CodeViewer } from '../../code/CodeViewer.js';
import { CODE_PREVIEW_SAMPLE } from '../../code/preview-sample.js';

/** 徽标文案（规格三态） */
export type CodePreviewBadge = '当前生效' | '浅色' | '深色';

/** 浅色预览固定背景（refs-zcode.md:358） */
export const CODE_PREVIEW_LIGHT_BG = '#f8f8f8';
/** 深色预览固定背景（refs-zcode.md:358） */
export const CODE_PREVIEW_DARK_BG = '#161616';

/** 预览卡固定代码字号（纯主题色差预览；不跟随「代码字号」设置，保证两卡布局稳定） */
const PREVIEW_FONT_SIZE = 12;

export interface ThemePreviewCardProps {
  /** 卡片标题（浅色预览 / 深色预览） */
  readonly title: string;
  /** 预览所用代码主题 id */
  readonly themeId: CodeThemeId;
  /** 徽标（当前生效 / 浅色 / 深色） */
  readonly badge: CodePreviewBadge;
  /** 固定背景色（#f8f8f8 / #161616） */
  readonly background: string;
  /** 明暗归属（测试/DOM 标注用：'light' | 'dark'） */
  readonly kind: 'light' | 'dark';
}

export function ThemePreviewCard({ title, themeId, badge, background, kind }: ThemePreviewCardProps): ReactNode {
  return (
    <div className="overflow-hidden rounded-lg border" data-theme-preview={kind} data-preview-theme={themeId}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-ui-sm text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest" title={codeThemeLabel(themeId)}>
          {codeThemeLabel(themeId)}
        </span>
        <span
          className="flex-none rounded-full border px-2 text-ui-xs text-foreground-subtle"
          data-preview-badge={badge}
        >
          {badge}
        </span>
      </div>
      <CodeViewer
        content={CODE_PREVIEW_SAMPLE}
        language="typescript"
        themeId={themeId}
        lineNumbers={false}
        wordWrap={false}
        fontSize={PREVIEW_FONT_SIZE}
        background={background}
        maxHeight="11rem"
      />
    </div>
  );
}
