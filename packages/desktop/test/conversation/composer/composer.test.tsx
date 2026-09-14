// @vitest-environment jsdom
// Composer 组件装配测试（D-33 常驻挂载 / D-34 同事务提交 / D-35~D-36 按钮与投递 / D-37 附件 / D-38 takeover）。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { Composer, type ComposerIO } from '../../../src/renderer/conversation/composer/Composer.js';
import {
  ComposerStore,
  createComposerState,
  insertChip,
  insertText,
  type ComposerChip,
  type PendingSubmission,
} from '../../../src/renderer/conversation/composer/composer-state.js';
import {
  ComposerChain,
  type ComposerChainProps,
  type ComposerSessionSnapshot,
} from '../../../src/renderer/conversation/composer/composer-chain.js';
import type {
  ImageReadIO,
  UploadTask,
  UploadTransport,
} from '../../../src/renderer/conversation/composer/attachments.js';
import type { BusyEnterBehavior } from '../../../src/renderer/conversation/composer/submit-policy.js';

afterEach(cleanup);

const chip = (id: string, label: string): ComposerChip => ({
  kind: 'chip',
  id,
  label,
  reference: { id: `ref-${id}`, kind: 'file', path: label.replace(/^@/, '') },
});

interface SetupOptions {
  readonly sessionId?: string | undefined;
  readonly session?: ComposerSessionSnapshot;
  readonly running?: boolean;
  readonly busyEnter?: BusyEnterBehavior;
  readonly steeringAvailable?: boolean;
  readonly locked?: boolean;
  readonly chain?: ComposerChain;
  readonly imageIO?: ImageReadIO;
  readonly transport?: UploadTransport;
  readonly submitImpl?: (submission: PendingSubmission) => Promise<unknown>;
  readonly seed?: (store: ComposerStore) => void;
  readonly store?: ComposerStore;
}

function setup(options: SetupOptions = {}) {
  const store = options.store ?? new ComposerStore();
  options.seed?.(store);
  const submit = vi.fn(options.submitImpl ?? (() => Promise.resolve()));
  const stop = vi.fn();
  const io: ComposerIO = {
    createClientMessageId: () => 'cm-1',
    submit,
    stop,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  };
  const props: React.ComponentProps<typeof Composer> = {
    sessionId: 'sessionId' in options ? options.sessionId : 's1',
    io,
    store,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.running !== undefined ? { running: options.running } : {}),
    ...(options.busyEnter !== undefined ? { busyEnter: options.busyEnter } : {}),
    ...(options.steeringAvailable !== undefined ? { steeringAvailable: options.steeringAvailable } : {}),
    ...(options.locked !== undefined ? { locked: options.locked } : {}),
    ...(options.chain !== undefined ? { chain: options.chain } : {}),
    ...(options.imageIO !== undefined ? { imageIO: options.imageIO } : {}),
  };
  const view = render(<Composer {...props} />);
  return { store, submit, stop, props, view };
}

