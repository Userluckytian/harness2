// H-44 / H-66～H-68 flow 测试（阶段 7 P7-D）：
//   状态机与 ack 语义（applied/duplicate/expired/unknown/invalid）、审批决策键与授权缓存、
//   澄清应答解析与超时语义、sudo/secret 特权全链（一次性授权、过期、重复消费、机密不回显）、
//   审计留痕（追加写 + 机密零泄漏）、三壳呈现契约形状。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalGrantStore,
  applyApprovalDecision,
  approvalDecisionToScope,
  canFlowTransition,
  clarifyDeadline,
  computeClarifyWait,
  containsForbiddenAuditKeys,
  decisionScopeMode,
  defaultFlowTitle,
  FLOW_TERMINAL_STATES,
  flowRequestCarriesSecret,
  flowResponseMatchesKind,
  FlowAuditLog,
  FlowManager,
  isFlowTerminalState,
  MemoryFlowAuditSink,
  parseApprovalChoice,
  parseClarifyReply,
  parseFlowAuditEntry,
  parseOpenClarifyReply,
  stripRecommended,
  summarizeClarifyAnswers,
  type FlowPresentation,
} from '../src/flows/index.js';
import { PrivilegeBroker, secretRequestSpec, sudoRequestSpec } from '../src/approval/privileged.js';
import { createApprovalPolicy } from '../src/approval/policy.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-flows-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 可控时钟 */
function clock(start = new Date('2026-09-14T10:00:00.000Z')): { now: () => Date; advance: (ms: number) => void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let idSeq = 0;
function ids(): () => string {
  return () => `flow-${++idSeq}`;
}

// —— 状态机纯函数 ——

describe('flow 状态机（H-66～H-68 共用契约）', () => {
  it('合法/非法迁移', () => {
    expect(canFlowTransition('pending', 'presented')).toBe(true);
    expect(canFlowTransition('pending', 'answered')).toBe(true); // 无头/自动应答
    expect(canFlowTransition('presented', 'answered')).toBe(true);
    expect(canFlowTransition('presented', 'cancelled')).toBe(true);
    expect(canFlowTransition('answered', 'denied')).toBe(false); // 终态无出边
    expect(canFlowTransition('expired', 'answered')).toBe(false);
    expect(canFlowTransition('presented', 'presented')).toBe(false); // 自转移
    expect(canFlowTransition('bogus' as never, 'answered')).toBe(false);
  });

  it('终态集合', () => {
    expect([...FLOW_TERMINAL_STATES].sort()).toEqual(['answered', 'cancelled', 'denied', 'expired']);
    expect(isFlowTerminalState('answered')).toBe(true);
    expect(isFlowTerminalState('presented')).toBe(false);
  });

  it('应答种类必须与请求种类一致；特权请求标记', () => {
    expect(flowResponseMatchesKind('approval', { kind: 'approval', decision: 'deny' })).toBe(true);
    expect(flowResponseMatchesKind('approval', { kind: 'clarify', answers: {} })).toBe(false);
    expect(flowRequestCarriesSecret({ kind: 'sudo' })).toBe(true);
    expect(flowRequestCarriesSecret({ kind: 'secret' })).toBe(true);
    expect(flowRequestCarriesSecret({ kind: 'approval' })).toBe(false);
  });

  it('默认标题四类齐全', () => {
    expect(defaultFlowTitle('approval')).toBe('需要审批');
    expect(defaultFlowTitle('clarify')).toBe('需要澄清');
    expect(defaultFlowTitle('sudo')).toBe('需要提权');
    expect(defaultFlowTitle('secret')).toBe('需要输入机密');
  });
});

// —— H-66 审批决策与授权 ——

describe('H-66 审批 flow：决策键 o/s/a/d 与授权缓存', () => {
  it('决策键解析（中英/数字；禁用项返回 null）', () => {
    expect(parseApprovalChoice('o')).toBe('allow_once');
    expect(parseApprovalChoice('once')).toBe('allow_once');
    expect(parseApprovalChoice('1')).toBe('allow_once');
    expect(parseApprovalChoice('s')).toBe('allow_session');
    expect(parseApprovalChoice('本会话')).toBe('allow_session');
    expect(parseApprovalChoice('a')).toBe('allow_always');
    expect(parseApprovalChoice('全局')).toBe('allow_always');
    expect(parseApprovalChoice('d')).toBe('deny');
    expect(parseApprovalChoice('ESC')).toBe('deny');
    expect(parseApprovalChoice('嗯')).toBeNull();
    expect(parseApprovalChoice('s', { allowSession: false })).toBeNull();
    expect(parseApprovalChoice('a', { allowAlways: false })).toBeNull();
  });

  it('决策 → 作用域映射（always 不属单会话作用域 → null）', () => {
    expect(decisionScopeMode('allow_once')).toBe('once');
    expect(decisionScopeMode('allow_session')).toBe('session');
    expect(decisionScopeMode('allow_always')).toBe('always');
    expect(decisionScopeMode('deny')).toBeNull();
    expect(approvalDecisionToScope('allow_once', 's1')).toEqual({ mode: 'once' });
    expect(approvalDecisionToScope('allow_session', 's1')).toEqual({ mode: 'session', sessionId: 's1' });
    expect(approvalDecisionToScope('allow_always', 's1')).toBeNull();
    expect(approvalDecisionToScope('deny', 's1')).toBeNull();
  });

  it('授权缓存：会话级不跨会话泄漏；全局级经持久化缝落盘', () => {
    const saved: string[][] = [];
    const store = new ApprovalGrantStore({ persistence: { load: () => [], save: (p) => saved.push([...p]) } });
    store.grantSession('s1', 'bash');
    expect(store.isGranted('s1', 'bash')).toBe(true);
    expect(store.isGranted('s2', 'bash')).toBe(false); // 不跨会话
    expect(store.isGrantedGlobally('bash')).toBe(false);
    store.grantAlways('bash');
    expect(store.isGranted('s2', 'bash')).toBe(true);
    expect(saved).toEqual([['bash']]);
    expect(store.revokeAlways('bash')).toBe(true);
    expect(saved).toEqual([['bash'], []]);
    expect(store.revokeSession('s1', 'bash')).toBe(true);
    expect(store.isGranted('s1', 'bash')).toBe(false);
  });

  it('applyApprovalDecision：session/always 写缓存，once/deny 不写', () => {
    const store = new ApprovalGrantStore();
    expect(applyApprovalDecision(store, 'allow_once', { sessionId: 's1', tool: 'bash' })).toEqual({
      scope: 'once',
      granted: false,
    });
    expect(applyApprovalDecision(store, 'allow_session', { sessionId: 's1', tool: 'bash' })).toEqual({
      scope: 'session',
      granted: true,
    });
    expect(applyApprovalDecision(store, 'allow_always', { sessionId: 's1', tool: 'read' })).toEqual({
      scope: 'always',
      granted: true,
    });
    expect(store.listSession('s1')).toEqual(['bash']);
    expect(store.listAlways()).toEqual(['read']);
    expect(applyApprovalDecision(store, 'deny', { sessionId: 's1', tool: 'bash' })).toEqual({
      scope: null,
      granted: false,
    });
  });

  it('与既有 policy 的组合语义：缓存只加宽 ask 的放行面，不绕过 allow/deny', () => {
    const policy = createApprovalPolicy(undefined); // default：read allow / 其余 ask
    const grants = new ApprovalGrantStore();
    const manager = new FlowManager({ grants, idFactory: ids() });
    // serve 侧同序组合：缓存命中 → allow；否则落 policy；policy=ask 才发 flow
    const decide = (sessionId: string, tool: string): string =>
      grants.isGranted(sessionId, tool) ? 'allow' : policy.decide({ tool, args: {} });
    const askFlow = (sessionId: string, tool: string, decision: 'allow_once' | 'allow_session' | 'allow_always') => {
      const req = manager.request({
        kind: 'approval',
        sessionId,
        tool,
        args: {},
        scopes: ['once', 'session', 'always'],
      });
      return manager.respond(req.flowId, { kind: 'approval', decision });
    };

    expect(decide('s1', 'read')).toBe('allow'); // policy 直接 allow，不经 flow
    expect(decide('s1', 'bash')).toBe('ask');
    // o 只放行本次：缓存不写，后续仍 ask
    askFlow('s1', 'bash', 'allow_once');
    expect(decide('s1', 'bash')).toBe('ask');
    // s 落会话缓存：同会话短路 allow，其他会话/其他工具不受影响
    askFlow('s1', 'bash', 'allow_session');
    expect(decide('s1', 'bash')).toBe('allow');
    expect(decide('s2', 'bash')).toBe('ask');
    expect(decide('s1', 'write')).toBe('ask');
    // a 落全局缓存：跨会话短路
    askFlow('s1', 'write', 'allow_always');
    expect(decide('s2', 'write')).toBe('allow');
    // policy=deny 不被缓存解禁（plan 模式非安全工具恒 deny，缓存无命中机会）
    const plan = createApprovalPolicy({ mode: 'plan' });
    expect(plan.decide({ tool: 'bash', args: {} })).toBe('deny');
    // bypass 下 per-tool deny 仍生效（既有 policy 语义，flow 不改变）
    const bypassWithDeny = createApprovalPolicy({ mode: 'bypass', tools: { bash: 'deny' } });
    expect(bypassWithDeny.decide({ tool: 'bash', args: {} })).toBe('deny');
  });
});

// —— H-67 澄清 ——

describe('H-67 澄清 flow：数字选项 + Other + 超时语义', () => {
  const question = {
    qid: 'q1',
    prompt: '选哪个方案？',
    choices: ['方案 A', '方案 B (Recommended)', '方案 C'],
  };

  it('数字选项 / 标签 / 推荐后缀', () => {
    expect(parseClarifyReply('2', question)).toEqual({ status: 'resolved', answers: ['方案 B (Recommended)'] });
    expect(parseClarifyReply('方案 b', question)).toEqual({
      status: 'resolved',
      answers: ['方案 B (Recommended)'],
    });
    expect(parseClarifyReply('方案 B（推荐）', question)).toEqual({
      status: 'resolved',
      answers: ['方案 B (Recommended)'],
    });
    expect(stripRecommended('方案 B (Recommended)')).toBe('方案 B');
  });

  it('多选：逗号/空格列表、all；单选多值拒绝', () => {
    const multi = { ...question, multiSelect: true };
    expect(parseClarifyReply('1,3', multi)).toEqual({ status: 'resolved', answers: ['方案 A', '方案 C'] });
    expect(parseClarifyReply('1 3', multi)).toEqual({ status: 'resolved', answers: ['方案 A', '方案 C'] });
    expect(parseClarifyReply('all', multi)).toEqual({
      status: 'resolved',
      answers: ['方案 A', '方案 B (Recommended)', '方案 C'],
    });
    expect(parseClarifyReply('1,2', question)).toEqual({
      status: 'rejected_selection',
      reason: '该题为单选，只能选一个',
    });
    expect(parseClarifyReply('all', question)).toEqual({
      status: 'rejected_selection',
      reason: '该题为单选，不能全选',
    });
  });

  it('越界/散文/空/Other', () => {
    expect(parseClarifyReply('9', question).status).toBe('rejected_selection');
    expect(parseClarifyReply('随便吧你决定', question).status).toBe('rejected_prose');
    expect(parseClarifyReply('   ', question).status).toBe('empty');
    expect(parseClarifyReply('other', question)).toEqual({ status: 'other' });
    expect(parseClarifyReply('其他', question)).toEqual({ status: 'other' });
  });

  it('开放式（无选项）：任何非空文本即答案；空拒绝', () => {
    const open = { qid: 'q2', prompt: '补充说明？' };
    expect(parseClarifyReply('这是我的补充', open)).toEqual({ status: 'resolved', answers: ['这是我的补充'] });
    expect(parseClarifyReply('  ', open).status).toBe('empty');
    expect(parseOpenClarifyReply('Other 自由文本')).toEqual({
      status: 'resolved',
      answers: ['Other 自由文本'],
      other: 'Other 自由文本',
    });
  });

  it('超时语义：缺省 300s 有界 / <0 不超时 / 0 立即 / >0 有界', () => {
    expect(computeClarifyWait(undefined)).toEqual({ mode: 'bounded', ms: 300_000 });
    expect(computeClarifyWait(-1)).toEqual({ mode: 'unlimited' });
    expect(computeClarifyWait(0)).toEqual({ mode: 'immediate' });
    expect(computeClarifyWait(5_000)).toEqual({ mode: 'bounded', ms: 5_000 });
    const now = new Date('2026-09-14T10:00:00.000Z');
    expect(clarifyDeadline(5_000, now)).toBe('2026-09-14T10:00:05.000Z');
    expect(clarifyDeadline(-1, now)).toBeUndefined();
  });

  it('审计摘要只记项数（不落答案原文）', () => {
    expect(summarizeClarifyAnswers({ q1: ['a'], q2: ['a', 'b'] })).toEqual({ q1: 1, q2: 2 });
  });
});

// —— manager：统一生命周期 ——

describe('flow manager：请求 → 呈现 → 应答 → 审计', () => {
  it('请求注册 + 呈现 + 三壳呈现契约形状', () => {
    const audit = new MemoryFlowAuditSink();
    const presented: FlowPresentation[] = [];
    const { now } = clock();
    const manager = new FlowManager({
      now,
      audit,
      presenter: (p) => presented.push(p),
      idFactory: ids(),
      defaultTimeoutMs: 60_000,
    });
    const request = manager.request({
      kind: 'approval',
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'ls', apiKey: 'sk-should-not-leak' },
      scopes: ['once', 'session', 'always'],
    });
    const id = request.flowId;
    const presentation = manager.presentation(id)!;
    expect(presentation.kind).toBe('approval');
    expect(presentation.approval?.tool).toBe('bash');
    expect(presentation.approval?.scopes).toEqual(['once', 'session', 'always']);
    expect(presentation.approval?.argsSummary).not.toContain('sk-should-not-leak');
    expect(manager.present(id)).toEqual({ flowId: id, state: 'applied' });
    expect(presented).toHaveLength(1);
    expect(manager.present(id)).toEqual({ flowId: id, state: 'duplicate' });
    expect(audit.ofKind('flow/request')).toHaveLength(1);
    expect(audit.ofKind('flow/presented')).toHaveLength(1);
  });

  it('重复请求去重：同 kind/会话/目标复用既有 flowId（审计记 deduped）', () => {
    const audit = new MemoryFlowAuditSink();
    const manager = new FlowManager({ audit, idFactory: ids() });
    const spec = { kind: 'secret' as const, sessionId: 's1', name: 'OPENAI_API_KEY', prompt: '请输入' };
    const a = manager.request(spec);
    const b = manager.request(spec);
    expect(b.flowId).toBe(a.flowId);
    expect(manager.pending()).toHaveLength(1);
    const deduped = audit.entries.filter((e) => e.kind === 'flow/request' && e.deduped === true);
    expect(deduped).toHaveLength(1);
  });

  it('审批应答：applied → 终态；迟到应答 duplicate；种类不符 invalid；未知 unknown', () => {
    const audit = new MemoryFlowAuditSink();
    const grants = new ApprovalGrantStore();
    const manager = new FlowManager({ audit, grants, idFactory: ids() });
    const req = manager.request({
      kind: 'approval',
      sessionId: 's1',
      tool: 'bash',
      args: {},
      scopes: ['once', 'session'],
    });
    expect(manager.respond('nope', { kind: 'approval', decision: 'deny' })).toEqual({
      flowId: 'nope',
      state: 'unknown',
      reason: '未登记的 flow',
    });
    expect(manager.respond(req.flowId, { kind: 'clarify', answers: {} as Record<string, string[]> })).toEqual({
      flowId: req.flowId,
      state: 'invalid',
      reason: '应答种类 clarify 与请求种类 approval 不一致',
    });
    expect(manager.respond(req.flowId, { kind: 'approval', decision: 'allow_session' })).toEqual({
      flowId: req.flowId,
      state: 'applied',
      detail: { scope: 'session' },
    });
    expect(grants.isGranted('s1', 'bash')).toBe(true);
    expect(manager.get(req.flowId)?.state).toBe('answered');
    expect(manager.respond(req.flowId, { kind: 'approval', decision: 'deny' })).toEqual({
      flowId: req.flowId,
      state: 'duplicate',
    });
    // 审计：response + grant
    expect(audit.ofKind('flow/response').map((e) => (e as { decision: string }).decision)).toEqual(['allow_session']);
    expect(audit.ofKind('flow/grant')).toHaveLength(1);
  });

  it('allow_session 缺 sessionId → invalid（不授予无归属授权）', () => {
    const manager = new FlowManager({ grants: new ApprovalGrantStore(), idFactory: ids() });
    const req = manager.request({ kind: 'approval', tool: 'bash', args: {}, scopes: ['session'] });
    const ack = manager.respond(req.flowId, { kind: 'approval', decision: 'allow_session' });
    expect(ack.state).toBe('invalid');
    expect(manager.get(req.flowId)?.state).toBe('pending');
  });

  it('过期 fail-closed：到点应答落 expired 且绝不放行；expireDue 扫描', () => {
    const audit = new MemoryFlowAuditSink();
    const c = clock();
    const manager = new FlowManager({ now: c.now, audit, idFactory: ids(), defaultTimeoutMs: 1_000 });
    const req = manager.request({
      kind: 'approval',
      sessionId: 's1',
      tool: 'bash',
      args: {},
      scopes: ['once'],
    });
    c.advance(1_500);
    expect(manager.respond(req.flowId, { kind: 'approval', decision: 'allow_once' })).toEqual({
      flowId: req.flowId,
      state: 'expired',
      reason: '请求已过期',
    });
    expect(manager.get(req.flowId)?.state).toBe('expired');
    expect(audit.ofKind('flow/expired')).toHaveLength(1);
    // 另一条走 expireDue
    const req2 = manager.request({ kind: 'clarify', sessionId: 's1', questions: [{ qid: 'a', prompt: 'p' }] });
    c.advance(2_000);
    const swept = manager.expireDue();
    expect(swept.map((a) => a.flowId)).toEqual([req2.flowId]);
  });

  it('取消：pending/presented → cancelled；终态不可再落定', () => {
    const audit = new MemoryFlowAuditSink();
    const manager = new FlowManager({ audit, idFactory: ids() });
    const req = manager.request({ kind: 'clarify', questions: [{ qid: 'q', prompt: 'p' }] });
    expect(manager.cancel(req.flowId)).toEqual({ flowId: req.flowId, state: 'applied' });
    expect(manager.get(req.flowId)?.state).toBe('cancelled');
    expect(manager.cancel(req.flowId)).toEqual({ flowId: req.flowId, state: 'duplicate' });
    expect(audit.ofKind('flow/cancelled')).toHaveLength(1);
  });

  it('澄清应答：answers 计数进审计（不落答案原文）', () => {
    const audit = new MemoryFlowAuditSink();
    const manager = new FlowManager({ audit, idFactory: ids() });
    const req = manager.request({
      kind: 'clarify',
      sessionId: 's1',
      questions: [{ qid: 'q1', prompt: 'p', choices: ['a', 'b'] }],
    });
    const ack = manager.respond(req.flowId, { kind: 'clarify', answers: { q1: ['a'] } });
    expect(ack).toEqual({ flowId: req.flowId, state: 'applied', detail: { q1: 1 } });
    const response = audit.ofKind('flow/response')[0] as { detail?: Record<string, number> };
    expect(response.detail).toEqual({ q1: 1 });
    expect(JSON.stringify(audit.entries)).not.toContain('"q1":["a"]');
  });

  it('呈现契约：澄清带 allowOther；sudo/secret 恒 echo:false（机密输入不回显）', () => {
    const manager = new FlowManager({ idFactory: ids() });
    const clarify = manager.presentation(
      manager.request({ kind: 'clarify', questions: [{ qid: 'q', prompt: 'p', choices: ['x'] }] }).flowId,
    )!;
    expect(clarify.clarify?.questions[0]).toEqual({
      qid: 'q',
      prompt: 'p',
      choices: ['x'],
      multiSelect: false,
      allowOther: true,
    });
    const sudo = manager.presentation(
      manager.request({ kind: 'sudo', reason: '装包', command: 'apt install' }).flowId,
    )!;
    expect(sudo.sudoInput).toEqual({ reason: '装包', command: 'apt install', echo: false });
    const secret = manager.presentation(
      manager.request({ kind: 'secret', name: 'OPENAI_API_KEY', prompt: '请输入' }).flowId,
    )!;
    expect(secret.secretInput).toEqual({ name: 'OPENAI_API_KEY', echo: false });
    expect(JSON.stringify(secret)).not.toContain('value');
  });
});

