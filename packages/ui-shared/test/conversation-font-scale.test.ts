// U2-C1/C2 字号刻度执法证据（node 环境读源文本；jsdom 测不了类名之外的样式效果）。
// 规格：Z-61 字号刻度 —— 对话域不用 2xs（9px 不可读），最小档 = text-ui-xs；
// shell.css 对话域选择器不留裸 px / 相对 em（归 var(--text-ui-*) 刻度）。
//
// 执法范围 = U2 批C 登记的对话域组件文件（刻意排除：
//   - ChatEmptyState.tsx —— 禁改域（E 波与清理单独做，其 :110 的 2xs 保留）；
//   - tool/FilePreview.tsx —— 右栏文件预览皮肤，非对话流，未列入批C）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const CONVERSATION_TSX = [
  'renderer/components/ChatView.tsx',
  'renderer/conversation/composer/Composer.tsx',
  'renderer/conversation/QueuePanel.tsx',
  'renderer/conversation/ResumeBar.tsx',
  'renderer/conversation/TimelineMarkerRow.tsx',
  'renderer/conversation/turn-navigator.tsx',
  'renderer/conversation/turn-work.tsx',
  'renderer/conversation/ChatErrorBanner.tsx',
  'renderer/conversation/status-panel/ConversationStatusPanel.tsx',
  'renderer/tool/ToolCard.tsx',
];

describe('U2-C1：对话域组件不再使用 text-ui-2xs（最小档 = text-ui-xs）', () => {
  for (const file of CONVERSATION_TSX) {
    it(`${file} 无 text-ui-2xs`, () => {
      // 注释里允许提及（说明执法口径），断言只看 className 字符串位
      const offenders = src(file)
        .split('\n')
        .filter((line) => line.includes('text-ui-2xs') && !line.trimStart().startsWith('//'));
      expect(offenders, `发现 2xs 用量：\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});

describe('U2-C2：shell.css 对话域选择器字号归 var(--text-ui-*) 刻度（零裸 px/em）', () => {
  const css = src('styles/shell.css');
  /** 去注释（散文会提「12px」等字样，不能当声明证据）后，取某选择器块的声明体 */
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  function blockOf(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
    expect(m, `未找到选择器块：${selector}`).not.toBeNull();
    return m?.[1] ?? '';
  }
  // 批C 逐条映射的对话域选择器（U2-C2 清单 + 相邻同源字号）：字号声明（若有）必须是刻度
  // var(--text-ui-*)，不得是裸 px / em。叶子选择器名（组选择器取其成员，如 `.queue-bar,
  // .ref-report` 的块用 block('.ref-report') 命中）。
  const CONVERSATION_SELECTORS = [
    '.reasoning',
    '.reasoning-inline',
    '.tool-row',
    '.turn-summary',
    '.ref-report',
    '.cmd-log',
    '.composer-chip',
    '.composer-attachments',
    '.composer-status',
    '.chat-error-banner',
    '.chat-error-banner-btn',
    '.chat-error-banner-hint',
    '.chat-error-detail-pre',
    '.unread-badge',
    '.pane-header',
    '.pane-header-branch-icon',
    '.ctx-label',
    '.subagent-jump',
    '.turn-rail-item',
  ];
  for (const selector of CONVERSATION_SELECTORS) {
    it(`${selector} 的 font-size 走刻度（零裸 px/em）`, () => {
      const rules = blockOf(selector);
      const fontSize = /font-size:\s*([^;]+);/.exec(rules);
      if (fontSize === null) return; // 无字号声明（继承）同样合规
      expect(fontSize[1]?.trim(), `裸值未归刻度：${fontSize[1]}`).toMatch(/^var\(--text-ui/);
    });
  }
});