const editor = (): HTMLElement => screen.getByTestId('composer-editor');
const primary = (): HTMLButtonElement => screen.getByTestId('composer-primary') as HTMLButtonElement;
const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('D-33 常驻挂载（无会话 ↔ 有会话不卸载）', () => {
  it('无会话：编辑器保持挂载但 inert；切到有会话：同一节点复用', () => {
    const { props, view } = setup({ sessionId: undefined });
    const before = editor();
    expect(before).toBeTruthy();
    expect(before.getAttribute('aria-disabled')).toBe('true');
    expect(primary().disabled).toBe(true);
    expect((screen.getByTestId('composer-attach') as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<Composer {...props} sessionId="s1" />);
    expect(editor()).toBe(before); // 常驻：不因无会话/有会话切换重挂
    expect(editor().getAttribute('aria-disabled')).toBeNull();
  });

  it('chip 以原子节点渲染（contentEditable=false），文本节点独立', () => {
    const { store } = setup({
      seed: (s) => {
        s.dispatch({ type: 'insert-text', text: '见' });
        s.dispatch({ type: 'insert-chip', chip: chip('c1', '@a.ts') });
        s.dispatch({ type: 'insert-text', text: '了' });
      },
    });
    expect(store.getState().atoms).toHaveLength(3);
    expect(editor().textContent).toBe('见@a.ts了');
    const chipNode = editor().querySelector('[data-atom="chip"]');
    expect(chipNode).not.toBeNull();
    expect(chipNode?.getAttribute('contenteditable')).toBe('false');
    expect(editor().querySelectorAll('[data-atom="text"]')).toHaveLength(2);
  });

  it('退格紧贴 chip 之后：DOM 层整体删除 chip，文本保留', () => {
    const { store } = setup({
      seed: (s) => {
        s.dispatch({ type: 'insert-text', text: '见' });
        s.dispatch({ type: 'insert-chip', chip: chip('c1', '@a.ts') });
        s.dispatch({ type: 'insert-text', text: '了' });
        s.dispatch({ type: 'set-caret', caret: { node: 2, offset: 0 } }); // chip 之后
      },
    });
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(store.getState().atoms.some((a) => a.kind === 'chip')).toBe(false);
    expect(editor().textContent).toBe('见了');
  });
});

describe('D-34 乐观提交（Enter 同事务）', () => {
  it('Enter 后草稿立即空、历史为空、只一个批次，提交载荷 = detached attempt', () => {
    const { store, submit } = setup({ seed: (s) => s.dispatch({ type: 'insert-text', text: 'hello' }) });
    const batchesBefore = store.batches;
    fireEvent.keyDown(editor(), { key: 'Enter' });

    expect(submit).toHaveBeenCalledTimes(1);
    const submission = submit.mock.calls[0]?.[0];
    expect(submission?.rawText).toBe('hello');
    expect(submission?.intent).toBe('queue'); // 空闲 → transcript（intent 仍 queue）
    expect(submission?.placement).toBe('transcript');
    expect(editor().textContent).toBe('');
    expect(store.getState().atoms).toHaveLength(0);
    expect(store.getState().history).toHaveLength(0);
    expect(store.batches).toBe(batchesBefore + 1);
  });

  it('Shift+Enter 换行不提交；IME 组合中的 Enter 不提交', () => {
    const { submit } = setup({ seed: (s) => s.dispatch({ type: 'insert-text', text: 'x' }) });
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 229 }); // 旧式 Windows 输入法组合期
    expect(submit).not.toHaveBeenCalled();
  });

  it('发送失败：草稿与附件按原顺序恢复，不自动重发', async () => {
    const transport: UploadTransport = { upload: async () => ({ token: 'tok-f1' }) };
    const { store, submit } = setup({
      transport,
      submitImpl: () => Promise.reject(new Error('提交未送达')),
      seed: (s) => s.dispatch({ type: 'insert-text', text: '重提我' }),
    });
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'a.bin', type: 'application/octet-stream', size: 1 }] },
    });
    await flush();
    expect(store.getState().atoms.length).toBeGreaterThan(0);
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(1);
    await flush();
    // 失败后草稿复原；附件仍在（列表里 failed 项可重提）
    expect(editor().textContent).toBe('重提我');
    expect(screen.getByTestId('composer-attachments')).toBeTruthy();
  });
});

