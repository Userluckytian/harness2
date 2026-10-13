// composer-menu-signal.ts — Z10-2b「打开模型菜单」快捷键（ZCode `openModelMenu` = Ctrl+M）的信号总线。
//
// 为什么是总线而不是第二套状态：模型菜单的开合由 Radix DropdownMenu 持有（`ComposerModelSelect`
// 的受控 `open`），壳的全局 keydown 无法直接触达任意一个已挂载的实例。这里只广播一个**一次性
// 开合信号**（无载荷、不存任何数据），订阅它的模型选择控件收到即置 open=true —— 不复制菜单/
// 选中态等任何业务状态（数据仍单一真源在 config）。
//
// 多席位（分屏）说明：信号广播给所有已挂载的模型选择控件，因此分屏下会同时展开各格菜单；
// ZCode 的 composer 是单实例，本体行为与之一致。这是如实的行为边界，不另造「哪格算焦点」状态。
//
// 模块级单例（与 workbenchStore / composerPrefill 同族）；不落任何存储（D-14）。
const listeners = new Set<() => void>();

/** 广播「打开模型菜单」（壳的 Ctrl+M keydown 调用；无订阅者 = 无操作，不报错） */
export function requestOpenComposerModelMenu(): void {
  for (const listener of [...listeners]) listener();
}

/** 订阅打开信号；返回退订函数（ComposerModelSelect 挂载期订阅） */
export function subscribeComposerModelMenuRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
