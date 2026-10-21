import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@zcode/rpc';
import { ToolRegistry } from '@harness2/core';
import type { MockScript } from '@harness2/core';
import { createAgentService } from '../src/real/agent-service.js';
import { createProjectService } from '../src/real/project-service.js';

interface CapturedInteraction {
  interactionId?: string;
  kind?: string;
  anchorRowId?: number | null;
  payload?: {
    kind?: string;
    prompt?: string;
    freeText?: boolean;
    toolName?: string;
    toolCallId?: string;
    options?: Array<{ optionId?: string; kind?: string }>;
    questions?: Array<{
      question?: string;
      header?: string;
      options?: Array<{ value?: string; label?: string }>;
    }>;
  };
}

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
    approvalInteractionId?: string;
    attachments?: unknown[];
    output?: { text?: string };
    error?: { code?: string; message?: string };
  };
  patch?: { control?: { phase?: string }; pendingInteractions?: CapturedInteraction[] };
}

interface CapturedFrame {
  subscriptionId?: string;
  fromSeq?: number;
  toSeq?: number;
  deliveryKind?: string;
  payload: {
    kind: string;
    deltas?: CapturedDelta[];
    snapshot?: {
      seq?: number;
      logEpoch?: string;
      control?: { phase?: string; canStop?: boolean };
      rows?: {
        window?: Array<{ kind?: string; text?: string }>;
        totalCount?: number;
        firstRowId?: number | null;
      };
    };
  };
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
        envelope: { commandId: 'cmd-reject', type: 'setModel' } as never,
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
      // 本用例只验证工具卡帧序列：注入空注册表，让 write 成为“未知工具”以保留原断言。
      const agent = createAgentService({ home, mockScript: script, emitter, tools: new ToolRegistry() });
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

describe('ZS3-T2 permission approval round trip', () => {
  it('projects pending interaction, resolves deny, clears pending, and audits JSONL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-t2-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });

    const registry = new ToolRegistry();
    registry.register({
      name: 'write',
      description: 'test write tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: (args, ctx) => {
        const a = args as { path: string; content?: string };
        writeFileSync(join(ctx.cwd, a.path), a.content ?? '');
        return { output: 'ok' };
      },
    });

    const script: MockScript = [
      {
        text: 'need approval',
        toolCalls: [{ id: 'call-approve', name: 'write', arguments: '{"path":"approval.txt","content":"x"}' }],
      },
      { text: 'done' },
    ];

    try {
      const agent = createAgentService({
        home,
        mockScript: script,
        tools: registry,
        emitter,
        approvalTimeoutMs: 10_000,
      });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
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
              (d) => d.op === 'state.updated' && (d.patch?.pendingInteractions?.length ?? 0) > 0,
            ),
        ),
      );

