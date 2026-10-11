// web 壳的 slot 装配（对标桌面 `layout/shell-registry.ts`）：声明四席位 → 注册 root 槽 → 注入各席位内容。
// 与桌面的差异：web 的壳实例由入口创建（非模块级单例），故这里提供工厂 `assembleWebFrame`，
// 由 `app.tsx` 按需建一份注册表（测试各自新建，互不串扰）。
import { createSlotRegistry, type SlotRegistry } from '@harness2/ui-shared/renderer/slots/index.js';
import { declareFrameSeats, registerFrameSeats } from '@harness2/ui-shared/renderer/layout/frame-seats.js';
import { FRAME_SEAT_VIEWS } from '@harness2/ui-shared/renderer/layout/frame-seat-views.js';
import { injectWebSeatContents } from './web-seat-contents.js';

/**
 * 对任意注册表执行 web 的四席位装配。
 * 重复调用会因声明 / key 重复而抛错 —— 这正是「两套并存」的守门。
 */
export function assembleWebFrame(registry: SlotRegistry = createSlotRegistry()): {
  registry: SlotRegistry;
  dispose: () => void;
} {
  declareFrameSeats(registry);
  const disposeSeats = registerFrameSeats(registry, FRAME_SEAT_VIEWS);
  const disposeContents = injectWebSeatContents(registry);
  return {
    registry,
    dispose: () => {
      disposeContents();
      disposeSeats();
    },
  };
}
