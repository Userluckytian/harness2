// 草稿卸载护栏（P2-4）：给「无草稿落盘通道」的壳（如 web）一个**可行动**的兜底。
//
// 背景：`controller.draftsPersistence === 'memory-only'` 的壳里，草稿只活在内存；页面刷新/关闭
// 会把它静默丢掉。共享层在此把「丢之前先问一句」做成契约，壳据 controller 暴露的能力值注册即可，
// 不必各自发明提示文案，也不许静默丢弃。
//
// 设计要点：
//   - 护栏**常驻注册**一个 beforeunload 监听，触发时**现读**最新草稿（不订阅、不缓存快照），
//     因此草稿是挂载后才输入的也拦得住；无未发送草稿时**不打扰**（不 preventDefault）。
//   - 判定 `hasUnsavedDrafts` 只看「非空草稿」，与发送流程无关（有草稿才提示）。
import { useEffect } from 'react';
import type { DraftsMap } from '../shared/drafts.js';

/** 无落盘通道时的可行动提示（唯一文案源；壳的护栏/横幅共用） */
export const DRAFTS_UNSAVED_UNLOAD_MESSAGE =
  '本壳未提供草稿落盘通道：刷新或关闭页面会丢失未发送的草稿（请先发送或复制内容）';

/** 是否存在未发送草稿（任一会话有非空草稿即算） */
export function hasUnsavedDrafts(drafts: DraftsMap): boolean {
  return Object.values(drafts).some((text) => text.length > 0);
}

/** 草稿持久化能力（`controller.draftsPersistence` 的结构子集） */
export interface DraftsPersistencePort {
  readonly draftsPersistence: 'disk' | 'memory-only';
}

/** 「现读最新草稿」的端口（通常 `() => store.getState().drafts`） */
export interface DraftsReadPort {
  getState(): { readonly drafts: DraftsMap };
}

/** beforeunload 事件的最小面（DOM 事件与测试假实现都满足） */
export interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue?: unknown;
}

/** beforeunload 注册目标的最小面（缺省 = globalThis/window；测试注入假实现） */
export interface BeforeUnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
}

export interface DraftsUnloadGuardOptions {
  /** controller（能力契约来源） */
  readonly controller: DraftsPersistencePort;
  /** store（现读草稿） */
  readonly store: DraftsReadPort;
  /** 注册目标（缺省 globalThis；测试注入） */
  readonly target?: BeforeUnloadTarget;
  /** 提示文案（缺省 `DRAFTS_UNSAVED_UNLOAD_MESSAGE`） */
  readonly message?: string;
}

/**
 * 注册草稿卸载护栏；返回退订函数。
 * - `draftsPersistence === 'disk'` → 不注册（落盘通道已存在，不需要打扰）；
 * - 有未发送草稿 → `preventDefault()`（浏览器显示离开确认）；
 * - 无未发送草稿 → 放行（不打扰）。
 */
export function installDraftsUnloadGuard(options: DraftsUnloadGuardOptions): () => void {
  if (options.controller.draftsPersistence === 'disk') return () => undefined;
  const target = options.target ?? (globalThis as unknown as BeforeUnloadTarget); // 浏览器/测试环境都有 addEventListener
  const message = options.message ?? DRAFTS_UNSAVED_UNLOAD_MESSAGE;
  const handler = (event: BeforeUnloadEventLike): void => {
    if (!hasUnsavedDrafts(options.store.getState().drafts)) return; // 无草稿不打扰
    event.preventDefault();
    event.returnValue = message; // 旧浏览器：赋字符串才弹确认框
    return undefined;
  };
  target.addEventListener('beforeunload', handler);
  return () => {
    target.removeEventListener('beforeunload', handler);
  };
}

/**
 * React 壳用的薄封装：`draftsPersistence==='disk'` 时零注册；否则常驻护栏。
 * controller/store 引用稳定（壳单例），effect 不会每次渲染重挂。
 */
export function useDraftsUnloadGuard(controller: DraftsPersistencePort, store: DraftsReadPort, message?: string): void {
  useEffect(() => {
    return installDraftsUnloadGuard({
      controller,
      store,
      ...(message !== undefined ? { message } : {}),
    });
  }, [controller, store, message]);
}
