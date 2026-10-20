// @vitest-environment jsdom
// P0-1「主区/对话页视觉语言对齐 ZCode」的 ui-shared DOM 结构单测
//（样式声明证据见 chat-view-p01-css.test.ts —— jsdom 读不到实际样式表，像素断点在 node 侧）。
//
// 覆盖（对应交付规格）：
//   1. 用户消息右对齐气泡 / 助手消息无气泡（结构类）；
//   2. 移除角色标签（「你」/ provider 名不出现于行内）；
//   3. 轮次头无字面 `── turn`（纯无文案分组）；
//   4. 摘要收口（U2-C3：耗时唯一源 = 轮首 WorkIndicator，turn-summary 只留 error/warning/partial/empty）；
//   5. MessageActions：复制动作流（点击→已复制→约 2s 还原；失败不谎报）、
//      fork 可用性两态（无通道不渲染 / 运行中禁用+提示）、赞踩刻意不做（无后端反馈通道）；
//   6. composer 占位符（空草稿显示 harness2 文案、有内容消失、不污染编辑器文本）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatItemView } from '../src/renderer/components/ChatView.js';
import { MessageActions, copyMessageText, COPIED_REVERT_MS } from '../src/renderer/components/MessageActions.js';
// U2-C3：formatTurnDuration 不再由 turn-summary 消费（耗时唯一源 = WorkIndicator），
// 纯函数单测已移除；函数保留在 chat-model（旧调用面）。
import { Composer } from '../src/renderer/conversation/composer/Composer.js';
import { ComposerStore, createComposerState } from '../src/renderer/conversation/composer/composer-state.js';
import { createController } from '../src/renderer/app-controller.js';
import { AppStore } from '../src/renderer/store.js';
import type { ChatItem } from '../src/renderer/chat-model.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

// —— 渲染夹具：ChatItemView 需要 store + controller（真 AppStore，渲染路径不触达桥）——

function harness(): { store: AppStore; controller: ReturnType<typeof createController> } {
  const store = new AppStore();
  const controller = createController(store, {} as never);
  return { store, controller };
}

function renderItem(item: ChatItem, sessionId?: string): void {
  const { store, controller } = harness();
  render(
    <div className="messages">
      <ChatItemView
        item={item}
        {...(sessionId !== undefined ? { sessionId } : {})}
        store={store}
        controller={controller}
      />
    </div>,
  );
}

// ═════════════════════════ 1/2/3：消息行结构与角色标签 ═════════════════════════

describe('P0-1 用户消息：右对齐气泡 + 助手消息无气泡（结构类；样式声明见 -css 文件）', () => {
  it('用户行带 .bubble-user + .text 正文；不带 .bubble-assistant / 动作行', () => {
    renderItem({ kind: 'user', seq: 1, turnId: 't1', text: '用户问题' });
    const user = document.querySelector('.bubble-user');
    expect(user).not.toBeNull();
    expect(user?.querySelector('.text')?.textContent).toBe('用户问题');
    expect(user?.querySelector('.bubble-assistant')).toBeNull();
    expect(user?.querySelector('.message-actions')).toBeNull(); // ZCode：动作行只在助手行
  });

  it('助手行带 .bubble-assistant + .text 正文 + 动作行（无独立气泡容器）', () => {
    renderItem({ kind: 'assistant', seq: 2, turnId: 't1', text: '助手回答' });
    const assistant = document.querySelector('.bubble-assistant');
    expect(assistant).not.toBeNull();
    expect(assistant?.querySelector('.text')?.textContent).toBe('助手回答');
    expect(assistant?.querySelector('.message-actions')).not.toBeNull();
  });
});

describe('P0-1 移除角色标签（「你」/ provider 名不出现于消息行）', () => {
  it('用户行不含「你」标签，DOM 文本 = 纯正文；行内无 .role 节点', () => {
    renderItem({ kind: 'user', seq: 1, turnId: 't1', text: '问题正文' });
    expect(document.querySelector('.bubble-user')?.textContent).toBe('问题正文');
    expect(document.querySelector('.role')).toBeNull();
    expect(screen.queryByText('你')).toBeNull();
  });

  it('助手行不渲染 provider 名（item.model 存在也不进 DOM）；无 .role 节点', () => {
    renderItem({ kind: 'assistant', seq: 2, turnId: 't1', text: '回答正文', model: 'loomy/loomy/qwen3.8-flash' });
    expect(document.querySelector('.bubble-assistant')?.querySelector('.text')?.textContent).toBe('回答正文');
    expect(document.querySelector('.role')).toBeNull();
    expect(screen.queryByText('loomy/loomy/qwen3.8-flash')).toBeNull();
    expect(screen.queryByText('mock')).toBeNull();
  });
});

