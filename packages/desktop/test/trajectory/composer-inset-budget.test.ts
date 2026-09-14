// P2-2：D-46 的 composer 预留高度**只生效一次**（样式来源级证据，node 环境读 CSS 文本）。
//
// 缺陷回顾：`.view-ring-session, .view-ring-view` 与 `.trajectory-records-scroll`（RecordTable 的
// paddingBottomPx 同源）各自声明了同一个 `--trajectory-composer-inset`，轨迹页底部因此
// 多留一个 composer 高度。修法：视图容器不再声明；每个视图由**唯一**的滚动叶容器落实。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync(fileURLToPath(new URL('../../src/renderer/styles.css', import.meta.url)), 'utf8');
const trajectoryCss = readFileSync(
  fileURLToPath(new URL('../../src/renderer/trajectory/trajectory.css', import.meta.url)),
  'utf8',
);
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarationsOf = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const styles = declarationsOf(stylesCss);
const trajectory = declarationsOf(trajectoryCss);
const all = `${styles}\n${trajectory}`;

describe('P2-2：D-46 预留高度只生效一次', () => {
  it('视图容器（.view-ring-session/.view-ring-view）不再声明预留（否则与叶容器叠加）', () => {
    const viewRing = /\.view-ring-session,\s*\.view-ring-view\s*\{([^{}]*)\}/.exec(styles);
    expect(viewRing).not.toBeNull();
    expect(viewRing?.[1] ?? '').not.toContain('trajectory-composer-inset');
    expect(viewRing?.[1] ?? '').not.toContain('padding-bottom');
  });

  it('轨迹页预留的唯一来源 = 记录表滚动叶容器（一份声明）', () => {
    const matches = all.match(/padding-bottom:\s*var\(--trajectory-composer-inset/g) ?? [];
    expect(matches).toHaveLength(1);
    const scroll = /\.trajectory-records-scroll\s*\{([^{}]*)\}/.exec(trajectory);
    expect(scroll?.[1] ?? '').toContain('padding-bottom: var(--trajectory-composer-inset, 0px)');
  });

  it('Chat 预留的唯一来源 = .messages 滚动叶容器（且保留原有 16px 底距）', () => {
    const messages = /\.messages\s*\{([^{}]*)\}/.exec(styles);
    expect(messages?.[1] ?? '').toContain('padding-bottom: calc(var(--trajectory-composer-inset, 0px) + 16px)');
    // 容器侧不再有第二份
    expect(styles.match(/--trajectory-composer-inset/g) ?? []).toHaveLength(1);
  });
});