      const deltas = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));
      const interaction = deltas
        .flatMap((d) => d.patch?.pendingInteractions ?? [])
        .find((x) => x.kind === 'permission');
      expect(interaction?.interactionId).toBeTruthy();
      expect(interaction?.payload).toMatchObject({ kind: 'permission', toolName: 'write' });
      expect(interaction?.payload?.options?.map((o) => o.optionId)).toEqual(['allowOnce', 'allowAlways', 'deny']);
      expect(interaction?.anchorRowId).toBeTypeOf('number');

      const pendingRow = deltas.find(
        (d) => d.op === 'row.upserted' && d.row?.kind === 'toolCall' && d.row?.status === 'pendingApproval',
      );
      expect(pendingRow?.row?.approvalInteractionId).toBe(interaction?.interactionId);

      const interactionId = interaction?.interactionId;
      if (!interactionId) throw new Error('missing interactionId');
      const resolveEnvelope = {
        commandId: 'cmd-resolve',
        clientId: 'test-client',
        type: 'resolveInteraction',
        payload: { interactionId, answer: { optionId: 'deny', freeText: '不要写' } },
      };
      const ack = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: resolveEnvelope as never,
      })) as {
        status?: string;
        result?: { type?: string; resolvedBy?: { clientId?: string; optionId?: string } };
      };
      expect(ack.status).toBe('accepted');
      expect(ack.result).toMatchObject({
        type: 'resolveInteraction',
        resolvedBy: { clientId: 'test-client', optionId: 'deny' },
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

      const after = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));
      expect(after.some((d) => d.op === 'state.updated' && d.patch?.pendingInteractions?.length === 0)).toBe(true);
      const terminal = after.find(
        (d) =>
          d.op === 'row.upserted' &&
          d.row?.kind === 'toolCall' &&
          (d.row?.status === 'error' || d.row?.status === 'success'),
      );
      expect(terminal?.row?.status).toBe('error');
      expect(terminal?.row?.error?.message).toBe('不要写');

      // 先到先得：重复 resolve 幂等 noop
      const duplicate = await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { ...resolveEnvelope, commandId: 'cmd-resolve-2' } as never,
      });
      expect(duplicate).toMatchObject({ status: 'noop', reasonCode: 'proto.alreadyResolved' });

      // 审批审计事件落 JSONL（extension event，不改内建事件白名单）
      const root = join(home, '.harness2', 'sessions');
      let jsonlPath: string | undefined;
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.v1.jsonl') jsonlPath = p;
        }
      };
      walk(root);
      expect(jsonlPath).toBeTruthy();
      const log = readFileSync(jsonlPath!, 'utf8');
      expect(log).toContain('adapter/permission-request');
      expect(log).toContain('adapter/permission-resolved');
      expect(log).toContain('"allowed":false');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe('ZS3-T3 local attachments', () => {
  it('echoes attachments on userInput row and records an additive audit event', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-t3-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });

    const attachments = [{ ref: 'D:/tmp/a.png', fileName: 'a.png', mime: 'image/png', bytes: 123 }];

    try {
      const agent = createAgentService({ home, mockScript: [{ text: 'ok' }], emitter });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      if (!sessionId) throw new Error('createSession did not return a sessionId');

      await agent.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: {
          commandId: 'cmd-att',
          type: 'sendText',
          sessionId,
          payload: { text: '看这个', attachments },
        } as never,
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
      const userRow = deltas.find((d) => d.op === 'row.appended' && d.row?.kind === 'userInput');
      expect(userRow?.row?.text).toBe('看这个');
      expect(userRow?.row?.attachments).toEqual(attachments);

      const root = join(home, '.harness2', 'sessions');
      let jsonlPath: string | undefined;
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.v1.jsonl') jsonlPath = p;
        }
      };
      walk(root);
      expect(jsonlPath).toBeTruthy();
      const log = readFileSync(jsonlPath!, 'utf8');
      expect(log).toContain('adapter/user-attachments');
      const userLine = log.split('\n').find((line) => line.includes('"type":"user/message"')) ?? '';
      const userEvent = JSON.parse(userLine) as {
        payload: { text: string; attachments?: unknown[] };
      };
      expect(userEvent.payload.text).toBe('看这个');
      // 附件以 ref 落盘（ZS3.5）；正文仍只有用户文字，不把内容/文件名塞进 text。
      expect(userEvent.payload.attachments).toEqual(attachments);
      expect(userEvent.payload.text).not.toContain('a.png');
      expect(userEvent.payload.text).not.toContain('base64');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe('ZS3-T4 resume + rowsRange + logEpoch', () => {
  it('replays (base.seq, current] as deltas without snapshot and pages older rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-t4-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; deliveryKind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) {
        frames.push({ ...w.frame, deliveryKind: w.deliveryKind });
      }
    });

    try {
      const agent = createAgentService({
        home,
        mockScript: [{ text: 'first' }, { text: 'second' }],
        emitter,
      });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      if (!sessionId) throw new Error('createSession did not return a sessionId');

      const sub1 = (await agent.subscribeConversationV4({
        workspacePath: home,
        sessionId,
      })) as { ack: { subscriptionId: string; mode: string; logEpoch: string } };
      expect(sub1.ack.mode).toBe('snapshot');
      const epoch = sub1.ack.logEpoch;

      const deltasOf = (subId: string) =>
        frames.filter((f) => f.subscriptionId === subId && f.payload.kind === 'deltas');
      const completedOf = (subId: string) =>
        deltasOf(subId).some((f) =>
          (f.payload.deltas ?? []).some(
            (d) => d.op === 'state.updated' && d.patch?.control?.phase === 'completedSuccess',
          ),
        );

      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-one', type: 'sendText', sessionId, payload: { text: 'one' } } as never,
      });
      await waitFor(() => completedOf(sub1.ack.subscriptionId));
      const seq1 = deltasOf(sub1.ack.subscriptionId).at(-1)?.toSeq ?? 0;
      expect(seq1).toBeGreaterThan(0);
      await agent.unsubscribeConversationV4({
        workspacePath: home,
        subscriptionId: sub1.ack.subscriptionId,
      });

      // 第二轮期间重新订阅：base 恰为第一轮结束水位，必须走 resume 而非 snapshot。
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-two', type: 'sendText', sessionId, payload: { text: 'two' } } as never,
      });
      const sub2 = (await agent.subscribeConversationV4({
        workspacePath: home,
        sessionId,
        base: { logEpoch: epoch, seq: seq1 },
      })) as { ack: { subscriptionId: string; mode: string; logEpoch: string } };
      expect(sub2.ack.mode).toBe('resume');
      expect(sub2.ack.logEpoch).toBe(epoch);
      await waitFor(() => completedOf(sub2.ack.subscriptionId));
      expect(frames.some((f) => f.subscriptionId === sub2.ack.subscriptionId && f.payload.kind === 'snapshot')).toBe(
        false,
      );
      const sub2UserTexts = deltasOf(sub2.ack.subscriptionId)
        .flatMap((f) => f.payload.deltas ?? [])
        .filter((d) => d.op === 'row.appended' && d.row?.kind === 'userInput')
        .map((d) => d.row?.text);
      expect(sub2UserTexts).toContain('two');
      expect(sub2UserTexts).not.toContain('one');

      // 第二轮结束后再续传：initial 帧必须回放 (seq1, current] 的 delta。
      await agent.unsubscribeConversationV4({
        workspacePath: home,
        subscriptionId: sub2.ack.subscriptionId,
      });
      const sub3 = (await agent.subscribeConversationV4({
        workspacePath: home,
        sessionId,
        base: { logEpoch: epoch, seq: seq1 },
      })) as { ack: { subscriptionId: string; mode: string; logEpoch: string } };
      expect(sub3.ack.mode).toBe('resume');
      await waitFor(() => frames.some((f) => f.subscriptionId === sub3.ack.subscriptionId));
      const initial = frames.find((f) => f.subscriptionId === sub3.ack.subscriptionId);
      expect(initial?.deliveryKind).toBe('initial');
      expect(initial?.payload.kind).toBe('deltas');
      expect(initial?.fromSeq).toBe(seq1);
      expect(initial?.toSeq).toBeGreaterThan(seq1);
      const replayedUserTexts = (initial?.payload.deltas ?? [])
        .filter((d) => d.op === 'row.appended' && d.row?.kind === 'userInput')
        .map((d) => d.row?.text);
      expect(replayedUserTexts).toContain('two');
      expect(replayedUserTexts).not.toContain('one');
      expect(frames.some((f) => f.subscriptionId === sub3.ack.subscriptionId && f.payload.kind === 'snapshot')).toBe(
        false,
      );

      // epoch 不符 → 合法降级为 snapshot。
      const sub4 = (await agent.subscribeConversationV4({
        workspacePath: home,
        sessionId,
        base: { logEpoch: 'other-epoch', seq: 0 },
      })) as { ack: { subscriptionId: string; mode: string; logEpoch: string } };
      expect(sub4.ack.mode).toBe('snapshot');
      await waitFor(() =>
        frames.some((f) => f.subscriptionId === sub4.ack.subscriptionId && f.payload.kind === 'snapshot'),
      );

      // rowsRange：游标之前的分页（升序 + hasMore）。
      const page1 = (await agent.conversationRowsRangeV4({
        workspacePath: home,
        sessionId,
        limit: 2,
      })) as { rows: Array<{ rowId: number }>; hasMore: boolean; atLogEpoch: string };
      expect(page1.rows).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.atLogEpoch).toBe(epoch);
      const page2 = (await agent.conversationRowsRangeV4({
        workspacePath: home,
        sessionId,
        beforeRowId: page1.rows[0].rowId,
        limit: 2,
      })) as { rows: Array<{ rowId: number }>; hasMore: boolean; atLogEpoch: string };
      expect(page2.rows).toHaveLength(2);
      expect(page2.rows[0].rowId).toBeLessThan(page1.rows[0].rowId);
      expect(page2.atLogEpoch).toBe(epoch);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

