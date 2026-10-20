// B1 重放微基准（U1 计划 T4 第 4 条，docs/ai-framework/plans/2026-10-14-u1-executor-briefs.md）：
//   程序生成 1000 事件的会话流（session/header → user/message → assistant/attempt + step/start +
//   tool/call + tool/result + step/end 循环，混合 assistant/message，ts 严格递增），
//   一次性 `applyReplay` 全量 + `chatItems`（projectChatItems 投影路径）计时。
//
// 预算口径（出处 = 执行简报 T4 第 4 条「B1 微基准」）：
//   目标 ≤200ms（切会话重放全量 + 投影的交互可感预算）+ 50ms jsdom/CI 计时宽容 = 断言阈值 250ms。
//   跑 3 次取**中位数**断言（防 GC 单点尖刺）；beforeAll 先对 50 事件小流预热（防 JIT 冷启动噪声）。
//   分段计时（replayMs / projectMs）随结果输出，超预算时即为瓶颈归因数据（触发 T7 条件任务，
//   **禁止自行上虚拟化**——那是编排者决策）。
//   计时钟：简报写 Date.now()，但 1000 事件重放+投影实测为**亚毫秒级**，Date.now（~1ms 分辨率）
//   会读成 0 → 断言失义（假绿）。故断言取 performance.now 中位数（同一预算、更严的钟）；
//   Date.now 墙钟值仍随行输出留痕。投影非空由 itemCount>500 断言钉死（防空投假绿）。
//
// 实测中位数 ~0.25ms（jsdom, maxWorkers=4, 2026-10-14：replay ~0.02ms + project ~0.23ms，
//   1000 事件 → 717 条目；预算富余三个数量级）。
// 10000 事件数据点（2026-10-14 同环境临时改流实测，**未改断言阈值**，仅登记）：
//   median total ~2.33ms（replay ~0.09ms + project ~2.04ms → 7145 条目）。
//   线性度良好（10x 事件 ≈ 9x 耗时，无超线性信号）→ 无需虚拟化，不触发 T7。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import type { SessionEventsPayloadShape } from '../src/shared/protocol.js';

const SESSION_ID = 'bench-1000';
/** B1 断言阈值：目标 200ms + 50ms jsdom/CI 宽容（口径见文件头注释与执行简报 T4-4） */
const BUDGET_MS = 250;
const RUNS = 3;
/** 完整轮块大小（user + attempt + step/start + call + result + step/end + assistant/message） */
const TURN_BLOCK = 7;

type ActiveEvent = SessionEventsPayloadShape['events'][number];

/**
 * 程序生成事件流（恰好 target 条）：
 *   session/header → 若干完整轮块（user/message 开头，轮内 assistant/attempt + step/start +
 *   tool/call + tool/result + step/end，轮尾混入一条 assistant/message）→ 尾部余量用
 *   **不破坏配对的单事件**填充（user/message / assistant/attempt / assistant/message，
 *   模拟「最新一轮进行中」的真实尾部；绝不产生无 result 的 tool/call）。
 * seq 连续（1..target）、ts 严格递增（每事件 +40ms）由末端统一编号保证。
 */
function buildStream(target: number): SessionEventsPayloadShape {
  const raw: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const push = (type: string, payload: Record<string, unknown>): void => {
    raw.push({ type, payload });
  };

  push('session/header', { sessionId: SESSION_ID, cwd: '/bench', createdAt: '2026-10-14T00:00:00.000Z' });
  let callNo = 0;
  // 完整轮块只在装得下时进入（块内 tool/call↔tool/result 恒配对）
  for (let turn = 1; raw.length + TURN_BLOCK <= target; turn++) {
    const turnId = `t${turn}`;
    push('user/message', { turnId, text: `第 ${turn} 轮提问：跑一批命令` });
    push('assistant/attempt', { turnId, text: `第 ${turn} 轮尝试片段` });
    push('step/start', { turnId });
    callNo += 1;
    push('tool/call', { turnId, callId: `c-${callNo}`, tool: 'bash', args: { command: `ls -la ${turn}` } });
    push('tool/result', { callId: `c-${callNo}`, ok: true, output: 'total 0\ndrwxr-xr-x ...', durationMs: 12 });
    push('step/end', { turnId, durationMs: 120 });
    push('assistant/message', { turnId, text: `第 ${turn} 轮回答正文`, model: 'bench-model' });
  }
  // 尾部余量：单事件填充（投影安全、无配对约束）
  const tailTurnId = 't-tail';
  const fillers: Array<[string, Record<string, unknown>]> = [
    ['user/message', { turnId: tailTurnId, text: '收尾追问' }],
    ['assistant/attempt', { turnId: tailTurnId, text: '收尾尝试片段' }],
    ['assistant/message', { turnId: tailTurnId, text: '收尾回答' }],
  ];
  for (let i = 0; raw.length < target; i++) {
    const [type, payload] = fillers[i % fillers.length]!;
    push(type, payload);
  }

  // 统一编号：seq 连续、ts 严格递增（每事件 +40ms）；active:true（重放路径服务端已判影子，
  // 无 rewind/marker → 全活动；投影层 `if (!e.active) continue` 依赖此标志）
  const base = Date.UTC(2026, 9, 14, 0, 0, 0);
  const events: ActiveEvent[] = raw.slice(0, target).map((e, i) => ({
    v: 1 as const,
    seq: i + 1,
    ts: new Date(base + (i + 1) * 40).toISOString(),
    type: e.type,
    payload: e.payload,
    active: true,
  }));
  return {
    id: SESSION_ID,
    dir: '/bench',
    header: { sessionId: SESSION_ID, cwd: '/bench' },
    events,
    warnings: [],
    lastSeq: events.length,
  };
}

