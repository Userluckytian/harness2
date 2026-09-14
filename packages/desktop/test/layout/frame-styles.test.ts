// 帧样式表契约测试（D-13 / D-16 / 关闭态）。
// vitest 不注入 CSS，故这里直接读 layout/app-frame.css 断言关键规则存在 ——
// 「56px 轨道宽度、hidden 真的不占布局、降动效两条路都关过渡」都不能只靠内联样式。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'layout', 'app-frame.css'),
  'utf8',
);

describe('app-frame.css 契约', () => {
  it('降动效（D-16）：media query 与帧根属性两条路都关过渡/动画', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?transition: none !important;[\s\S]*?animation: none !important;/;
    expect(css).toMatch(reduced);
    const attribute =
      /\.app-frame\[data-reduced-motion='true'\][\s\S]*?transition: none !important;[\s\S]*?animation: none !important;/;
    expect(css).toMatch(attribute);
  });

  it('席位容器：右栏皮肤 .side-panel 撑满席位盒；侧栏皮肤用真实类名 .h2-sidebar（空转的 .sidebar 规则已删）', () => {
    expect(css).toMatch(/\.app-frame-rightbar \.side-panel \{[\s\S]*?width: 100%;/);
    expect(css).toMatch(/\.app-frame-sidebar \.h2-sidebar \{\s*border-right: none;\s*\}/);
    // P2-1：`.app-frame-sidebar .sidebar` 是 0 引用的空转规则（旧皮肤已随 SidebarRoot 落地删除）
    expect(css).not.toMatch(/\.app-frame-sidebar \.sidebar \{/);
    // P0-1：空间不足提示条不再落在中栏（报告交右栏占用方，由 canShow=false 触发自关）
    expect(css).not.toMatch(/\.app-frame-shortage/);
  });

  it('拖动期间暂停宽度过渡（P2-2）：data-dragging 的席位容器 transition: none', () => {
    expect(css).toMatch(
      /\.app-frame-sidebar\[data-dragging='true'\],\s*\.app-frame-rightbar\[data-dragging='true'\] \{\s*transition: none;\s*\}/,
    );
  });

  it('右栏关闭态 hidden 真的不占布局（不被 display:flex 盖掉）', () => {
    expect(css).toMatch(/\.app-frame-rightbar\[hidden\] \{\s*display: none;\s*\}/);
  });

  it('拖宽手柄：col-resize 光标 + 左右两栏各贴一侧（D-11）', () => {
    expect(css).toMatch(/\.app-frame-resizer \{[\s\S]*?cursor: col-resize;/);
    expect(css).toMatch(/\.app-frame-resizer-right \{\s*right: -3px;\s*\}/);
    expect(css).toMatch(/\.app-frame-resizer-left \{\s*left: -3px;\s*\}/);
  });

  it('slot 容器不参与布局（display: contents，装配标记不影响三栅几何）', () => {
    expect(css).toMatch(/\.slot-entry \{\s*display: contents;\s*\}/);
  });
});
