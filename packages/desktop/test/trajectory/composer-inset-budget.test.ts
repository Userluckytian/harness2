// P2-2 / Z2-05：D-46 的 composer 预留高度**只生效一次**（样式来源级证据，node 环境读 CSS 文本）。
//
// 缺陷回顾（P2-2）：视图容器与滚动叶容器曾各自声明同一个预留变量，同一高度被计两次。
// 修法：预留由**唯一**的滚动叶容器落实。Z2-05 后的事实口径：
//   * 预留只服务 chat 主视图 —— 唯一声明者 = `.messages`（转录滚动叶容器）；
//   * trajectory 已迁右栏 tab（不浮在 composer 之下）→ `.trajectory-records-scroll`
//     不再声明任何预留；主区视图环（.view-ring*）整个退役。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P8：桌面基础样式表（含 D-46 的预留高度契约）已下沉 @harness2/ui-shared（web 壳同一份）。
const stylesCss = readFileSync(
  fileURLToPath(new URL('../../../ui-shared/src/styles/shell.css', import.meta.url)),
  'utf8',
);
const trajectoryCss = readFileSync(
  fileURLToPath(new URL('../../src/renderer/trajectory/trajectory.css', import.meta.url)),
  'utf8',
);
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarationsOf = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const styles = declarationsOf(stylesCss);
const trajectory = declarationsOf(trajectoryCss);

describe('P2-2 / Z2-05：D-46 预留高度只生效一次，且只服务 chat', () => {
  it('唯一声明者 = .messages（chat 滚动叶容器；保留原有 16px 底距）', () => {
    const messages = /\.messages\s*\{([^{}]*)\}/.exec(styles);
    expect(messages?.[1] ?? '').toContain('padding-bottom: calc(var(--composer-inset, 0px) + 16px)');
    // 整个样式表（含轨迹样式）只有这一份声明
    expect(styles.match(/--composer-inset/g) ?? []).toHaveLength(1);
    expect(trajectory.match(/--composer-inset/g) ?? []).toHaveLength(0);
  });

  it('主区视图环（.view-ring*）已退役：样式表不再有任何视图环选择器', () => {
    expect(styles.match(/\.view-ring/g) ?? []).toHaveLength(0);
  });

  it('轨迹记录表滚动叶不再声明预留（右栏 tab 不浮在 composer 之下，不虚构 0px 兜底）', () => {
    const scroll = /\.trajectory-records-scroll\s*\{([^{}]*)\}/.exec(trajectory);
    expect(scroll).not.toBeNull();
    expect(scroll?.[1] ?? '').not.toContain('padding-bottom');
  });
});