// —— H-44 / H-68 特权全链 ——

describe('H-44/H-68 特权流：sudo.request 与 secret.request 全链', () => {
  it('sudo：取消/空口令不签发；有口令签发一次性票据并审计', () => {
    const audit = new MemoryFlowAuditSink();
    const c = clock();
    const broker = new PrivilegeBroker({ now: c.now, audit });
    const base = {
      kind: 'sudo' as const,
      flowId: 'f1',
      createdAt: c.now().toISOString(),
      reason: '安装系统包',
    };
    expect(broker.handleSudo(base, { kind: 'sudo', cancelled: true })).toEqual({ decision: 'cancelled' });
    expect(broker.handleSudo(base, { kind: 'sudo', password: '' })).toEqual({
      decision: 'skipped',
      reason: '未提供口令',
    });
    expect(broker.grantCount).toBe(0);
    const outcome = broker.handleSudo(base, { kind: 'sudo', password: 'hunter2-not-echoed' });
    expect(outcome.decision).toBe('submitted');
    expect(outcome.granted).toBe(true);
    expect(outcome.detail?.grantId).toBeTypeOf('string');
    expect(JSON.stringify(outcome)).not.toContain('hunter2-not-echoed');
    expect(audit.ofKind('flow/grant')).toHaveLength(1);
    expect(JSON.stringify(audit.entries)).not.toContain('hunter2-not-echoed');
  });

  it('sudo 票据：一次性 / 过期 / 会话绑定 / 未知', () => {
    const audit = new MemoryFlowAuditSink();
    const c = clock();
    const broker = new PrivilegeBroker({ now: c.now, audit, grantTtlMs: 1_000 });
    const req = {
      kind: 'sudo' as const,
      flowId: 'f1',
      createdAt: c.now().toISOString(),
      reason: 'r',
      sessionId: 's1',
      command: 'apt install',
    };
    const outcome = broker.handleSudo(req, { kind: 'sudo', password: 'pw' });
    const grantId = String(outcome.detail?.grantId);
    expect(broker.consumeSudo('grant-unknown')).toEqual({ ok: false, reason: 'unknown' });
    expect(broker.consumeSudo(grantId, { sessionId: 's2' })).toEqual({ ok: false, reason: 'session-mismatch' });
    expect(broker.consumeSudo(grantId, { sessionId: 's1', command: 'rm -rf /' })).toEqual({
      ok: false,
      reason: 'command-mismatch',
    });
    const ok = broker.consumeSudo(grantId, { sessionId: 's1', command: 'apt install' });
    expect(ok.ok).toBe(true);
    expect(broker.consumeSudo(grantId, { sessionId: 's1', command: 'apt install' })).toEqual({
      ok: false,
      reason: 'consumed',
    });
    // P2-3：命令侧 fail-closed——票据带 command 时不带命令消费同样拒绝（与 session 侧对称）
    const reqNoCmd = {
      kind: 'sudo' as const,
      flowId: 'f1b',
      createdAt: c.now().toISOString(),
      reason: 'r',
      sessionId: 's1',
      command: 'apt install',
    };
    const grantNoCmd = String(broker.handleSudo(reqNoCmd, { kind: 'sudo', password: 'pw' }).detail?.grantId);
    expect(broker.consumeSudo(grantNoCmd, { sessionId: 's1' })).toEqual({ ok: false, reason: 'command-mismatch' });
    // 票据未绑定 command → 不带命令消费仍放行（无绑定即无约束，语义不变）
    const req2b = { kind: 'sudo' as const, flowId: 'f1c', createdAt: c.now().toISOString(), reason: 'r' };
    const freeGrant = String(broker.handleSudo(req2b, { kind: 'sudo', password: 'pw' }).detail?.grantId);
    expect(broker.consumeSudo(freeGrant).ok).toBe(true);
    // 过期票据
    const req2 = { kind: 'sudo' as const, flowId: 'f2', createdAt: c.now().toISOString(), reason: 'r' };
    const grant2 = String(broker.handleSudo(req2, { kind: 'sudo', password: 'pw' }).detail?.grantId);
    c.advance(2_000);
    expect(broker.consumeSudo(grant2)).toEqual({ ok: false, reason: 'expired' });
    const consumes = audit.ofKind('flow/consume') as Array<{ ok: boolean; reason?: string }>;
    expect(consumes.map((e) => e.reason).filter(Boolean)).toContain('expired');
    expect(consumes.some((e) => e.ok)).toBe(true);
  });

  it('secret：跳过/空值不算失败；未配 vault → denied；配 vault → stored（只回 storedAs）', () => {
    const audit = new MemoryFlowAuditSink();
    const req = {
      kind: 'secret' as const,
      flowId: 'f1',
      createdAt: new Date().toISOString(),
      name: 'OPENAI_API_KEY',
      prompt: '请输入',
    };
    const noVault = new PrivilegeBroker({ audit });
    expect(noVault.handleSecret(req, { kind: 'secret', skipped: true })).toEqual({ decision: 'skipped' });
    expect(noVault.handleSecret(req, { kind: 'secret', value: '' })).toEqual({
      decision: 'skipped',
      reason: '未提供内容',
    });
    expect(noVault.handleSecret(req, { kind: 'secret', value: 'sk-live-abcdef' })).toEqual({
      decision: 'denied',
      reason: '未配置机密存储（SecretVault）',
    });

    const stored: Array<[string, string]> = [];
    const withVault = new PrivilegeBroker({
      audit,
      vault: {
        store: (name, value) => {
          stored.push([name, value]);
          return { ok: true, storedAs: `${name}@auth.json` };
        },
      },
    });
    const outcome = withVault.handleSecret(req, { kind: 'secret', value: 'sk-live-abcdef' });
    expect(outcome).toEqual({ decision: 'stored', granted: true, detail: { storedAs: 'OPENAI_API_KEY@auth.json' } });
    expect(stored).toEqual([['OPENAI_API_KEY', 'sk-live-abcdef']]);
    expect(JSON.stringify(outcome)).not.toContain('sk-live-abcdef');
  });

  it('vault 抛错 → denied 且原因脱敏', () => {
    const broker = new PrivilegeBroker({
      vault: {
        store: () => {
          throw new Error('disk failed for apiKey=sk-secret-123456');
        },
      },
    });
    const outcome = broker.handleSecret(
      { kind: 'secret', flowId: 'f', createdAt: new Date().toISOString(), name: 'K', prompt: 'p' },
      { kind: 'secret', value: 'v' },
    );
    expect(outcome.decision).toBe('denied');
    expect(outcome.reason).not.toContain('sk-secret-123456');
  });

  // P2-3：credentialSink.use 抛错也必须收口脱敏（抛出的错误消息可能夹带口令）
  it('credentialSink 抛错 → denied 且原因脱敏（不原样逃出，不签发票据）', () => {
    const broker = new PrivilegeBroker({
      credentialSink: {
        use: () => {
          // 模拟执行层把口令写进错误消息（token=… 形态正是 redactSecrets 的拦截面）
          throw new Error('sudo helper failed: token=SuperSecret123');
        },
      },
    });
    const outcome = broker.handleSudo(
      { kind: 'sudo', flowId: 'f', createdAt: new Date().toISOString(), reason: 'r', command: 'apt install' },
      { kind: 'sudo', password: 'SuperSecret123' },
    );
    expect(outcome.decision).toBe('denied');
    expect(outcome.reason).not.toContain('SuperSecret123');
    expect(outcome.reason).toContain('[REDACTED]');
    expect(outcome.granted).toBeUndefined();
    expect(broker.grantCount).toBe(0); // 拒绝时不留下可消费票据
  });

  it('全链（manager + broker）：sudo 请求 → 应答 → 票据可消费 → 审计齐全', () => {
    const audit = new MemoryFlowAuditSink();
    const c = clock();
    const broker = new PrivilegeBroker({ now: c.now, audit });
    const manager = new FlowManager({ now: c.now, audit, privilege: broker, idFactory: ids() });
    const spec = sudoRequestSpec({ sessionId: 's1', reason: '安装系统包', command: 'apt install' }, c.now());
    const req = manager.request(spec);
    expect(manager.present(req.flowId).state).toBe('applied');
    const ack = manager.respond(req.flowId, { kind: 'sudo', password: 'pw-not-logged' });
    expect(ack.state).toBe('applied');
    expect(ack.detail?.grantId).toBeTypeOf('string');
    expect(manager.get(req.flowId)?.state).toBe('answered');
    const consumed = broker.consumeSudo(String(ack.detail?.grantId), { sessionId: 's1', command: 'apt install' });
    expect(consumed.ok).toBe(true);
    const kinds = audit.entries.map((e) => e.kind);
    expect(kinds).toContain('flow/request');
    expect(kinds).toContain('flow/presented');
    expect(kinds).toContain('flow/grant');
    expect(kinds).toContain('flow/response');
    expect(kinds).toContain('flow/consume');
    expect(containsForbiddenAuditKeys(audit.entries)).toBe(false);
    expect(JSON.stringify(audit.entries)).not.toContain('pw-not-logged');
  });

  it('全链（manager + broker）：secret 请求 → 应答 → 只留 storedAs 引用；记录/审计零明文', () => {
    const audit = new MemoryFlowAuditSink();
    const secretValue = 'sk-live-topsecret-987654321';
    const broker = new PrivilegeBroker({
      audit,
      vault: { store: (name) => ({ ok: true, storedAs: `${name}@auth.json` }) },
    });
    const manager = new FlowManager({ audit, privilege: broker, idFactory: ids() });
    const req = manager.request(secretRequestSpec({ sessionId: 's1', name: 'OPENAI_API_KEY', prompt: '请输入' }));
    manager.present(req.flowId);
    const ack = manager.respond(req.flowId, { kind: 'secret', value: secretValue });
    expect(ack.detail).toEqual({ storedAs: 'OPENAI_API_KEY@auth.json' });
    const record = manager.get(req.flowId)!;
    expect(record.state).toBe('answered');
    expect(record.detail).toEqual({ storedAs: 'OPENAI_API_KEY@auth.json' });
    expect(JSON.stringify(record)).not.toContain(secretValue);
    expect(JSON.stringify(audit.entries)).not.toContain(secretValue);
    expect(JSON.stringify(manager.presentation(req.flowId))).not.toContain(secretValue);
  });

  it('未装配 PrivilegeSink → 特权应答 denied（不静默放行）', () => {
    const manager = new FlowManager({ idFactory: ids() });
    const req = manager.request({ kind: 'sudo', reason: 'r' });
    const ack = manager.respond(req.flowId, { kind: 'sudo', password: 'pw' });
    expect(ack.state).toBe('applied');
    expect(manager.get(req.flowId)?.state).toBe('denied');
    expect(manager.get(req.flowId)?.decision).toBe('denied');
  });
});

