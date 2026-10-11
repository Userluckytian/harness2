// AppFrame（D-10）：壳只渲染 root 槽 —— 四个子席位（sidebar / main / rightbar / shell.overlay）
// 由布局包注册进内建 root 槽，内容由各能力包 inject。几何/开合状态经 FrameProvider 下发给席位容器。
//
// Z7 起本组件下沉 ui-shared（壳无关）：桌面与 web 共用同一套四席位骨架。
// 样式表（app-frame.css）由**壳的入口**显式 import（`@harness2/ui-shared/styles/app-frame.css`）——
// 本文件不做相对 CSS import（tsc 双构建不搬运 .css，构建产物会丢样式）。
import { SlotHost } from '../slots/index.js';
import { FRAME_ROOT_SEAT } from './frame-seats.js';
import { FrameProvider, type FrameController } from './frame-context.js';
import { reducedMotionAttribute } from './reduced-motion.js';

export function AppFrame({ controller }: { controller: FrameController }): React.ReactNode {
  return (
    <FrameProvider value={controller}>
      <div
        className={`body app-frame${controller.reducedMotion ? ' app-frame-reduced-motion' : ''}`}
        data-reduced-motion={reducedMotionAttribute(controller.reducedMotion) ?? undefined}
      >
        <SlotHost registry={controller.registry} seat={FRAME_ROOT_SEAT} />
      </div>
    </FrameProvider>
  );
}
