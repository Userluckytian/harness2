// @vitest-environment jsdom
// Z-96 发送可见化（seat 级）：
//   - mock submit 失败 → 错误横幅出现（消息 = submit-ack unknown 的 reason）；
//   - 草稿保留回归：失败后编辑器文本仍在（现有还原逻辑，本用例锁住）；
//   - X 关闭 → 同错误不再弹（指纹去重）；用户重新提交同一失败 → 横幅重新出现（submit 重新布防）；
//   - connecting/无会话锁定态：发送钮 aria-label / data-disabled-reason 含原因（Z-96 改进）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import { ConversationSeat } from '../src/renderer/conversation/seat.js';
import type { HarnessClient } from '../src/renderer/ports.js';

afterEach(cleanup);

function connectedStoreWithSession(): AppStore {
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: 'hi', messageCount: 2, lastSeq: 2 },
  ]);
  store.select('s1');
  return store;
}

const editor = (): HTMLElement => screen.getByTestId('composer-editor');
/** 走 Composer 的真实粘贴分支送文本（jsdom 无 beforeinput 合成路径；fireEvent.input 会与 React 子树打架产生重复文本） */
const inputText = (text: string): void => {
  fireEvent.paste(editor(), { clipboardData: { getData: () => text } });
};
const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** api.submit 拒绝 → controller.submitMessage catch 路径落 submit-ack unknown（reason「提交未送达: …」） */
function apiWithFailingSubmit(message: string): HarnessClient {
  return {
    submit: vi.fn(async () => {
      throw new Error(message);
    }),
  } as unknown as HarnessClient;
}

describe('Z-96 发送失败错误横幅（seat 级）', () => {
  it('mock submit 失败 → 横幅出现 + 草稿文本仍在编辑器（保留回归）', async () => {
    const store = connectedStoreWithSession();
    const controller = createController(store, apiWithFailingSubmit('网络断了'));
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    inputText('要发的话');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    const banner = await screen.findByTestId('chat-error-banner');
    expect(banner.textContent).toContain('提交未送达');
    expect(banner.textContent).toContain('网络断了');
    // 草稿还原（composer 既有失败还原逻辑 —— 锁住）
    expect(editor().textContent).toBe('要发的话');
  });

  it('点 X 关闭后同错误不再弹；重新提交同一失败 → 横幅重新出现', async () => {
    const store = connectedStoreWithSession();
    const controller = createController(store, apiWithFailingSubmit('网络断了'));
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    inputText('A');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await screen.findByTestId('chat-error-banner');
    fireEvent.click(screen.getByTestId('chat-error-dismiss'));
    // 关掉后不再顶回（同指纹）
    await flush();
    expect(screen.queryByTestId('chat-error-banner')).toBeNull();
    // 再提交一次（同一失败）→ 重新布防 → 横幅再现
    fireEvent.keyDown(editor(), { key: 'Enter' });
    const again = await screen.findByTestId('chat-error-banner');
    expect(again.textContent).toContain('网络断了');
  });

  it('「查看详情」打开 Dialog（<pre> 承载原文）；「复制完整报错」走 clipboard', async () => {
    const store = connectedStoreWithSession();
    const controller = createController(store, apiWithFailingSubmit('boom'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    inputText('x');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await screen.findByTestId('chat-error-banner');
    // detail 来自底层 error.message（onSubmitError 回传）→ 有「查看详情」入口
    fireEvent.click(screen.getByTestId('chat-error-details'));
    const dialog = await screen.findByTestId('chat-error-detail-dialog');
    expect(dialog.querySelector('pre')).not.toBeNull();
    expect(screen.getByTestId('chat-error-detail-pre').textContent).toContain('boom');
    fireEvent.click(screen.getByTestId('chat-error-copy'));
    await flush();
    expect(writeText).toHaveBeenCalled();
  });

  it('重发成功（最新 ack=accepted）→ 旧失败横幅自然消失', async () => {
    const store = connectedStoreWithSession();
    let fail = true;
    const api = {
      submit: vi.fn(async () => {
        if (fail) throw new Error('暂时失败');
        return undefined;
      }),
    } as unknown as HarnessClient;
    const controller = createController(store, api);
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    inputText('重试我');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await screen.findByTestId('chat-error-banner');
    // 成功：ack=accepted（submit resolve 即 accepted 语义；此处 store 无 ack → 直接注一帧 accepted）
    fail = false;
    store.applyFrame({
      type: 'submit-ack',
      clientMessageId: 'whatever',
      sessionId: 's1',
      state: 'accepted',
    });
    await flush();
    expect(screen.queryByTestId('chat-error-banner')).toBeNull();
  });
});

describe('Z-96 禁用发送钮给原因（改进：ZCode 不解释，我们 tooltip + aria 说明）', () => {
  it('connecting（locked）→ aria-label 与 data-disabled-reason 含「未连接」', () => {
    const store = new AppStore();
    store.applyStatus('connecting');
    store.setSessions([{ id: 's1', dir: 'd', mtimeMs: 1, firstUserText: 'hi', messageCount: 1, lastSeq: 1 }]);
    store.select('s1');
    const controller = createController(store, {} as unknown as HarnessClient);
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    inputText('你好');
    const primary = screen.getByTestId('composer-primary');
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(primary.getAttribute('data-disabled-reason')).toContain('未连接');
    expect(primary.getAttribute('aria-label')).toContain('未连接');
  });

  it('无会话（sessionId undefined）→ 原因含「未选择会话」', () => {
    const store = new AppStore();
    store.applyStatus('connected');
    const controller = createController(store, {} as unknown as HarnessClient);
    render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
    // 空态：composer 常驻但 inert；此时无会话 → locked
    const primary = screen.getByTestId('composer-primary');
    expect(primary.getAttribute('data-disabled-reason')).toContain('未选择会话');
  });
});

void vi;
