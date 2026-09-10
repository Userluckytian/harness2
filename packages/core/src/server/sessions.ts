// 服务内会话注册表（SessionHub）：HTTP 控制面与 WS 事件面共用的唯一内核操作层。
// 单一事实源约束：hub 只经内核原语操作会话——SessionManager（create/resume/locate/list）、
// SessionWriter（append 唯一写入口）、runTurn、undoLastTurn/redoLastUndo；hub 自身不写日志、
// 不组装模型上下文（runTurn 内部照旧从日志投影重建请求）。
//
// 两类观察输出（都不旁路事实源）：
//   - 落盘事件镜像：EventMirrorWriter 包裹真实 writer，append 返回后原样回调（WS event 帧）；
//   - 流式增量（delta）：runTurn 的 onStream 观察缝转发，是唯一允许的"未落盘"推送，
//     且必然与随后落盘的最终事件一致（text 拼接 = assistant/message.text；reasoning 同理）。
//
// 审批上抛：Ph2 审批缝 onAsk → 待处理请求表（requestId → settle），等待
// HTTP/WS 客户端的 approval-response；超时（默认 120s）与 turn 取消（abort）都按拒绝处理
// （与 chat REPL P2-2 的"等待可取消"口径一致）。
//
// turn 串行语义：同会话用户消息排队（同 REPL busy 队列），跨会话并行互不阻塞；
// undo/redo 与 turn 互斥（busy 会话上拒绝，避免 rewind marker 与 turn 事件交错落盘）。
import type { ResumeStateProvider } from '../interaction/resume-state.js';
import { SessionHubApproval } from './sessions-approval.js';

// 公开导出面保持不变：契约类型经此原样再导出。
export * from './sessions-types.js';

export class SessionHub extends SessionHubApproval implements ResumeStateProvider {
  // —— 收尾 ——

  /** 关闭：进入即清排队消息（排队 turn 不再在关闭后继续跑）→ 取消运行中 turn 与复盘
   *  → 拒绝全部待审批 → 等待收尾 → 关闭全部 writer（释放目录锁） */
  async close(): Promise<void> {
    this.pendingTexts.clear();
    for (const ac of this.running.values()) ac.abort();
    for (const ac of this.reviewRunning.values()) ac.abort();
    this.approvals.settleAll('cancelled');
    // S5：取消全部后台任务并等待其收敛到终态（abort 落定、task/transition 落账完毕）
    // —— 必须在关闭/清理 deliveries 之前，否则仍在收尾的任务 onFinish 会向已关闭的 journal append。
    await this.tasks.settleAll();
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
    for (const entry of this.entries.values()) entry.writer.close();
    this.entries.clear();
    // S3c2：关闭各会话 delivery journal（释放 pid 锁；与 session.log writer 顺次收口）
    for (const hd of this.deliveries.values()) hd.journal.close();
    this.deliveries.clear();
    this.steerSinks.clear();
    this.pendingTexts.clear();
  }
}