// —— H-67 超时三态在 manager 的落地（unlimited / immediate / bounded） ——
// 补强点：既有用例已钉死纯函数 computeClarifyWait 的三态与「到期 fail-closed」，
// 但未覆盖 (a) bounded 到期前/到期后的对照、(b) unlimited 永不过期（expireDue 不落定）、
// (c) immediate（expiresAt=now）应答即 expired。这里逐态给 manager 级证据。
describe('H-67 澄清超时三态（manager 落地：unbounded 不等于 immediate）', () => {
  it('bounded：到期前应答 applied；到期后落到另一条 → expired（fail-closed）', () => {
    const c = clock();
    const audit = new MemoryFlowAuditSink();
    const manager = new FlowManager({ now: c.now, audit, idFactory: ids(), defaultTimeoutMs: 1_000 });
    const before = manager.request({ kind: 'clarify', sessionId: 's1', questions: [{ qid: 'q', prompt: 'p' }] });
    c.advance(500);
    expect(manager.respond(before.flowId, { kind: 'clarify', answers: { q: ['x'] } }).state).toBe('applied');
    const after = manager.request({ kind: 'clarify', sessionId: 's2', questions: [{ qid: 'q', prompt: 'p' }] });
    c.advance(1_500);
    expect(manager.respond(after.flowId, { kind: 'clarify', answers: { q: ['x'] } })).toEqual({
      flowId: after.flowId,
      state: 'expired',
      reason: '请求已过期',
    });
    expect(audit.ofKind('flow/expired')).toHaveLength(1);
  });

  it('immediate（expiresAt=now）：应答即 expired，绝不放行', () => {
    const c = clock();
    const manager = new FlowManager({ now: c.now, idFactory: ids() });
    const req = manager.request({
      kind: 'clarify',
      sessionId: 's1',
      questions: [{ qid: 'q', prompt: 'p' }],
      expiresAt: c.now().toISOString(),
    });
    expect(manager.respond(req.flowId, { kind: 'clarify', answers: { q: ['x'] } }).state).toBe('expired');
    expect(manager.get(req.flowId)?.state).toBe('expired');
  });

  it('unlimited（不设 expiresAt）：时钟推进 10 天后 expireDue 不动它，迟到应答仍 applied', () => {
    const c = clock();
    const audit = new MemoryFlowAuditSink();
    const manager = new FlowManager({ now: c.now, audit, idFactory: ids() });
    const req = manager.request({ kind: 'clarify', sessionId: 's1', questions: [{ qid: 'q', prompt: 'p' }] });
    c.advance(10 * 24 * 3600 * 1000);
    expect(manager.expireDue()).toEqual([]);
    expect(manager.get(req.flowId)?.state).toBe('pending');
    expect(manager.respond(req.flowId, { kind: 'clarify', answers: { q: ['x'] } }).state).toBe('applied');
    expect(audit.ofKind('flow/expired')).toHaveLength(0);
  });
});

