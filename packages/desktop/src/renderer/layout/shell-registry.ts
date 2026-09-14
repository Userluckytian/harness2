// 应用级 slot 装配（D-10）：一个进程一份注册表 —— 声明四席位 → 注册 root 槽 → 注入各席位内容。
// 模块加载即完成装配（首帧就有完整树，不留空壳）；测试可自行 createSlotRegistry + 复用同一套装配函数。
import { createSlotRegistry, type SlotRegistry } from '../slots/index.js';
import { declareFrameSeats, registerFrameSeats } from './frame-seats.js';
import { FRAME_SEAT_VIEWS } from './frame-seat-views.js';
import { injectShellSeatContents } from './shell-seat-contents.js';

/** 应用注册表（渲染端单例） */
export const shellSlots: SlotRegistry = createSlotRegistry();

declareFrameSeats(shellSlots);
registerFrameSeats(shellSlots, FRAME_SEAT_VIEWS);
injectShellSeatContents(shellSlots);

/**
 * 对任意注册表执行同一套装配（测试用；应用本体已在模块加载时装配）。
 * 重复调用会因声明/ key 重复而抛错 —— 这正是「两套并存」的守门。
 */
export function assembleFrame(registry: SlotRegistry = createSlotRegistry()): {
  registry: SlotRegistry;
  dispose: () => void;
} {
  declareFrameSeats(registry);
  const disposeSeats = registerFrameSeats(registry, FRAME_SEAT_VIEWS);
  const disposeContents = injectShellSeatContents(registry);
  return {
    registry,
    dispose: () => {
      disposeContents();
      disposeSeats();
    },
  };
}
