// web 壳上下文（Z7）：把「应用壳（store/controller）+ web 专属的接线事实」交给**席位内容组件**。
//
// 为什么用 context 而不是桌面那样的模块级单例：web 的壳实例由入口 `createAppShell` 创建，
// 测试各自新建互不串扰；席位注册表里的内容是**静态组件**（在装配时注入），需要运行时拿到
// 当前壳实例 —— context 是唯一不引全局的地方（与桌面 app-shared 单例语义等价，但可注入）。
import { createContext, useContext } from 'react';
import type { AppShell } from '@harness2/ui-shared/renderer/app-shell.js';

export interface WebShellValue {
  /** 应用壳：store（事件流投影）+ controller（动作面） */
  readonly shell: AppShell;
  /** 新建会话（serve 需要 cwd，由入口传入；缺省 = 无入口，按钮置灰） */
  readonly onNewSession?: (() => void) | undefined;
  /** 新建会话是否可用（连接状态 + 是否有可用 cwd 的综合结论；false 时按钮置灰） */
  readonly newSessionEnabled: boolean;
  /** 新建会话不可用时的**可行动**原因（如实展示，不摆灰按钮不给解释） */
  readonly newSessionBlockedReason?: string | undefined;
  /** 设置覆层是否打开（Z7：web 设置覆层，复用共享设置页；只内存，D-14） */
  readonly settingsOpen: boolean;
  /** 打开设置覆层（侧栏设置入口调用） */
  readonly onOpenSettings: () => void;
  /** 关闭设置覆层（共享页返回按钮调用） */
  readonly onCloseSettings: () => void;
}

const WebShellContext = createContext<WebShellValue | null>(null);

export const WebShellProvider = WebShellContext.Provider;

export function useWebShell(): WebShellValue {
  const value = useContext(WebShellContext);
  if (value === null) throw new Error('useWebShell 必须在 WebShellProvider 内使用');
  return value;
}
