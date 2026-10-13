// ToastHost —— 全局 Toast 宿主：订阅 toastStore 并把通知堆叠渲染在壳的**覆层区**。
//
// 两壳各挂一次（desktop `App.tsx` 的窗口根、web `app.tsx` 的 `.web-frame`）；组件本身
// 壳无关，位置/尺寸由自身 className 决定（fixed top-16 right-4，见 refs-zcode.md §Z-78）。
// 容器 `pointer-events-none`，仅每张卡 `pointer-events-auto`，避免空白区挡住下层点击。
import type { ReactNode } from 'react';
import { ToastCard } from '../../components/ui/toast.js';
import { toastStore } from './toast-store.js';
import { useToastItems } from './use-toast.js';

export function ToastHost(): ReactNode {
  const items = useToastItems();
  return (
    <div
      data-slot="toaster"
      data-testid="toast-host"
      aria-label="通知"
      className="pointer-events-none fixed top-16 right-4 z-[9999] flex flex-col gap-2"
    >
      {items.map((item) => (
        <ToastCard
          key={item.id}
          kind={item.kind}
          message={item.message}
          {...(item.detail !== undefined ? { detail: item.detail } : {})}
          onDismiss={() => toastStore.dismiss(item.id)}
          className="pointer-events-auto"
        />
      ))}
    </div>
  );
}
