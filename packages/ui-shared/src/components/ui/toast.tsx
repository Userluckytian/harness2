// Z-78 Toast
import * as React from 'react';
import { CircleCheck, CircleX, InfoIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

type ToastVariant = 'default' | 'success' | 'destructive';

interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** 自动关闭毫秒数；<= 0 表示不自动关闭。默认 4000。 */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: string;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  dismiss: (id: string) => void;
  items: ToastItem[];
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用');
  }
  return { toast: context.toast, dismiss: context.dismiss };
}

function ToastIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') {
    return <CircleCheck className="size-4 text-success" />;
  }
  if (variant === 'destructive') {
    return <CircleX className="size-4 text-destructive" />;
  }
  return <InfoIcon className="size-4 text-foreground-subtle" />;
}

function ToastProvider({ children }: { children?: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const duration = options.duration ?? 4000;
      setItems((prev) => [...prev, { id, ...options }]);
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast, dismiss, items }), [toast, dismiss, items]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

function Toaster({ className }: { className?: string }) {
  const context = React.useContext(ToastContext);
  if (!context) {
    return null;
  }

  return (
    <div data-slot="toaster" className={cn('fixed top-16 right-4 z-[9999] flex flex-col gap-2', className)}>
      {context.items.map((item) => {
        const variant = item.variant ?? 'default';
        return (
          <div
            key={item.id}
            data-slot="toast"
            data-variant={variant}
            className="grid min-w-[280px] max-w-[380px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-2xl border border-border bg-toast/60 p-2.5 text-ui-base shadow-lg backdrop-blur-xl duration-200 animate-in fade-in-0 slide-in-from-top-2"
          >
            <ToastIcon variant={variant} />
            <div className="grid gap-0.5">
              {item.title ? <div className="font-medium">{item.title}</div> : null}
              {item.description ? <div className="text-ui-sm text-foreground-subtle">{item.description}</div> : null}
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => context.dismiss(item.id)}
              className="inline-flex size-5 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export { Toaster, ToastProvider, useToast };
export type { ToastOptions, ToastVariant };
