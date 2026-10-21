import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@zcode/rpc';
import { ToolRegistry } from '@harness2/core';
import type { MockScript } from '@harness2/core';
import { createAgentService } from '../src/real/agent-service.js';

interface CapturedInteraction {
  interactionId?: string;
  kind?: string;
  anchorRowId?: number | null;
  payload?: {
    kind?: string;
    toolName?: string;
    toolCallId?: string;
    options?: Array<{ optionId?: string; kind?: string }>;
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
      expect(userLine).toContain('看这个');
      // 附件内容不得伪装成文本喂给模型（禁止 base64/文件名进 user/message）
      expect(userLine).not.toContain('a.png');
      expect(userLine).not.toContain('base64');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
