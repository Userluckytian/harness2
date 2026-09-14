// 壳上下文：覆层席位里的组件（命令面板）需要来自 App 根的数据（命令表 / 会话候选）。
// 用 React context 传（而不是重新 inject）——组件身份稳定，流式帧刷新命令表时不会把面板重挂载丢输入。
import { createContext, useContext } from 'react';
import type { PaletteCommand, PaletteSession } from '../components/CommandPalette.js';

export interface ShellPaletteValue {
  commands: PaletteCommand[];
  sessions: PaletteSession[];
  onSelectSession: (id: string) => void;
}

const DEFAULT_VALUE: ShellPaletteValue = {
  commands: [],
  sessions: [],
  onSelectSession: () => {},
};

const ShellPaletteContext = createContext<ShellPaletteValue>(DEFAULT_VALUE);

export const ShellPaletteProvider = ShellPaletteContext.Provider;

export function useShellPalette(): ShellPaletteValue {
  return useContext(ShellPaletteContext);
}
