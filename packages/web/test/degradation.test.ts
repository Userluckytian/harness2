// web 壳**降级真实性**测试：serve 客户端不提供宿主通道（覆层落盘 / 配置写入 / 能力盘点 /
// @path 读取 / 附件上传 / 快照读取）时，共享控制层必须**如实降级**（内存生效 + 明确提示），
// 绝不伪造成功、绝不摆假入口。
//
// 与 ui-shared 的假壳端口测试互补：这里用的是**真实的 web 客户端**（createServeClient，对真
// HTTP/WS 夹具），证明 web 壳的成员缺失是结构性的（没有 metadataSet/settingsUpdateConfig/
// capabilities/UploadTransport/HostBridge.readFileForRef），降级路径在真机装配下同样成立。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { createConversationComposerPort } from '@harness2/ui-shared/renderer/conversation/seat.js';
import {
  attachmentReference,
  IMAGE_TRANSPORT_MISSING,
  type ComposerAttachment,
} from '@harness2/ui-shared/renderer/conversation/composer/attachments.js';
import { commitDraft, createComposerState } from '@harness2/ui-shared/renderer/conversation/composer/composer-state.js';
import { createServeClient, type WebSocketLike } from '../src/serve-client.js';
import { startServeFixture, waitFor, type ServeFixture } from './serve-fixture.js';

const TOKEN = 'tok-degrade';
const fixtures: ServeFixture[] = [];
const clients: Array<ReturnType<typeof createServeClient>> = [];

const globals = globalThis as { harness2?: unknown };

beforeEach(() => {
  // web 壳默认无宿主桥（ambient）；若环境残留桌面 preload 形状，会掩盖降级路径
  delete globals.harness2;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const f of fixtures.splice(0)) await f.close();
});

/** 装配：真 serve 夹具 + 真 web 客户端 + 共享应用壳（accepted ack 由夹具回，提交才能收敛） */
async function harness() {
  const fixture = await startServeFixture({
    onSubmit: (ws, op) => {
      ws.send(
        JSON.stringify({
          type: 'submit-ack',
          clientMessageId: String(op['clientMessageId']),
          sessionId: 's1',
          state: 'accepted',
          queueSeq: 1,
        }),
      );
    },
  });
  fixtures.push(fixture);
  const client = createServeClient({
    origin: fixture.origin,
    token: TOKEN,
    socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    reconnectDelayMs: 10,
  });
  clients.push(client);
  const shell = createAppShell(client);
  const stop = shell.controller.start();
  await waitFor(() => client.status() === 'connected');
  await shell.controller.refreshSessions(); // 会话摘要（含 cwd）是 @path 解析与新建会话的前提
  return { fixture, client, shell, stop };
}

describe('web 壳降级真实性：会话展示态覆层（无 metadataSet）', () => {
  it('重命名：内存覆层生效 + 明确「仅本次会话内生效」提示（不假装已保存）', async () => {
    const { client, shell, stop } = await harness();
    expect((client as { metadataSet?: unknown }).metadataSet).toBeUndefined(); // 结构性缺失
    await shell.controller.renameSession('s1', '新标题');
    expect(shell.store.displayTitleFor('s1')).toBe('新标题');
    expect(shell.store.getState().statusDetail?.error).toContain('未提供会话展示态持久化通道');
    expect(shell.store.getState().statusDetail?.error).toContain('仅');
    stop();
  });

  it('归档：内存覆层生效 + 明确仅内存提示（不伪造落盘）', async () => {
    const { shell, stop } = await harness();
    await shell.controller.archiveSession('s1', true);
    expect(shell.store.isArchived('s1')).toBe(true);
    expect(shell.store.getState().statusDetail?.error).toContain('未提供会话展示态持久化通道');
    stop();
  });

  it('删除：从当前视图移除 + 明确「仅从当前视图移除」（serve 无物理删除端点，不伪造删除）', async () => {
    const { shell, stop } = await harness();
    expect(shell.store.getState().sessions.map((s) => s.id)).toContain('s1');
    await shell.controller.deleteSession('s1');
    expect(shell.store.getState().sessions.map((s) => s.id)).not.toContain('s1');
    expect(shell.store.getState().statusDetail?.error).toContain('删除标记仅从当前视图移除');
    stop();
  });
});

