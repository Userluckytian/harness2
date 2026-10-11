// Z3-04「管理模型」直达通道：openSettingsAtSection 打开设置覆层并记下分区诉求（取走即清）。
import { beforeEach, describe, expect, it } from 'vitest';
import { shellOverlayStore } from '../../src/renderer/layout/shell-overlays.js';
import { openSettingsAtSection, takeRequestedSettingsSection } from '../../src/renderer/layout/shell-overlays.js';

beforeEach(() => {
  shellOverlayStore.patch({ settings: false, palette: false });
});

describe('openSettingsAtSection（composer「管理模型」→ 设置弹窗直达分区）', () => {
  it('打开 settings 覆层并记录分区；takeRequested 取走即清（一次性诉求，不残留）', () => {
    expect(shellOverlayStore.getSnapshot().settings).toBe(false);
    openSettingsAtSection('models');
    expect(shellOverlayStore.getSnapshot().settings).toBe(true);
    expect(takeRequestedSettingsSection()).toBe('models');
    expect(takeRequestedSettingsSection()).toBeUndefined(); // 取走即清：下次普通打开跟随默认分区
  });

  it('普通打开（setOverlay）不产生分区诉求', () => {
    openSettingsAtSection('general');
    takeRequestedSettingsSection();
    shellOverlayStore.patch({ settings: false });
    // 直接开覆层（非 openSettingsAtSection）→ 无诉求
    shellOverlayStore.patch({ settings: true });
    expect(takeRequestedSettingsSection()).toBeUndefined();
  });
});