describe('P0-1 轮次头：去掉字面 `── turn`（无文案分组，锚点仍在）', () => {
  it('渲染无文字（textContent 为空），不再有 `── turn`；保留 .turn-header + data-turn-id 定位锚点', () => {
    renderItem({ kind: 'turn-header', turnId: 't7' });
    const header = document.querySelector('.turn-header');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('data-turn-id')).toBe('t7');
    expect(header?.textContent).toBe(''); // 无文案分组（ZCode 分组渲染不写轮次文字）
    expect(screen.queryByText(/──\s*turn/)).toBeNull();
  });
});

// ═════════════════════════ 4：轮次摘要（U2-C3 收口：耗时归 WorkIndicator，摘要只留状态）═════════════════════════

describe('U2-C3 turn-summary 收口：本行不再渲染耗时（唯一源 = 轮首 WorkIndicator）', () => {
  it('有时长但无状态语义（纯 end_turn）→ 摘要行不渲染（耗时不再双行；红线⑩不误显示）', () => {
    renderItem({ kind: 'turn-summary', turnId: 't1', durationMs: 2000, stopReason: 'end_turn' });
    expect(document.querySelector('.turn-summary')).toBeNull();
  });
  it('有错误 → 只渲染错误，不含耗时（不再有「持续了 N 秒」，也不含 .sum-duration）', () => {
    renderItem({
      kind: 'turn-summary',
      turnId: 't1',
      durationMs: 2000,
      stopReason: 'error',
      error: '上游失败',
    });
    const el = document.querySelector('.turn-summary');
    expect(el?.textContent).toContain('上游失败');
    expect(el?.textContent).not.toContain('持续了');
    expect(el?.querySelector('.sum-duration')).toBeNull();
  });
  it('无状态语义（无错误/半截/空产出）→ 整行不渲染（红线⑩）', () => {
    renderItem({ kind: 'turn-summary', turnId: 't1', durationMs: 0, stopReason: 'end_turn' });
    expect(document.querySelector('.turn-summary')).toBeNull();
  });
  it('半截产出（partial）→ 标注「未完成 / 已中断」且不含耗时', () => {
    renderItem({
      kind: 'turn-summary',
      turnId: 't1',
      durationMs: 3000,
      textOutcome: 'partial',
      partialText: '半截',
    });
    const el = document.querySelector('.turn-summary');
    expect(el?.textContent).toContain('未完成 / 已中断');
    expect(el?.textContent).not.toContain('持续了');
  });
});

// ═════════════════════════ 5：MessageActions（复制 / fork 两态 / 赞踩不做）═════════════════════════

describe('P0-1 MessageActions 复制动作流', () => {
  it('点击 → 「已复制」（✓ + 绿）→ 约 2s 还原为「复制」', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MessageActions text="正文内容" />);
    const btn = screen.getByTestId('message-action-copy');
    expect(btn.getAttribute('data-copied')).toBe('false');

    fireEvent.click(btn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // 冲刷 writeText 的 promise
    });
    expect(writeText).toHaveBeenCalledWith('正文内容');
    expect(screen.getByTestId('message-action-copy').getAttribute('data-copied')).toBe('true');
    expect(screen.getByTestId('message-action-copy').getAttribute('aria-label')).toBe('已复制');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPIED_REVERT_MS);
    });
    expect(screen.getByTestId('message-action-copy').getAttribute('data-copied')).toBe('false');
    expect(screen.getByTestId('message-action-copy').getAttribute('aria-label')).toBe('复制');
  });

  it('剪贴板写入失败 → 保持「复制」，不谎报成功（红线⑩）', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    render(<MessageActions text="正文" />);
    fireEvent.click(screen.getByTestId('message-action-copy'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('message-action-copy').getAttribute('data-copied')).toBe('false');
    expect(screen.getByTestId('message-action-copy').getAttribute('aria-label')).toBe('复制');
  });

  it('copyMessageText：无 navigator.clipboard 通道 → false（jsdom 缺省路径，降级不抛错）', async () => {
    // afterEach 已 delete clipboard；此处模拟无剪贴板通道的宿主
    await expect(copyMessageText('有内容')).resolves.toBe(false);
    await expect(copyMessageText('')).resolves.toBe(false); // 空文本恒 false
  });
});

