// Z10-2 桌面装配级：会话 cwd → 项目 chip（cwd 末段）；gitBranch(cwd) → 分支 chip；null → 不渲染。
// 手法：真 AppStore + 真 ConversationSeat（桌面装配）+ 真 useSessionContextChips 钩子；仅
// window.harness2 是桩。无 cwd / 无分支即整项不渲染（不摆空 chip、不显示假分支名）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Harness2Api, SessionEventsPayloadShape } from '../../src/shared/protocol.js';
import { createController, type Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import { ConversationSeat } from '../../src/renderer/conversation/assembly.js';
import { useSessionContextChips } from '../../src/renderer/conversation/context-chips.js';

afterEach(cleanup);

const SESSION_ID = 's1';

function replayFor(id: string, cwd: string | undefined): SessionEventsPayloadShape {
  return {
    id,
    dir: 'd',
    header: { sessionId: id, ...(cwd !== undefined ? { cwd } : {}) },
    events: [],
    warnings: [],
    lastSeq: 0,
  };
}

interface BootOptions {
  /** 显式指定 cwd；`noCwd: true` = 会话无 cwd（两者择一） */
  readonly cwd?: string;
  readonly noCwd?: boolean;
  readonly gitBranch?: string | null;
}

function boot(options: BootOptions = {}): { store: AppStore; controller: Controller } {
  const cwd = options.noCwd === true ? undefined : (options.cwd ?? 'D:/AI_Projects/harness2');
  const api = {
    gitBranch: vi.fn(async () => options.gitBranch ?? 'main'),
  } as unknown as Harness2Api;
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    {
      id: SESSION_ID,
      dir: 'd',
      ...(cwd !== undefined ? { cwd } : {}),
      mtimeMs: 10,
      firstUserText: 'x',
      messageCount: 0,
      lastSeq: 0,
    },
  ]);
  store.select(SESSION_ID);
  store.applyReplay(replayFor(SESSION_ID, cwd));
  return { store, controller: createController(store, api) };
}

/** 真钩子 + 真席位：钩子产出 chip 数据面，席位透传到 Composer（端到端可断言 DOM）。 */
function ChipsHarness({
  store,
  controller,
  sessionId,
}: {
  readonly store: AppStore;
  readonly controller: Controller;
  readonly sessionId: string | null;
}): React.ReactNode {
  const chips = useSessionContextChips(store, sessionId);
  return (
    <ConversationSeat
      store={store}
      controller={controller}
      sessionId={sessionId}
      header={() => null}
      statusPanel={() => null}
      {...(chips !== undefined ? { contextChips: chips } : {})}
    />
  );
}

describe('Z10-2 桌面 chip 装配（会话 cwd + gitBranch）', () => {
  it('有 cwd 会话 → 项目 chip 文案 = cwd 末段；gitBranch 返回 main → 分支 chip 显示 main（均只读）', async () => {
    const { store, controller } = boot({ cwd: 'D:/AI_Projects/harness2', gitBranch: 'main' });
    render(<ChipsHarness store={store} controller={controller} sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByTestId('composer-context-chip-branch').textContent).toBe('main'));
    const project = screen.getByTestId('composer-context-chip-project') as HTMLButtonElement;
    expect(project.textContent).toBe('harness2');
    // 两 chip 均只读（本仓无切换通道）：disabled + title 说明
    expect(project.disabled).toBe(true);
    expect(project.getAttribute('title')).toBe('暂不支持切换项目');
    expect((screen.getByTestId('composer-context-chip-branch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('gitBranch 返回 null → 不渲染分支 chip（但项目 chip 仍在，不显示假分支名）', async () => {
    const { store, controller } = boot({ gitBranch: null });
    render(<ChipsHarness store={store} controller={controller} sessionId={SESSION_ID} />);

    expect(screen.getByTestId('composer-context-chip-project').textContent).toBe('harness2');
    await waitFor(() => expect(screen.queryByTestId('composer-context-chip-branch')).toBeNull());
  });

  it('会话无 cwd → 项目 chip 不渲染（且无 cwd 无从查分支：分支 chip 也不渲染）', async () => {
    const { store, controller } = boot({ noCwd: true, gitBranch: 'main' });
    render(<ChipsHarness store={store} controller={controller} sessionId={SESSION_ID} />);

    // 无 cwd = 无项目名、也无从调 gitBranch(cwd) → 两项都缺 → 整行不渲染
    await waitFor(() => expect(screen.queryByTestId('composer-context-chips')).toBeNull());
    expect(screen.queryByTestId('composer-context-chip-project')).toBeNull();
    expect(screen.queryByTestId('composer-context-chip-branch')).toBeNull();
  });

  it('无会话（sessionId=null）→ 整行不渲染', () => {
    const { store, controller } = boot();
    render(<ChipsHarness store={store} controller={controller} sessionId={null} />);
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();
  });
});
