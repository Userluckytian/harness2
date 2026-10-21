import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@zcode/rpc';
import type { MockScript } from '@harness2/core';
import { createAgentService } from '../src/real/agent-service.js';

interface CapturedDelta {
  op: string;
  rowId?: number;
  path?: string;
  append?: string;
  row?: {
    rowId?: number;
    kind?: string;
    text?: string;
    state?: string;
    status?: string;
    toolName?: string;
    inputText?: string;
    output?: { text?: string };
    error?: { code?: string; message?: string };
  };
  patch?: { control?: { phase?: string } };
}

interface CapturedFrame {
  payload: { kind: string; deltas?: CapturedDelta[] };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for frames');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ZS3-T0 command ACK whitelist', () => {
  it('rejects commands outside the whitelist and never fakes accepted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ack-'));
    try {
      const agent = createAgentService({ home });
      const rejected = await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-reject', type: 'resolveInteraction' } as never,
      });
      expect(rejected).toMatchObject({
        commandId: 'cmd-reject',
        status: 'rejected',
        reasonCode: 'proto.commandUnsupported',
      });

      const stop = await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-stop', type: 'stop' } as never,
      });
      expect(stop).toMatchObject({ commandId: 'cmd-stop', status: 'accepted' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ZS3-T1 tool card lifecycle + reasoning frames', () => {
  it('streams reasoning, tool input, and keeps tool identity across upserts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-t1-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });

    const script: MockScript = [
      {
        reasoningChunks: ['think-1', 'think-2'],
        textChunks: ['part-1', 'part-2'],
        toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"x.txt"}' }],
      },
      { text: 'final' },
    ];

    try {
      const agent = createAgentService({ home, mockScript: script, emitter });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error('createSession did not return a sessionId');

      await agent.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-send', type: 'sendText', sessionId, payload: { text: 'hi' } } as never,
      });

      await waitFor(() =>
        frames.some(
          (f) =>
            f.payload.kind === 'deltas' &&
            (f.payload.deltas ?? []).some(
              (d) => d.op === 'state.updated' && d.patch?.control?.phase === 'completedSuccess',
            ),
        ),
      );

      const deltas = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));

      // reasoning：先空行 appended，再逐片 delta，最后整行 complete
      const reasoningAppended = deltas.find((d) => d.op === 'row.appended' && d.row?.kind === 'reasoning');
      expect(reasoningAppended?.row?.text).toBe('');
      const reasoningRowId = reasoningAppended?.row?.rowId;
      expect(reasoningRowId).toBeTypeOf('number');
      const reasoningDeltas = deltas
        .filter((d) => d.op === 'row.delta' && d.rowId === reasoningRowId)
        .map((d) => d.append);
      expect(reasoningDeltas).toEqual(['think-1', 'think-2']);
      const reasoningFinal = deltas.find((d) => d.op === 'row.upserted' && d.row?.kind === 'reasoning');
      expect(reasoningFinal?.row).toMatchObject({ text: 'think-1think-2', state: 'complete' });

      // toolCall：inputStreaming 空行 → inputText delta → running 整行 → 终态整行仍保留 toolName/inputText
      const toolAppended = deltas.find((d) => d.op === 'row.appended' && d.row?.kind === 'toolCall');
      expect(toolAppended?.row).toMatchObject({
        status: 'inputStreaming',
        inputText: '',
        toolName: 'write',
      });
      const toolRowId = toolAppended?.row?.rowId;
      const toolDelta = deltas.find((d) => d.op === 'row.delta' && d.rowId === toolRowId);
      expect(toolDelta).toMatchObject({ path: 'inputText', append: '{"path":"x.txt"}' });

      const toolUpserts = deltas.filter((d) => d.op === 'row.upserted' && d.row?.kind === 'toolCall');
      const running = toolUpserts.find((d) => d.row?.status === 'running');
      expect(running?.row).toMatchObject({ toolName: 'write', inputText: '{"path":"x.txt"}' });
      const terminal = toolUpserts.find((d) => d.row?.status === 'success' || d.row?.status === 'error');
      expect(terminal?.row).toMatchObject({ toolName: 'write', inputText: '{"path":"x.txt"}' });
      if (terminal?.row?.status === 'error') {
        expect(terminal.row.error?.message).toBeTruthy();
      } else {
        expect(terminal?.row?.output?.text).toBeTruthy();
      }

      // assistantText：两段流式文本 + 工具后续轮文本都进同一行
      const assistantFinal = deltas.find((d) => d.op === 'row.upserted' && d.row?.kind === 'assistantText');
      expect(assistantFinal?.row?.state).toBe('complete');
      expect(assistantFinal?.row?.text).toContain('part-1');
      expect(assistantFinal?.row?.text).toContain('final');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
