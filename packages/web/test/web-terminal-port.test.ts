// Z9-5：web 壳 `TerminalPort` 实现单测（WS 八帧往返）。
//
// 覆盖：
//   ① available 反映实时连接状态（getter）：connected → true，离线 → false（红线⑩）；
//   ② open 发 `terminal/open`（requestId/cols/rows/cwd）→ 收 `terminal/opened` 结算；`terminal/error`
//      带同 requestId → 如实 reject；
//   ③ write/resize/close 发对应 op（close 无 ack → 立即 resolve）；未连接（send 抛）→ open reject、
//      其余不抛崩调用方；
//   ④ onData/onExit 按帧类型分流，退订后不再收到。
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '@harness2/ui-shared/shared/protocol.js';
import {
  createWebTerminalPort,
  UNAVAILABLE_WEB_TERMINAL_PORT,
  type WebTerminalChannel,
} from '../src/terminal/web-port.js';
import type { TerminalClientOp, TerminalServerFrame } from '../src/serve-client.js';

interface FakeChannel {
  channel: WebTerminalChannel;
  sent: TerminalClientOp[];
  emit(frame: TerminalServerFrame): void;
  setStatus(status: ConnectionStatus): void;
  /** 让 sendTerminalOp 抛错（模拟 WS 未连接） */
  break(): void;
}

function createFakeChannel(initial: ConnectionStatus = 'connected'): FakeChannel {
  const listeners = new Set<(frame: TerminalServerFrame) => void>();
  const sent: TerminalClientOp[] = [];
  let status: ConnectionStatus = initial;
  let broken = false;
  return {
    sent,
    channel: {
      status: () => status,
      sendTerminalOp: (op) => {
        if (broken) throw new Error('WS 未连接');
        sent.push(op);
      },
      onTerminalFrame: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit: (frame) => {
      for (const cb of [...listeners]) cb(frame);
    },
    setStatus: (next) => {
      status = next;
    },
    break: () => {
      broken = true;
    },
  };
}

describe('web TerminalPort：available 两态（实时）', () => {
  it('连接中 → true；掉线 → false（getter 反映实时状态）', () => {
    const fake = createFakeChannel('connected');
    const port = createWebTerminalPort(fake.channel);
    expect(port.available).toBe(true);
    fake.setStatus('offline');
    expect(port.available).toBe(false);
    fake.setStatus('reconnecting');
    expect(port.available).toBe(false);
  });

  it('无通道空实现恒为 available=false（不摆假终端）', () => {
    expect(UNAVAILABLE_WEB_TERMINAL_PORT.available).toBe(false);
  });
});

describe('web TerminalPort：open 往返', () => {
  it('发 terminal/open（带 requestId/cols/rows/cwd）→ 收 terminal/opened 结算 id', async () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    const pending = port.open({ cols: 80, rows: 24, cwd: '/work' });
    expect(fake.sent).toHaveLength(1);
    const frame = fake.sent[0] as Extract<TerminalClientOp, { op: 'terminal/open' }>;
    expect(frame.op).toBe('terminal/open');
    expect(frame.cols).toBe(80);
    expect(frame.rows).toBe(24);
    expect(frame.cwd).toBe('/work');
    fake.emit({ type: 'terminal/opened', requestId: frame.requestId, id: 't-9' });
    await expect(pending).resolves.toEqual({ id: 't-9' });
  });

  it('cwd 缺省时不写 cwd 字段', () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    void port.open({ cols: 80, rows: 24 });
    const frame = fake.sent[0] as Extract<TerminalClientOp, { op: 'terminal/open' }>;
    expect('cwd' in frame).toBe(false);
  });

  it('terminal/error 带同 requestId → open 如实 reject（不假装已连接）', async () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    const pending = port.open({ cols: 80, rows: 24 });
    const frame = fake.sent[0] as Extract<TerminalClientOp, { op: 'terminal/open' }>;
    fake.emit({ type: 'terminal/error', requestId: frame.requestId, error: 'PTY 不可用' });
    await expect(pending).rejects.toThrow('PTY 不可用');
  });

  it('WS 未连接（send 抛）→ open 立即 reject（不留悬挂）', async () => {
    const fake = createFakeChannel();
    fake.break();
    const port = createWebTerminalPort(fake.channel);
    await expect(port.open({ cols: 80, rows: 24 })).rejects.toThrow(/WS 未连接/);
    expect(fake.sent).toHaveLength(0);
  });
});

describe('web TerminalPort：write / resize / close', () => {
  it('分别发送 terminal/input、terminal/resize、terminal/close', async () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    port.write('t-1', 'ls\r');
    port.resize('t-1', 120, 40);
    await port.close('t-1');
    expect(fake.sent).toEqual([
      { op: 'terminal/input', id: 't-1', data: 'ls\r' },
      { op: 'terminal/resize', id: 't-1', cols: 120, rows: 40 },
      { op: 'terminal/close', id: 't-1' },
    ]);
  });

  it('未连接时 write/resize 不抛、close 仍 resolve（如实 no-op）', async () => {
    const fake = createFakeChannel();
    fake.break();
    const port = createWebTerminalPort(fake.channel);
    expect(() => port.write('t-1', 'x')).not.toThrow();
    expect(() => port.resize('t-1', 80, 24)).not.toThrow();
    await expect(port.close('t-1')).resolves.toBeUndefined();
  });
});

describe('web TerminalPort：data / exit 分发', () => {
  it('terminal/data 与 terminal/exit 按 id 分流；退订后不再收到', () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    const data: Array<[string, string]> = [];
    const exits: Array<[string, number | undefined]> = [];
    const offData = port.onData((id, d) => data.push([id, d]));
    const offExit = port.onExit((id, code) => exits.push([id, code]));

    fake.emit({ type: 'terminal/data', id: 't-1', data: 'hello' });
    fake.emit({ type: 'terminal/exit', id: 't-1', exitCode: 0 });
    fake.emit({ type: 'terminal/exit', id: 't-2', exitCode: undefined });
    expect(data).toEqual([['t-1', 'hello']]);
    expect(exits).toEqual([
      ['t-1', 0],
      ['t-2', undefined],
    ]);

    offData();
    offExit();
    fake.emit({ type: 'terminal/data', id: 't-1', data: 'after-off' });
    fake.emit({ type: 'terminal/exit', id: 't-1', exitCode: 1 });
    expect(data).toEqual([['t-1', 'hello']]);
    expect(exits).toHaveLength(2);
  });

  it('带 id 的 terminal/error 不经 data/exit 泄漏（如实忽略，不画成正常输出）', () => {
    const fake = createFakeChannel();
    const port = createWebTerminalPort(fake.channel);
    const data = vi.fn();
    const exits = vi.fn();
    port.onData(data);
    port.onExit(exits);
    fake.emit({ type: 'terminal/error', id: 't-1', error: '未知 id' });
    expect(data).not.toHaveBeenCalled();
    expect(exits).not.toHaveBeenCalled();
  });
});