describe('ZS3-T5 attachment RPC wiring', () => {
  it('delegates begin/chunk/commit/read to the attachment store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-att-rpc-'));
    try {
      const agent = createAgentService({ home, mockScript: [{ text: 'ok' }] });
      const bytes = Buffer.from('hi');
      const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const begin = (await agent.attachmentBeginV4({
        workspacePath: home,
        sessionId: 's1',
        uploadId: 'rpc-1',
        fileName: 'a.txt',
        mime: 'text/plain',
        totalBytes: bytes.byteLength,
        totalChunks: 1,
        checksum,
      })) as { state: string };
      expect(begin.state).toBe('staging');

      const chunk = (await agent.attachmentChunkV4({
        workspacePath: home,
        sessionId: 's1',
        uploadId: 'rpc-1',
        chunkIndex: 0,
        dataBase64: bytes.toString('base64'),
      })) as { nextChunkIndex: number };
      expect(chunk.nextChunkIndex).toBe(1);

      const commit = (await agent.attachmentCommitV4({
        workspacePath: home,
        sessionId: 's1',
        uploadId: 'rpc-1',
      })) as { ref: string };
      expect(commit.ref).toContain('rpc-1');

      const read = (await agent.attachmentReadV4({
        workspacePath: home,
        sessionId: 's1',
        ref: commit.ref,
        offset: 0,
        limit: 10,
      })) as { dataBase64: string; mediaType: string; nextOffset: number | null };
      expect(Buffer.from(read.dataBase64, 'base64').toString()).toBe('hi');
      expect(read.mediaType).toBe('text/plain');
      expect(read.nextOffset).toBeNull();

      // 未出现在会话投影里的 ref 不允许读（协议要求 CLI 再授权）
      await expect(
        agent.attachmentReadV4({
          workspacePath: home,
          sessionId: 's1',
          ref: 'D:/not-authorized.txt',
          offset: 0,
          limit: 10,
        }),
      ).rejects.toThrow(/fault\.attachment\.notAuthorized/);

      await agent.attachmentAbortV4({ workspacePath: home, sessionId: 's1', uploadId: 'rpc-1' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ZS3.5 ask_user producer', () => {
  it('projects a userInput dialog and feeds the chosen answer back to the model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ask-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });
    const script: MockScript = [
      {
        text: 'asking',
        toolCalls: [
          {
            id: 'ask-1',
            name: 'askuserquestion',
            arguments: JSON.stringify({
              questions: [
                {
                  question: '今晚吃什么？',
                  header: '晚饭',
                  options: [
                    { value: 'noodle', label: '面' },
                    { value: 'rice', label: '饭' },
                  ],
                },
              ],
            }),
          },
        ],
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
      if (!sessionId) throw new Error('createSession did not return a sessionId');

      await agent.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-ask', type: 'sendText', sessionId, payload: { text: '给我选项' } } as never,
      });

      await waitFor(() =>
        frames.some(
          (f) =>
            f.payload.kind === 'deltas' &&
            (f.payload.deltas ?? []).some(
              (d) =>
                d.op === 'state.updated' && (d.patch?.pendingInteractions ?? []).some((i) => i.kind === 'userInput'),
            ),
        ),
      );

      const deltas = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));
      const interaction = deltas.flatMap((d) => d.patch?.pendingInteractions ?? []).find((i) => i.kind === 'userInput');
      expect(interaction?.payload?.prompt).toBe('今晚吃什么？');
      expect(interaction?.payload?.options?.map((o) => o.optionId)).toEqual(['noodle', 'rice']);
      expect(interaction?.payload?.questions?.[0]).toMatchObject({
        question: '今晚吃什么？',
        header: '晚饭',
      });
      expect(interaction?.payload?.questions?.[0]?.options?.map((o) => o.value)).toEqual(['noodle', 'rice']);
      const interactionId = interaction?.interactionId;
      if (!interactionId) throw new Error('missing interactionId');

      const ack = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: {
          commandId: 'cmd-answer',
          clientId: 'test-client',
          type: 'resolveInteraction',
          payload: {
            interactionId,
            answer: { action: 'accept', content: { 晚饭: ['rice'] } },
          },
        } as never,
      })) as { status?: string; result?: { type?: string; resolvedBy?: { clientId?: string; optionId?: string } } };
      expect(ack.status).toBe('accepted');
      expect(ack.result).toMatchObject({
        type: 'resolveInteraction',
        resolvedBy: { clientId: 'test-client' },
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

      const after = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));
      const terminal = after.find(
        (d) =>
          d.op === 'row.upserted' &&
          d.row?.kind === 'toolCall' &&
          (d.row?.status === 'success' || d.row?.status === 'error'),
      );
      expect(terminal?.row?.status).toBe('success');
      const assistantFinal = after.find((d) => d.op === 'row.upserted' && d.row?.kind === 'assistantText');
      expect(assistantFinal?.row?.text).toContain('final');

      // 模型可见的答案由 tool/result 事件承载（onStream 的 tool-result 不带 output）。
      const root = join(home, '.harness2', 'sessions');
      let jsonlPath: string | undefined;
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.v1.jsonl') jsonlPath = p;
        }
      };
      walk(root);
      expect(jsonlPath).toBeTruthy();
      const toolResultLine =
        readFileSync(jsonlPath!, 'utf8')
          .split('\n')
          .find((line) => line.includes('"type":"tool/result"')) ?? '';
      expect(toolResultLine).toContain('rice');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe('ZS3.5 restart restore + project prepareSession', () => {
  it('restores history and idle phase on a new service instance', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-restore-'));
    const emitter1 = new Emitter<unknown>();
    const frames1: CapturedFrame[] = [];
    emitter1.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames1.push(w.frame);
    });
    try {
      const agent1 = createAgentService({ home, mockScript: [{ text: 'hello' }], emitter: emitter1 });
      const created = (await agent1.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      if (!sessionId) throw new Error('createSession did not return a sessionId');
      await agent1.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent1.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-send', type: 'sendText', sessionId, payload: { text: 'hi' } } as never,
      });
      await waitFor(() =>
        frames1.some(
          (f) =>
            f.payload.kind === 'deltas' &&
            (f.payload.deltas ?? []).some(
              (d) => d.op === 'state.updated' && d.patch?.control?.phase === 'completedSuccess',
            ),
        ),
      );

      // 模拟 host 重启：新实例没有任何内存投影。
      const emitter2 = new Emitter<unknown>();
      const frames2: CapturedFrame[] = [];
      emitter2.event((wire) => {
        const w = wire as { kind?: string; frame?: CapturedFrame };
        if (w.kind === 'complete' && w.frame) frames2.push(w.frame);
      });
      const agent2 = createAgentService({ home, mockScript: [{ text: 'next' }], emitter: emitter2 });
      const sub = (await agent2.subscribeConversationV4({
        workspacePath: home,
        sessionId,
      })) as { ack: { subscriptionId: string; mode: string } };
      expect(sub.ack.mode).toBe('snapshot');
      await waitFor(() =>
        frames2.some((f) => f.subscriptionId === sub.ack.subscriptionId && f.payload.kind === 'snapshot'),
      );
      const snapshot = frames2.find((f) => f.subscriptionId === sub.ack.subscriptionId && f.payload.kind === 'snapshot')
        ?.payload.snapshot;
      expect(snapshot?.control?.phase).toBe('completedSuccess');
      expect(snapshot?.control?.canStop).toBe(false);
      expect(snapshot?.rows?.window?.length).toBeGreaterThan(0);
      expect(snapshot?.rows?.window?.filter((r) => r.kind === 'userInput').map((r) => r.text)).toContain('hi');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('prepareSession creates the conversation workspace directory', async () => {
    const data = mkdtempSync(join(tmpdir(), 'h2-proj-'));
    const previous = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = data;
    try {
      const service = createProjectService();
      const result = (await service.prepareSession({})) as { workspacePath: string };
      expect(result.workspacePath).toBe(join(data, '.zcode', 'workspace', 'default'));
      expect(existsSync(result.workspacePath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
      else process.env.ZCODE_DATA_BASE_DIR = previous;
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('ZS3.5 attachment model consumption + environment', () => {
  it('sends image/text parts and cwd to the provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-mm-'));
    const imagePath = join(home, 'a.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const notePath = join(home, 'note.md');
    writeFileSync(notePath, '# hello\ncontent-123');
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });
    interface CapturedRequest {
      messages: Array<{
        role: string;
        content: string;
        parts?: Array<{
          type: string;
          mimeType?: string;
          dataBase64?: string;
          text?: string;
        }>;
      }>;
      system?: string;
    }
    let requests: CapturedRequest[] | undefined;
    try {
      const agent = createAgentService({
        home,
        mockScript: [{ text: 'ok' }],
        emitter,
        providerSink: (provider) => {
          requests = (provider as { requests: CapturedRequest[] }).requests;
        },
      });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      if (!sessionId) throw new Error('createSession did not return a sessionId');

      await agent.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: {
          commandId: 'cmd-mm',
          type: 'sendText',
          sessionId,
          payload: {
            text: '看附件',
            attachments: [
              { ref: imagePath, fileName: 'a.png', mime: 'image/png', bytes: 4 },
              { ref: notePath, fileName: 'note.md', mime: 'text/markdown', bytes: 19 },
            ],
          },
        } as never,
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

      const request = requests?.[0];
      expect(request).toBeTruthy();
      const user = request?.messages.find((m) => m.role === 'user');
      expect(user?.parts?.some((p) => p.type === 'image' && p.mimeType === 'image/png')).toBe(true);
      expect(user?.parts?.some((p) => p.type === 'text' && (p.text ?? '').includes('content-123'))).toBe(true);
      expect(request?.system).toContain('[环境]');
      expect(request?.system).toContain('当前工作目录');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe('ZS3.5 provider failure surface', () => {
  it('shows the provider error instead of the placeholder done', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-fail-'));
    const frames: CapturedFrame[] = [];
    const emitter = new Emitter<unknown>();
    emitter.event((wire) => {
      const w = wire as { kind?: string; frame?: CapturedFrame };
      if (w.kind === 'complete' && w.frame) frames.push(w.frame);
    });
    try {
      const agent = createAgentService({ home, mockScript: [{ error: 400 }], emitter });
      const created = (await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-create', type: 'createSession' } as never,
      })) as { result?: { sessionId?: string } };
      const sessionId = created.result?.sessionId;
      if (!sessionId) throw new Error('createSession did not return a sessionId');
      await agent.subscribeConversationV4({ workspacePath: home, sessionId });
      await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-fail', type: 'sendText', sessionId, payload: { text: 'hi' } } as never,
      });

      await waitFor(() =>
        frames.some(
          (f) =>
            f.payload.kind === 'deltas' &&
            (f.payload.deltas ?? []).some((d) => d.op === 'state.updated' && d.patch?.control?.phase === 'error'),
        ),
      );
      const deltas = frames.flatMap((f) => (f.payload.kind === 'deltas' ? (f.payload.deltas ?? []) : []));
      const assistant = deltas.find((d) => d.op === 'row.upserted' && d.row?.kind === 'assistantText');
      expect(assistant?.row?.state).toBe('failed');
      expect(assistant?.row?.text).toContain('模型请求失败');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
