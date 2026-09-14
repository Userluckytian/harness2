// P2-4 草稿卸载护栏单测：memory-only 壳「有草稿才拦、无草稿不打扰」，disk 壳零注册。
import { describe, expect, it } from 'vitest';
import {
  DRAFTS_UNSAVED_UNLOAD_MESSAGE,
  hasUnsavedDrafts,
  installDraftsUnloadGuard,
  type BeforeUnloadEventLike,
  type BeforeUnloadTarget,
} from '../src/renderer/drafts-guard.js';
import type { DraftsMap } from '../src/shared/drafts.js';

/** 假注册目标：捕获监听器，手动触发一次 beforeunload 并回传事件对象 */
function fakeTarget() {
  let listener: ((event: BeforeUnloadEventLike) => void) | undefined;
  const target: BeforeUnloadTarget = {
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = undefined;
    },
  };
  return {
    target,
    fire(): { prevented: boolean; returnValue: unknown } {
      const event: BeforeUnloadEventLike & { defaultPrevented: boolean } = {
        defaultPrevented: false,
        returnValue: undefined,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      listener?.(event);
      return { prevented: event.defaultPrevented, returnValue: event.returnValue };
    },
    hasListener: () => listener !== undefined,
  };
}

function storeWith(drafts: DraftsMap) {
  return { getState: () => ({ drafts }) };
}

describe('hasUnsavedDrafts', () => {
  it('任一会话有非空草稿 → true；全空/无键 → false', () => {
    expect(hasUnsavedDrafts({ s1: '写到一半' })).toBe(true);
    expect(hasUnsavedDrafts({ s1: '', s2: '' })).toBe(false);
    expect(hasUnsavedDrafts({})).toBe(false);
  });
});

describe('installDraftsUnloadGuard', () => {
  it('memory-only + 有草稿 → 拦下卸载（preventDefault + 返回可行动文案）', () => {
    const t = fakeTarget();
    const dispose = installDraftsUnloadGuard({
      controller: { draftsPersistence: 'memory-only' },
      store: storeWith({ s1: '未发送草稿' }),
      target: t.target,
    });
    const res = t.fire();
    expect(res.prevented).toBe(true);
    expect(res.returnValue).toBe(DRAFTS_UNSAVED_UNLOAD_MESSAGE);
    expect(DRAFTS_UNSAVED_UNLOAD_MESSAGE).toContain('刷新');
    dispose();
  });

  it('memory-only + 无草稿 → 不打扰（不 preventDefault）', () => {
    const t = fakeTarget();
    installDraftsUnloadGuard({
      controller: { draftsPersistence: 'memory-only' },
      store: storeWith({}),
      target: t.target,
    });
    expect(t.fire().prevented).toBe(false);
  });

  it('草稿是挂载后才输入的：现读最新状态，同样拦得住', () => {
    const t = fakeTarget();
    const drafts: DraftsMap = {};
    installDraftsUnloadGuard({
      controller: { draftsPersistence: 'memory-only' },
      store: { getState: () => ({ drafts }) },
      target: t.target,
    });
    expect(t.fire().prevented).toBe(false); // 一开始没有草稿
    drafts['s1'] = '后来才输入'; // 不重新注册，直接改状态
    expect(t.fire().prevented).toBe(true);
  });

  it('disk 壳：零注册（不需要护栏）', () => {
    const t = fakeTarget();
    const dispose = installDraftsUnloadGuard({
      controller: { draftsPersistence: 'disk' },
      store: storeWith({ s1: '有草稿' }),
      target: t.target,
    });
    expect(t.hasListener()).toBe(false);
    expect(t.fire().prevented).toBe(false);
    dispose();
  });

  it('返回的退订函数移除监听（dispose 后不再拦）', () => {
    const t = fakeTarget();
    const dispose = installDraftsUnloadGuard({
      controller: { draftsPersistence: 'memory-only' },
      store: storeWith({ s1: '有草稿' }),
      target: t.target,
    });
    dispose();
    expect(t.hasListener()).toBe(false);
    expect(t.fire().prevented).toBe(false);
  });

  it('可注入自定义文案（唯一文案源可覆写）', () => {
    const t = fakeTarget();
    installDraftsUnloadGuard({
      controller: { draftsPersistence: 'memory-only' },
      store: storeWith({ s1: 'x' }),
      target: t.target,
      message: '自定义提示',
    });
    expect(t.fire().returnValue).toBe('自定义提示');
  });
});
