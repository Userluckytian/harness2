// U2-C1/C2 字号刻度执法证据（node 环境读源文本；jsdom 测不了类名之外的样式效果）。
// 规格：Z-61 字号刻度 —— 对话域不用 2xs（9px 不可读），最小档 = text-ui-xs；
// shell.css 对话域选择器不留裸 px / 相对 em（归 var(--text-ui-*) 刻度）。
//
// 执法范围 = U2 批C 登记的对话域组件文件（+ U2 扫尾补登 ReasoningRow / FilePreview）：
//   - ChatEmptyState.tsx —— 豁免（E 波死码清理对象：Z-10-1 新空态已取代、无生产引用；
//     :110 的 2xs 保留至清理，Z-61 最小档执法待 E 波清理后收回；理由登记见
//     docs/design-inputs/u2-audit-digest.md 与 Z10-1）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

// 机制（豁免口子收口）：新增对话域组件/选择器默认入法；豁免必须写理由注释
// （“新增选择器默认入法、豁免必须写理由注释”）。无理由注释的豁免一律不接受；
// shell.css 选择器白名单同步维护。
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
  'renderer/tool/FilePreview.tsx',
  'renderer/components/ReasoningRow.tsx',
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
// 机制：shell.css 对话域选择器 whitespace 白名单默认入法；新增选择器先入白名单再写 CSS，
// 豁免必须写理由注释（新增选择器默认入法、豁免必须写理由注释）。
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
