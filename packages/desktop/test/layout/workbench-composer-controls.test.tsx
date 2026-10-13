// Z3-04 接线：WorkbenchHost 经 composerControls 下发左右簇控件 props → 每格 ConversationSeat
// → Composer 控件真实渲染；未下发（缺省）时不渲染（既有调用面/测试不变）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Harness2Api, SessionEventsPayloadShape } from '../../src/shared/protocol.js';
import { createController, type Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import type {
  ComposerModeSwitchProps,
  ComposerModelSelectProps,
  ComposerThoughtLevelProps,
} from '@harness2/ui-shared/renderer/conversation/composer/Composer.js';
import { WorkbenchHost } from '@harness2/ui-shared/renderer/layout/workbench/host.js';
import { WorkbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';

afterEach(cleanup);

const sessionIds = ['a'];

function replayFor(id: string): SessionEventsPayloadShape {
  return {
    id,
    dir: 'd',
    header: { sessionId: id, cwd: 'D:/proj' },
    events: [
      {
        v: 1,
        seq: 1,
        ts: '2026-10-11T00:00:00Z',
        type: 'user/message',
        payload: { text: `会话 ${id}`, turnId: 't1' },
        active: true,
      },
    ],
    warnings: [],
    lastSeq: 1,
  };
}

function makeApi(): Harness2Api {
  return {
    gitBranch: vi.fn(async () => 'main'),
    settingsGetConfig: vi.fn(async () => ({ roles: { main: { model: 'mock/m' } } })),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    cancel: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
  } as unknown as Harness2Api;
}

function boot(): { store: AppStore; controller: Controller; workbench: WorkbenchStore } {
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions(
    sessionIds.map((id, index) => ({
      id,
      dir: 'd',
      cwd: 'D:/proj',
      mtimeMs: sessionIds.length - index,
      firstUserText: `会话 ${id}`,
      messageCount: 1,
      lastSeq: 1,
    })),
  );
  store.select('a');
  store.applyReplay(replayFor('a'));
  const api = makeApi();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return { store, controller: createController(store, api), workbench: new WorkbenchStore() };
}

const modelSelect: ComposerModelSelectProps = {
  menu: {
    current: { channel: 'zai', model: 'glm-5.3' },
    groups: [{ channel: 'zai', items: [{ channel: 'zai', model: 'glm-5.3', selected: true }] }],
  },
  onSelectModel: () => undefined,
};

const modeSwitch: ComposerModeSwitchProps = { mode: 'default', onModeChange: () => undefined };

const thoughtLevel: ComposerThoughtLevelProps = {
  current: 'high',
  values: ['low', 'medium', 'high'],
  onSelectLevel: () => undefined,
};

describe('WorkbenchHost composerControls 下发（Z3-04 注入链）', () => {
  it('未下发 → 控件不渲染（缺省调用面不变）', () => {
    const booted = boot();
    render(<WorkbenchHost store={booted.store} controller={booted.controller} workbench={booted.workbench} />);
    expect(screen.queryByTestId('composer-model-select')).toBeNull();
    expect(screen.queryByTestId('composer-mode-switch')).toBeNull();
    expect(screen.queryByTestId('composer-thought-level')).toBeNull();
    expect(screen.getByTestId('composer-primary')).toBeTruthy();
  });

  it('下发 → 每格出现模型选择与模式切换 trigger；模型菜单可开合且带「管理模型」', () => {
    const onManageModels = vi.fn();
    const booted = boot();
    render(
      <WorkbenchHost
        store={booted.store}
        controller={booted.controller}
        workbench={booted.workbench}
        composerControls={{
          modelSelect: { ...modelSelect, onManageModels },
          modeSwitch,
        }}
      />,
    );
    expect(screen.getByTestId('composer-model-select')).toBeTruthy();
    expect(screen.getByTestId('composer-mode-switch')).toBeTruthy();
    // 菜单真实可开（Radix keydown 打开）→ 选项与「管理模型」入口在
    fireEvent.keyDown(screen.getByTestId('composer-model-select'), { key: 'Enter' });
    expect(screen.getAllByTestId('composer-model-option')).toHaveLength(1);
    expect(screen.getByTestId('composer-model-manage')).toBeTruthy();
  });

  it('下发 thoughtLevel → 每格出现思考档位 trigger（Z10-2b 新增下发给席位）', () => {
    const booted = boot();
    render(
      <WorkbenchHost
        store={booted.store}
        controller={booted.controller}
        workbench={booted.workbench}
        composerControls={{ modeSwitch, thoughtLevel }}
      />,
    );
    expect(screen.getByTestId('composer-thought-level').getAttribute('aria-label')).toBe('思考档位：高');
  });
});