describe('web 壳降级真实性：配置写入 / 能力盘点 / 可选通道', () => {
  it('审批模式切换：返回可行动原因（缺 settingsUpdateConfig），不静默失败', async () => {
    const { shell, stop } = await harness();
    const res = await shell.controller.setApprovalMode('s1', 'plan');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('settingsUpdateConfig');
    stop();
  });

  it('无 capabilities/setBusy/loadLayout/metadata*/drafts* 通道：启动不抛错且能力表不伪造', async () => {
    const { client, shell, stop } = await harness();
    expect((client as { capabilities?: unknown }).capabilities).toBeUndefined();
    expect((client as { setBusy?: unknown }).setBusy).toBeUndefined();
    expect((client as { loadLayout?: unknown }).loadLayout).toBeUndefined();
    expect((client as { draftsGet?: unknown }).draftsGet).toBeUndefined();
    await expect(shell.controller.initLayout()).resolves.toBeUndefined();
    await expect(shell.controller.initMetadata()).resolves.toBeUndefined();
    await expect(shell.controller.initDrafts()).resolves.toBeUndefined();
    expect(shell.store.capabilities()).toBeUndefined(); // 不伪造「全部可用」
    stop();
  });
});

describe('web 壳降级真实性：composer 附件与 @path（无上传 / 无读取通道）', () => {
  function submission(rawText: string, attachments: readonly ComposerAttachment[] = [], clientMessageId = 'cm-1') {
    const { submission: frozen } = commitDraft(createComposerState({ atoms: [{ kind: 'text', text: rawText }] }), {
      sessionId: 's1',
      intent: 'queue',
      placement: 'transcript',
      clientMessageId,
      attachments,
    });
    return frozen;
  }

  it('@path 无读取通道：token 原样保留 + 归因「读取通道不可用」（不是「未找到」），不伪造内容/引用', async () => {
    const { fixture, shell, stop } = await harness();
    const port = createConversationComposerPort({ store: shell.store, controller: shell.controller });
    await port.io.submit(submission('看 @src/a.ts 这里'));
    const submitOp = fixture.ops.find((op) => op['op'] === 'submit')!;
    const rawText = String(submitOp['rawText']);
    expect(rawText).toContain('@src/a.ts'); // 原始 token 还在
    // P2-3：web 结构性没有 HostBridge.readFileForRef ⇒ 不许说成「文件不存在」（不可行动）
    expect(rawText).toContain('[src/a.ts 读取通道不可用，已忽略]');
    expect(rawText).not.toContain('未找到');
    expect(rawText).not.toContain('FILE-BODY'); // 绝不伪造内容
    expect(submitOp['references']).toEqual([]); // 读取失败 → 不产 kind:'file' 引用
    const report = shell.store.peekRefReport('s1');
    expect(report?.unavailable).toEqual(['src/a.ts']);
    expect(report?.notFound).toEqual([]);
    expect(report?.sources).toEqual([]);
    stop();
  });

  it('图片附件：不产引用（协议无图片字节通道），文案如实说明未实现', () => {
    const image: ComposerAttachment = {
      id: 'i1',
      kind: 'image',
      name: 'i1.png',
      mimeType: 'image/png',
      bytes: 9,
      state: 'failed',
      error: IMAGE_TRANSPORT_MISSING,
    };
    expect(attachmentReference(image)).toBeUndefined();
    expect(IMAGE_TRANSPORT_MISSING).toContain('图片通道未实现');
  });

  it('缺省上传 transport：如实失败（不伪造 token），并发上限仍为 2', async () => {
    const { shell, stop } = await harness();
    const port = createConversationComposerPort({ store: shell.store, controller: shell.controller });
    const transport = port.io.transport;
    if (transport === undefined) throw new Error('共享缺省 transport 必须存在（否则 composer 无法如实失败）');
    await expect(transport.upload({ id: 'x', name: 'x', mimeType: '', bytes: 0, file: null })).rejects.toThrow(
      '未配置文件上传通道',
    );
    expect(port.io.maxConcurrentFileUploads).toBe(2);
    stop();
  });
});