describe('D-35 / D-36 投递与主按钮', () => {
  it('繁忙 + 偏好 queue：Enter 进 queue-dock，主按钮「排队发送」', () => {
    const { submit } = setup({
      running: true,
      busyEnter: 'queue',
      seed: (s) => s.dispatch({ type: 'insert-text', text: '追问' }),
    });
    expect(primary().textContent).toBe('排队发送');
    expect(primary().getAttribute('data-kind')).toBe('send');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(submit.mock.calls[0]?.[0]?.placement).toBe('queue-dock');
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('queue');
  });

  it('繁忙 + 偏好 steer：Enter 进 pending-steering 并绑定 turnId，主按钮「插话发送」', () => {
    const { submit } = setup({
      running: true,
      busyEnter: 'steer',
      session: { id: 's1', running: true, activeTurnId: 'turn-9' },
      seed: (s) => s.dispatch({ type: 'insert-text', text: '改方向' }),
    });
    expect(primary().textContent).toBe('插话发送');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    const submission = submit.mock.calls[0]?.[0];
    expect(submission?.intent).toBe('steer');
    expect(submission?.placement).toBe('pending-steering');
    expect(submission?.expectedTurnId).toBe('turn-9');
  });

  it('Cmd/Ctrl+Enter 恒用另一模式（繁忙 queue → steer）', () => {
    const { submit } = setup({
      running: true,
      busyEnter: 'queue',
      session: { id: 's1', running: true, activeTurnId: 'turn-1' },
      seed: (s) => s.dispatch({ type: 'insert-text', text: 'x' }),
    });
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('steer');
    expect(submit.mock.calls[0]?.[0]?.placement).toBe('pending-steering');
  });

  it('繁忙 + `/` 命令行：主按钮保留普通「发送」标签', () => {
    setup({
      running: true,
      busyEnter: 'steer',
      seed: (s) => s.dispatch({ type: 'insert-text', text: '/plan 做' }),
    });
    expect(primary().textContent).toBe('发送');
    expect(primary().getAttribute('data-label-kind')).toBe('input.send');
  });

  it('繁忙 + 空草稿：主按钮切到 Stop，点击只停止不提交', () => {
    const { submit, stop } = setup({ running: true });
    expect(primary().getAttribute('data-kind')).toBe('stop');
    expect(primary().textContent).toBe('■ 停止');
    fireEvent.click(primary());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('空闲 + 空草稿：Send 禁用且标签仍是「发送」', () => {
    setup({});
    expect(primary().getAttribute('data-kind')).toBe('send');
    expect(primary().textContent).toBe('发送');
    expect(primary().disabled).toBe(true);
  });

  it('空闲 + 草稿：点击提交 transcript', () => {
    const { submit } = setup({ seed: (s) => s.dispatch({ type: 'insert-text', text: '你好' }) });
    expect(primary().disabled).toBe(false);
    fireEvent.click(primary());
    expect(submit.mock.calls[0]?.[0]?.placement).toBe('transcript');
  });

  it('繁忙 + 仍有文件在传：主按钮禁用（不提交半传附件）', async () => {
    let release!: (t: { token: string }) => void;
    const transport: UploadTransport = {
      upload: (_task: UploadTask) =>
        new Promise<{ token: string }>((resolve) => {
          release = resolve;
        }),
    };
    setup({ running: true, transport, seed: (s) => s.dispatch({ type: 'insert-text', text: 'x' }) });
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'big.bin', type: 'application/octet-stream', size: 10 }] },
    });
    expect(primary().disabled).toBe(true);
    await act(async () => {
      release({ token: 'tok' });
      await Promise.resolve();
    });
    expect(primary().disabled).toBe(false);
  });
});

describe('D-37 附件', () => {
  it('图片走 data URL（本地预览）；因无图片通道如实标 failed；文件走上传队列；附件顺序 = 选择顺序', async () => {
    const imageIO: ImageReadIO = {
      createReader: () => {
        const reader = {
          result: null as string | ArrayBuffer | null,
          error: null,
          onload: null as (() => void) | null,
          onerror: null as (() => void) | null,
          readAsDataURL: () => {
            reader.result = 'data:image/png;base64,AAAA';
            queueMicrotask(() => reader.onload?.());
          },
        };
        return reader;
      },
    };
    const transport: UploadTransport = { upload: async (t) => ({ token: `tok-${t.id}` }) };
    const { submit } = setup({ imageIO, transport, seed: (s) => s.dispatch({ type: 'insert-text', text: '看图' }) });

    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: {
          files: [
            { name: 'notes.txt', type: 'text/plain', size: 3 },
            { name: 'shot.png', type: 'image/png', size: 4 },
          ],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const list = screen.getByTestId('composer-attachments');
    expect(list.textContent).toContain('notes.txt');
    expect(list.textContent).toContain('shot.png');
    // P1-3：图片不显示为 ready —— 提交协议没有图片字节通道，如实标 failed 并说明原因
    expect(list.querySelector('.att-ready')?.textContent).toContain('notes.txt');
    const failed = list.querySelector('.att-failed');
    expect(failed?.textContent).toContain('shot.png');
    expect(failed?.textContent).toContain('图片通道未实现');
    // 本地预览是真的（data URL 缩略图），但不代表能送出去
    expect(failed?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    const submission = submit.mock.calls[0]?.[0];
    expect(submission?.attachments.map((a) => a.kind)).toEqual(['file', 'image']);
    expect(submission?.attachments.map((a) => a.name)).toEqual(['notes.txt', 'shot.png']);
    expect(submission?.attachments[0]?.token).toBe('tok-att-s1-1');
    expect(submission?.attachments[0]?.state).toBe('ready');
    expect(submission?.attachments[1]?.state).toBe('failed'); // 图片从未 ready（不伪造）
    // 提交后附件同批清空
    expect(screen.queryByTestId('composer-attachments')).toBeNull();
  });

  it('无上传通道时文件标失败并说明（不静默丢弃）', async () => {
    setup({ seed: () => undefined });
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'x.bin', type: 'application/octet-stream', size: 1 }] },
    });
    await flush();
    expect(screen.getByTestId('composer-attachments').textContent).toContain('未配置文件上传通道');
  });
});