// —— H-44/H-68 补强：sudo 口令四处不出现（返回值 / 记录 / 审计 / 呈现） ——
describe('H-44/H-68 sudo 口令红线（四处不出现，且确实经凭据缝消费）', () => {
  it('口令只在凭据缝出现一次；ack/record/audit/presentation 全链零明文', () => {
    const audit = new MemoryFlowAuditSink();
    const used: Array<{ password: string; grantId: string }> = [];
    const broker = new PrivilegeBroker({
      audit,
      credentialSink: {
        use: (password, ctx) => {
          used.push({ password, grantId: ctx.grantId });
          return { ok: true };
        },
      },
    });
    const manager = new FlowManager({ audit, privilege: broker, idFactory: ids() });
    const secretPw = 'sudo-pw-must-not-appear-42';
    const req = manager.request(sudoRequestSpec({ sessionId: 's1', reason: '安装系统包', command: 'apt install' }));
    expect(manager.present(req.flowId).state).toBe('applied');
    const ack = manager.respond(req.flowId, { kind: 'sudo', password: secretPw });
    expect(ack.state).toBe('applied');

    // ① 返回值（ack）
    expect(JSON.stringify(ack)).not.toContain(secretPw);
    // ② 记录（FlowRecord，含 request/decision/detail）
    expect(JSON.stringify(manager.get(req.flowId))).not.toContain(secretPw);
    // ③ 审计（含 flow/grant 与 flow/response 行）
    expect(JSON.stringify(audit.entries)).not.toContain(secretPw);
    // ④ 呈现（echo:false，只带 reason/command 摘要）
    const presentation = manager.presentation(req.flowId)!;
    expect(JSON.stringify(presentation)).not.toContain(secretPw);
    expect(presentation.sudoInput?.echo).toBe(false);

    // 口令确实交给凭据缝一次（不是被静默丢弃），随后只留一次性票据
    expect(used).toEqual([{ password: secretPw, grantId: String(ack.detail?.grantId) }]);
    const grantId = String(ack.detail?.grantId);
    expect(broker.consumeSudo(grantId, { sessionId: 's1', command: 'apt install' }).ok).toBe(true);
    expect(broker.consumeSudo(grantId, { sessionId: 's1', command: 'apt install' })).toEqual({
      ok: false,
      reason: 'consumed',
    });
  });
});

