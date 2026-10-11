import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * 自定义字号刻度 `text-ui-*` 必须注册进 `font-size` classGroup。
 *
 * 否则 tailwind-merge 无法把 `text-ui-base` 识别为字号类，会与 `text-foreground` 之类的
 * 颜色类判为同一冲突组而互相覆盖（refs-zcode.md Z-76 已登记的坑）。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: ['ui-2xs', 'ui-xs', 'ui-sm', 'ui-caption', 'ui-base', 'ui-lg', 'ui-xl', 'mobile-input-safe'],
        },
      ],
    },
  },
});

/** 合并 className：clsx 处理条件，tailwind-merge 处理 Tailwind 冲突。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