describe('D-38 composer 链 takeover', () => {
  it('命中 selector 时渲染 takeover，默认 composer 保持挂载（hidden）', () => {
    const Takeover = (props: ComposerChainProps & { matched: { tag: string } }): React.ReactNode => (
      <div data-testid="takeover-body">{props.matched.tag}</div>
    );
    const chain = new ComposerChain();
    chain.register({
      owner: 'business',
      select: (owner) => (owner.sessionId === 's1' ? { tag: 'request-1' } : null),
      component: Takeover,
    });
    setup({ chain });
    expect(screen.getByTestId('takeover-body').textContent).toBe('request-1');
    const defaultSlot = screen.getByTestId('composer-default');
    expect(defaultSlot.hasAttribute('hidden')).toBe(true);
    expect(editor()).toBeTruthy(); // 默认 composer 未卸载
  });

  it('无命中（sessionId 不匹配）时不渲染 takeover，默认 composer 可用', () => {
    const chain = new ComposerChain();
    chain.register({
      owner: 'business',
      select: (owner) => (owner.sessionId === 'other' ? { tag: 'x' } : null),
      component: () => <div data-testid="takeover-body" />,
    });
    setup({ chain });
    expect(screen.queryByTestId('composer-takeover')).toBeNull();
    expect(screen.getByTestId('composer-default').hasAttribute('hidden')).toBe(false);
  });
});

// 引用 createComposerState / insertText / insertChip 保持纯函数覆盖面（组件走 store.dispatch 同一实现）
describe('草稿原语与组件共用同一实现', () => {
  it('insertText/insertChip 与 store.dispatch 结果一致', () => {
    const store = new ComposerStore();
    store.dispatch({ type: 'insert-text', text: 'a' });
    store.dispatch({ type: 'insert-chip', chip: chip('c1', '@a.ts') });
    let expected = createComposerState();
    expected = insertChip(insertText(expected, 'a'), chip('c1', '@a.ts'));
    expect(store.getState().atoms).toEqual(expected.atoms);
  });
});

// —— P0-2 / P1-1 / P2-1 / P2-2 修复后的组件级取证 ——