// —— 审计账本 ——

describe('flow 审计账本（追加写 JSONL + 机密零泄漏）', () => {
  it('append/read 往返；seq 单调；重启续写 seq', () => {
    const file = join(tmpDir(), 'flows.v1.jsonl');
    const log = FlowAuditLog.open(file);
    log.append({ kind: 'flow/request', flowId: 'f1', flowKind: 'approval', summary: '工具 bash' });
    log.append({ kind: 'flow/presented', flowId: 'f1', flowKind: 'approval', title: '需要审批' });
    const opened = FlowAuditLog.open(file);
    opened.append({ kind: 'flow/expired', flowId: 'f1', flowKind: 'approval' });
    const entries = opened.readEntries();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.kind)).toEqual(['flow/request', 'flow/presented', 'flow/expired']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('出口脱敏 + 禁止键剥离；parseFlowAuditEntry 宽容读', () => {
    const file = join(tmpDir(), 'flows.v1.jsonl');
    const log = FlowAuditLog.open(file);
    log.append({
      kind: 'flow/response',
      flowId: 'f1',
      flowKind: 'secret',
      decision: 'stored',
      detail: { storedAs: 'OPENAI_API_KEY@auth.json', token: 'sk-leak-123456' },
    } as never);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-leak-123456');
    expect(raw).not.toContain('"token"');
    const entry = parseFlowAuditEntry('{"v":1,"seq":1,"ts":"2026-09-14T10:00:00.000Z","kind":"flow/request"}');
    expect(entry?.kind).toBe('flow/request');
    expect(parseFlowAuditEntry('not json')).toBeNull();
    expect(parseFlowAuditEntry('{"v":9,"seq":1,"ts":"2026-09-14T10:00:00.000Z","kind":"flow/request"}')).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it('MemoryFlowAuditSink 与日志 append 同形（测试句柄）', () => {
    const sink = new MemoryFlowAuditSink(() => new Date('2026-09-14T10:00:00.000Z'));
    const entry = sink.append({ kind: 'flow/cancelled', flowId: 'f', flowKind: 'clarify' });
    expect(entry.seq).toBe(1);
    expect(entry.ts).toBe('2026-09-14T10:00:00.000Z');
    expect(sink.ofKind('flow/cancelled')).toHaveLength(1);
  });

  it('sink 自派 seq：特权 broker 经 FlowAuditLog 落盘的行全部可读回（无占位 seq 脏行）', () => {
    const file = join(tmpDir(), 'flows.v1.jsonl');
    const log = FlowAuditLog.open(file);
    const broker = new PrivilegeBroker({ audit: log });
    const outcome = broker.handleSudo(
      { kind: 'sudo', flowId: 'f1', createdAt: new Date().toISOString(), reason: 'r' },
      { kind: 'sudo', password: 'pw' },
    );
    broker.consumeSudo(String(outcome.detail?.grantId));
    const entries = log.readEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_e, i) => i + 1)); // 1..n 连续
    expect(entries.map((e) => e.kind)).toEqual(['flow/grant', 'flow/consume']);
    // 落盘原文里不应出现占位 seq=0 行
    expect(readFileSync(file, 'utf8')).not.toContain('"seq":0');
  });
});