interface TimedRun {
  /** 高精度分段（performance.now，亚毫秒可见）——报告数据点 / 超预算归因用 */
  replayMs: number;
  projectMs: number;
  totalMs: number;
  /** Date.now 计时（简报口径：断言用；~1ms 分辨率，故另留 performance.now 精确值） */
  wallTotalMs: number;
  itemCount: number;
}

/** 一次全量重放 + 投影（每次全新 store，模拟切会话冷路径） */
function timedRun(payload: SessionEventsPayloadShape): TimedRun {
  const store = new AppStore();
  // 断言口径：Date.now()（执行简报 T4-4 明写 `expect(Date.now()-t0)`）
  const w0 = Date.now();
  // 分段/报告口径：performance.now()（1000 事件重放+投影为亚毫秒级，Date.now 会读成 0）
  const t0 = performance.now();
  store.applyReplay(payload);
  const t1 = performance.now();
  const items = store.chatItems(SESSION_ID);
  const t2 = performance.now();
  const w1 = Date.now();
  return {
    replayMs: t1 - t0,
    projectMs: t2 - t1,
    totalMs: t2 - t0,
    wallTotalMs: w1 - w0,
    itemCount: items.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('B1 重放微基准：1000 事件全量 applyReplay + projectChatItems', () => {
  const payload = buildStream(1000);

  beforeAll(() => {
    // 预热：50 事件小流跑一遍完整路径（JIT 编译 / 模块惰性初始化），防冷启动噪声进中位数
    const warm = buildStream(50);
    const r = timedRun(warm);
    expect(r.itemCount).toBeGreaterThan(0);
  });

  it('生成器自证：恰好 1000 事件、seq 连续、ts 严格递增、类型构成符合剧本', () => {
    expect(payload.events).toHaveLength(1000);
    expect(payload.lastSeq).toBe(1000);
    let prevTs = '';
    payload.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(e.ts > prevTs).toBe(true); // ISO 串同格式字典序 = 时间序
      prevTs = e.ts;
    });
    const types = new Map<string, number>();
    for (const e of payload.events) types.set(e.type, (types.get(e.type) ?? 0) + 1);
    expect(types.get('session/header')).toBe(1);
    expect(types.get('user/message')).toBeGreaterThan(1); // 多轮
    expect(types.get('tool/call')).toBeGreaterThan(100); // 工具周期为主体
    expect(types.get('tool/call')).toBe(types.get('tool/result')); // 配对不破
    expect(types.get('step/start')).toBe(types.get('step/end'));
    expect(types.get('assistant/message')).toBeGreaterThan(10); // 有混入
    expect(types.get('assistant/attempt')).toBeGreaterThan(10);
  });

  it(`3 次取中位数：全量重放 + 投影 ≤ ${BUDGET_MS}ms（目标 200 + 50 jsdom 宽容）`, () => {
    const runs: TimedRun[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(timedRun(payload));

    const medTotal = median(runs.map((r) => r.totalMs));
    const medReplay = median(runs.map((r) => r.replayMs));
    const medProject = median(runs.map((r) => r.projectMs));
    const medWall = median(runs.map((r) => r.wallTotalMs));

    // 投影结果非空自证（不是「什么都没投所以快」的假绿）：1000 事件 → 数百条目
    for (const r of runs) expect(r.itemCount).toBeGreaterThan(500);

    // 实测留痕（闸门输出可见；超预算时即为 T7 归因数据：分段 replay vs project）。
    // 断言取 performance.now 中位数（Date.now 分辨率 ~1ms，亚毫秒工作会读成 0 → 断言失义）
    console.info(
      `[B1] runs(perf)=${JSON.stringify(runs.map((r) => +r.totalMs.toFixed(2)))}ms ` +
        `median total=${medTotal.toFixed(2)}ms (replay=${medReplay.toFixed(2)}ms + project=${medProject.toFixed(2)}ms) ` +
        `Date.now wall median=${medWall}ms budget=${BUDGET_MS}ms`,
    );

    expect(medTotal).toBeLessThanOrEqual(BUDGET_MS);
  });
});