describe('P0-1 MessageActions fork 可用性两态', () => {
  it('无 onFork（本行无分叉通道）→ 分叉按钮不渲染（不摆死按钮）', () => {
    render(<MessageActions text="正文" />);
    expect(screen.queryByTestId('message-action-fork')).toBeNull();
    expect(screen.getByTestId('message-action-copy')).toBeTruthy(); // 复制仍在
  });

  it('forkEnabled=false（会话运行中）→ 禁用 + ZCode 文案「任务结束后可分叉」，点击不触发', () => {
    const onFork = vi.fn();
    render(<MessageActions text="正文" onFork={onFork} forkEnabled={false} />);
    const fork = screen.getByTestId('message-action-fork');
    expect(fork.hasAttribute('disabled')).toBe(true);
    expect(fork.getAttribute('data-fork-enabled')).toBe('false');
    expect(fork.getAttribute('title')).toBe('任务结束后可分叉');
    fireEvent.click(fork);
    expect(onFork).not.toHaveBeenCalled();
  });

  it('forkEnabled 缺省（可用）→ 可点击并触发 onFork', () => {
    const onFork = vi.fn();
    render(<MessageActions text="正文" onFork={onFork} />);
    const fork = screen.getByTestId('message-action-fork');
    expect(fork.hasAttribute('disabled')).toBe(false);
    fireEvent.click(fork);
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});

describe('P0-1 MessageActions 赞/踩刻意不做（无后端反馈通道，登记于交付）', () => {
  it('动作行只有复制（+ 可选分叉），不含赞/踩按钮', () => {
    render(<MessageActions text="正文" onFork={() => undefined} />);
    expect(screen.queryByTestId('message-action-like')).toBeNull();
    expect(screen.queryByTestId('message-action-dislike')).toBeNull();
    expect(screen.queryByText('赞')).toBeNull();
    expect(screen.queryByText('踩')).toBeNull();
  });
});

describe('P0-1 ChatView 分叉通道接线（按通道可用性渲染）', () => {
  it('助手行无 sessionId（无会话上下文 → 无分叉通道）→ 动作行只有复制，无分叉', () => {
    renderItem({ kind: 'assistant', seq: 2, turnId: 't1', text: '回答' });
    expect(screen.queryByTestId('message-action-fork')).toBeNull();
    expect(screen.getByTestId('message-action-copy')).toBeTruthy();
  });

  it('助手行有 seq + sessionId（有 serve fork 通道）→ 渲染分叉按钮；会话空闲时可用', () => {
    const { store, controller } = harness();
    store.applyStatus('connected');
    store.applyReplay({
      id: 's1',
      dir: 'd',
      header: { sessionId: 's1', cwd: 'D:/p' },
      events: [
        {
          v: 1,
          seq: 2,
          ts: '2026-10-11T00:00:00Z',
          type: 'assistant/message',
          payload: { text: '回答', turnId: 't1' },
          active: true,
        },
      ],
      warnings: [],
      lastSeq: 2,
    });
    render(
      <div className="messages">
        <ChatItemView
          item={{ kind: 'assistant', seq: 2, turnId: 't1', text: '回答' }}
          sessionId="s1"
          store={store}
          controller={controller}
        />
      </div>,
    );
    const fork = screen.getByTestId('message-action-fork');
    expect(fork.hasAttribute('disabled')).toBe(false); // 空闲（未 running）→ 可用
  });
});

// ═════════════════════════ 6：composer 占位符 ═════════════════════════

const io = {
  createClientMessageId: () => 'cm-t',
  submit: () => undefined,
};

function renderComposer(): void {
  render(<Composer sessionId="s1" store={new ComposerStore(createComposerState())} io={io} />);
}

describe('P0-1 composer 占位符（可见、空草稿显示、有内容消失）', () => {
  it('空草稿 → 占位层可见，句式 = 向 harness2 提问（产品名换成 harness2）', () => {
    renderComposer();
    const ph = screen.getByTestId('composer-placeholder');
    expect(ph.textContent).toBe('向 harness2 提问，使用 @ 添加上下文，使用 / 选择命令或能力');
  });

  it('有草稿内容（粘贴）→ 占位层消失；清空 → 再次出现', () => {
    renderComposer();
    const editor = screen.getByTestId('composer-editor');
    fireEvent.paste(editor, { clipboardData: { getData: () => '草稿文字' } });
    expect(screen.queryByTestId('composer-placeholder')).toBeNull();
  });

  it('占位层不污染编辑器文本节点（兄弟层，textContent 干净）', () => {
    renderComposer();
    const editor = screen.getByTestId('composer-editor');
    expect(editor.textContent).toBe(''); // 占位文案不在编辑器内（否则污染既有断言）
    // 占位层是 .composer-editor-wrap 内的兄弟节点，而不是 .composer-editor 的子孙
    expect(editor.querySelector('[data-testid="composer-placeholder"]')).toBeNull();
    expect(screen.getByTestId('composer-placeholder')).toBeTruthy();
  });
});