describe('P0-2 失败还原（上游 facade.ts:793-868）：不覆盖用户新输入 / 并发失败合并', () => {
  it('提交 A → 用户输入 B → A 失败：草稿仍是 B（B 不丢），并显示失败原因', async () => {
    let reject!: (error: unknown) => void;
    const { store } = setup({
      submitImpl: () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
      seed: (s) => s.dispatch({ type: 'insert-text', text: 'A' }),
    });
    fireEvent.keyDown(editor(), { key: 'Enter' }); // 提交 A（草稿同事务清空）
    await flush();
    expect(editor().textContent).toBe('');

    await act(async () => {
      store.dispatch({ type: 'insert-text', text: 'B' }); // 用户在失败回来前输入 B
    });
    expect(editor().textContent).toBe('B');

    await act(async () => {
      reject(new Error('提交未送达'));
      await Promise.resolve();
    });
    expect(editor().textContent).toBe('B'); // 绝不被 A 覆盖
    const status = screen.getByTestId('composer-status');
    expect(status.getAttribute('data-kind')).toBe('error');
    expect(status.textContent).toContain('提交未送达');
    expect(status.textContent).toContain('未被覆盖');
  });

  it('并发两个失败：按提交顺序用空行合并还原（不互相覆盖）', async () => {
    const settle: Array<(error: unknown) => void> = [];
    const { store } = setup({
      submitImpl: () =>
        new Promise((_resolve, rej) => {
          settle.push(rej);
        }),
    });
    await act(async () => {
      fireEvent.paste(editor(), { clipboardData: { getData: () => '第一条' } });
    });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await act(async () => {
      fireEvent.paste(editor(), { clipboardData: { getData: () => '第二条' } });
    });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(settle).toHaveLength(2);
    expect(store.getState().atoms).toHaveLength(0);

    // 乱序落定也要按提交顺序合并
    await act(async () => {
      settle[1]?.(new Error('第二条失败'));
      await Promise.resolve();
    });
    await act(async () => {
      settle[0]?.(new Error('第一条失败'));
      await Promise.resolve();
    });
    expect(editor().textContent).toBe('第一条\n\n第二条');
    expect(store.getState().atoms).toEqual([{ kind: 'text', text: '第一条\n\n第二条' }]);
  });

  it('失败还原后用户没编辑 → 再提交时清台账（不把还原内容重复合并）', async () => {
    const settle: Array<(error: unknown) => void> = [];
    const { store, submit } = setup({
      submitImpl: () =>
        new Promise((_resolve, rej) => {
          settle.push(rej);
        }),
      seed: (s) => s.dispatch({ type: 'insert-text', text: 'A' }),
    });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await act(async () => {
      settle[0]?.(new Error('失败'));
      await Promise.resolve();
    });
    expect(editor().textContent).toBe('A'); // 还原
    // 用户未编辑直接重提 → 提交边界清台账
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(2);
    await act(async () => {
      settle[1]?.(new Error('又失败'));
      await Promise.resolve();
    });
    expect(editor().textContent).toBe('A'); // 不是 'A\n\nA'
    expect(store.getState().revision).toBeGreaterThan(0);
  });
});

describe('P1-1 引用入口（零入口 → 真实可点 + 真实效果）', () => {
  it('点击「引用」按钮在光标处插入 @ 起始符（不伪造路径，解析在提交边界做）', () => {
    const { store } = setup({});
    const button = screen.getByTestId('composer-reference') as HTMLButtonElement;
    expect(button.textContent).toBe('引用');
    fireEvent.click(button);
    expect(store.getState().atoms).toEqual([{ kind: 'text', text: '@' }]);
    expect(editor().textContent).toBe('@');
    // 有草稿内容后主按钮可提交（引用不再依赖不存在的 chip 入口）
    expect(primary().disabled).toBe(false);
  });

  it('无会话时引用入口与主按钮一同禁用（inert 口径一致）', () => {
    setup({ sessionId: undefined });
    expect((screen.getByTestId('composer-reference') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('P2-1 placement 的真实落点、P2-2 链订阅', () => {
  it('提交后状态行按 placement 显示落点（空闲 transcript / 繁忙 queue-dock / steer）', () => {
    const idle = setup({ seed: (s) => s.dispatch({ type: 'insert-text', text: '你好' }) });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(screen.getByTestId('composer-status').textContent).toContain('已发送（transcript）');
    idle.view.unmount();

    setup({ running: true, busyEnter: 'queue', seed: (s) => s.dispatch({ type: 'insert-text', text: '排队' }) });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(screen.getByTestId('composer-status').textContent).toContain('已排队（queue-dock）');
  });

  it('P2-2：运行中新注册的 takeover 立即生效（Composer 订阅链版本，不再只在渲染期 select）', () => {
    const chain = new ComposerChain();
    setup({ chain });
    expect(screen.queryByTestId('takeover-body')).toBeNull();

    act(() => {
      chain.register({
        owner: 'late-business',
        select: () => ({ tag: 'late-1' }),
        component: (props) => <div data-testid="takeover-body">{(props.matched as { tag: string }).tag}</div>,
      });
    });
    expect(screen.getByTestId('takeover-body').textContent).toBe('late-1');
    expect(screen.getByTestId('composer-default').hasAttribute('hidden')).toBe(true);

    act(() => {
      chain.clear();
    });
    expect(screen.queryByTestId('composer-takeover')).toBeNull();
    expect(screen.getByTestId('composer-default').hasAttribute('hidden')).toBe(false);
  });
});
