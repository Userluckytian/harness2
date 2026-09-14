// slots 导出面：声明式席位（single / keyed / list）+ React 绑定。
export { SlotRegistry, SlotRegistryError, createSlotRegistry } from './registry.js';
export { SlotHost, useSeatEntries, type SlotHostProps } from './react.js';
export type { SeatDeclaration, SeatKind, SlotContribution, SlotEntry } from './types.js';
