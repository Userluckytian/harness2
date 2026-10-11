// 侧栏折叠形态（依据 docs/refs/refs-zcode-layout.md Z-06 / §8）：
//   Z-06 折叠后只剩 4px，内容 `opacity-0 pointer-events-none`，**不显示图标轨道**。
//   本模块只给状态类名（静默 / 降动效）；折叠的可见性由 SidebarRoot 的 Tailwind 工具类
//   （opacity-0 / pointer-events-none）承担，宽度过渡由 app-frame.css 的 200ms 承担。
// 纯函数描述类名；计时与 matchMedia 在 hook 层（use-collapse.ts）。

/** 侧栏 width/opacity 过渡时长（Z-08：200ms） */
export const COLLAPSE_TRANSITION_MS = 200;

/** 侧栏根节点的状态类名输入（顺序稳定，便于测试与快照） */
export interface SidebarClassInput {
  /** 滚动条是否处于静默（D-24：指针不在栏内） */
  quietBars: boolean;
  /** 降动效（D-16）：类名给 CSS 兜底 */
  reducedMotion: boolean;
}

/** 状态类名列表（不含布局类名与调用方追加的 className） */
export function sidebarStateClasses(input: SidebarClassInput): string[] {
  return [
    ...(input.quietBars ? ['h2-sidebar-quiet'] : []),
    ...(input.reducedMotion ? ['h2-sidebar-reduced-motion'] : []),
  ];
}
