# ZS3 Task 6 — core 最小加性面提案：elicitation (userInput 问询) 往返

> **性质：** 只读研究提案（2026-10-21），对应阶段 ZS3 Task 6（`docs/ai-framework/plans/2026-10-21-phase-ZS3-conversation-parity.md` §Task 6）与 Global Constraints 第 2 条的「core 逐个解冻纪律」。本文件仅提案，**不修改任何源码/配置/测试**，编排者批准后才动 core。
>
> **依据：** 映射详表 `docs/research/2026-10-20-zs-a-class-mapping.md` §3.3/§3.5；ZCode 只读源 `D:/AI_Projects/refs/ZCode/packages/shared/src/zcode-protocol-v4/snapshot.ts:281-298` (`userInputRequestPayloadSchema`) 与 `packages/ui/src/v4/V4UserInputDialog.tsx`、`packages/ui/src/ElicitationDialog.tsx`；core 侧 `packages/core/src/interaction/`、`packages/core/src/server/sessions-types.ts`、`packages/core/src/session/types.ts`、`packages/core/src/session/extension-events.ts`。

---

## 1. 问题陈述

### 1.1 缺口定性

映射详表 §3.5「双向缺口汇总」把 elicitation/AskUserQuestion 往返列为 **ZCode 有、core 无** 的 B 类缺口，排序为 ZS3 优先级首位；§3.3 pendingInteractions 行明确 `userInput → 缺口→B`；§1.3 `IZCodeTaskService.respondElicitation` 映射为「缺口→B（core 无 AskUserQuestion/elicitation 往返）」。core 侧完全没有「交互问询请求/应答」往返原语，因此 adapter 无法把 core 的问询投影为 v4 `pendingInteractions{kind:'userInput'}`，也无法把 UI 的 `resolveInteraction{freeText|optionId}` 回填到 core。

### 1.2 core 无往返的准确证据（file:line）

1. 事件类型白名单不含任何交互请求类型：`packages/core/src/session/types.ts:14-25`（`SessionEventType` 联合仅 11 种：`session/header, user/message, assistant/message, assistant/attempt, step/start, step/end, tool/call, tool/result, memory/snapshot, compaction/applied, rewind/marker`）；`:208-225` 的 `PAYLOAD_VALIDATORS` 无 userInput/interaction 校验器。
2. 扩展事件注册表存在但未注册交互类型：`packages/core/src/session/extension-events.ts:49-115`（`ExtensionEventTypeRegistry`）进程级单例 `extensionEventTypes`（:114），core 代码库中无 `interaction/*` 注册调用（grep `elicitation|userInput|interaction/request` in `packages/core/src` = 0 命中）。
3. `SessionHubHooks` 仅有审批上抛，无问询上抛：`packages/core/src/server/sessions-types.ts:96-123`（`onApprovalRequest` :111、`onApprovalSettled` :113；无 `onUserInputRequest`/`onUserInputSettled`）。
4. 审批队列是 approval 专用：`packages/core/src/interaction/approval-queue.ts`（`ApprovalQueue`，`respond()` :71-96 五态 decision `allow|allow-session|allow-always|deny|deny-always`，`ApprovalSettleReason` :15），无通用交互队列、无 userInput 应答形状。
5. core 无任何 producer/消费：`packages/core/src` 全文搜索 `elicitation|AskUserQuestion|requestUserInput|respondElicitation` = 0 命中（待核实：MCP client 是否支持 elicitation 未查，`packages/core/src/mcp/client.ts` 未读；本提案按「无」处理，若存在则提案范围缩小）。
6. ZCode 侧消费证据：`snapshot.ts:281-298` `userInputRequestPayloadSchema`（`kind:'userInput'`、`prompt`、`freeText`、`options[{optionId,label}]`、`sensitive`、`toolName`、`toolCallId`、`traceId`、`input/schema`、`questions[]`、`currentQuestionIndex`、`answerDrafts`、`origin`）；UI 消费 `packages/ui/src/v4/V4UserInputDialog.tsx:13-17`（`onSubmit: (answer: { optionId?; freeText? })`）与 `packages/ui/src/ElicitationDialog.tsx:22-37`（`onRespond(requestId, action:'accept'|'decline'|'cancel', content?)`）。

### 1.3 为什么 adapter 不能自己补

adapter 仅做投影/桥接；伪造 core 事件既无 durable roundtrip（respond 无法回填 producer 的 await），又违反红线⑩与 Global Constraints ②（core 零改动纪律除 T6 提案批准窗口），且 V5 验收明确「T6 未批不伪造 core 事件」。因此必须先有 core 原语。

---

## 2. 最小加性面提案（一次一个加性点）

设计立场：**镜像 approval 链路但独立类型**——复用队列/超时/去重/多点送达的工程模式，不复用 approval 的 decision 语义与形状（见 §3.2）。

### 2.1 加性点清单（建议单 commit 顺序）

1. 类型：`packages/core/src/interaction/types.ts`（或新增 `packages/core/src/interaction/user-input.ts`）加 `UserInputRequestContract / UserInputAnswer / UserInputResponseAck / ...`。
2. 队列：新增 `packages/core/src/interaction/user-input-queue.ts`（`UserInputQueue`）。
3. Hook：`SessionHubHooks` 加 `onUserInputRequest` / `onUserInputSettled`（可选）。
4. SessionHub 方法：`requestUserInput / respondUserInput / listPendingUserInputs / pendingUserInputsFor` + `userInputTimeoutMs` 选项。
5. （可选、待拍板）审计落盘：注册 extension event type `interaction/user-input-request`（与 `interaction/user-input-resolved`），append on request/resolve。
6. 导出：`packages/core/src/index.ts` 加 `export * from './interaction/user-input.js'`（若新建模块）与 `./interaction/user-input-queue.js`。
7. `api-surface-baseline.json` 同步（`H2_UPDATE_API_SNAPSHOT=1`）。

### 2.2 TypeScript 类型草案

```ts
// packages/core/src/interaction/user-input.ts（草案，字段集对齐 ZCode
// userInputRequestPayloadSchema snapshot.ts:281-298；core 只冻结往返原语，
// UI 专有字段 origin/preview 等保持透传/可选，core 不校验其语义）

export type UserInputResponseAckState = 'applied' | 'duplicate' | 'expired' | 'unknown';

export interface UserInputOption {
  optionId: string;
  label: string;
}

export interface UserInputQuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface UserInputQuestion {
  question: string;
  header: string;
  options: UserInputQuestionOption[];
  multiSelect?: boolean;
}

export interface UserInputRequestContract {
  requestId: RequestId;          // 幂等键
  sessionId: SessionId;
  prompt: string;
  freeText: boolean;
  options?: UserInputOption[];  // 简单选项（V4UserInputDialog 路径）
  sensitive?: boolean;
  toolName?: string;
  toolCallId?: string;
  traceId?: string;
  input?: unknown;              // JSON Schema 驱动的表单（ElicitationDialog 路径）
  schema?: unknown;
  questions?: UserInputQuestion[];
  currentQuestionIndex?: number;
  answerDrafts?: Record<string, string[]>;
  /** ISO8601；缺省由 hub 用 userInputTimeoutMs 派生 */
  expiresAt: string;
  createdAt: string;
}

export interface UserInputAnswer {
  optionId?: string;
  freeText?: string;
  action?: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface UserInputResponseAck {
  requestId: string;
  state: UserInputResponseAckState;
}

export type UserInputSettleReason = 'response' | 'timeout' | 'cancelled' | 'expired';

export function isUserInputAnswer(v: unknown): v is UserInputAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.optionId !== undefined && typeof o.optionId !== 'string') return false;
  if (o.freeText !== undefined && typeof o.freeText !== 'string') return false;
  if (o.action !== undefined && o.action !== 'accept' && o.action !== 'decline' && o.action !== 'cancel') return false;
  if (o.content !== undefined && (typeof o.content !== 'object' || o.content === null)) return false;
  return true;
}
```

### 2.3 事件落盘形状

**主路径（实时）走 hook，不依赖落盘**（与 approval 一致：approval 也不落盘，队列是操作状态）。审计可选落盘为 extension event，形状：

```jsonc
// JSONL 一行（session.v1.jsonl，与内建事件同信封 v/seq/ts/type/payload）
{
  "v": 1,
  "seq": 42,
  "ts": "2026-10-21T...Z",
  "type": "interaction/user-input-request",
  "payload": {
    "requestId": "uuid",
    "sessionId": "s1",
    "prompt": "...",
    "freeText": true,
    "options": [{ "optionId": "a", "label": "A" }],
    "expiresAt": "2026-10-21T...Z",
    "createdAt": "2026-10-21T...Z"
  }
}
```

对应 `interaction/user-input-resolved`：

```jsonc
{
  "v": 1, "seq": 43, "ts": "...",
  "type": "interaction/user-input-resolved",
  "payload": {
    "requestId": "uuid",
    "answer": { "optionId": "a" },
    "reason": "response"
  }
}
```

注册方式：进程启动时 `extensionEventTypes.register({ type, validator, projection:'opaque' })`，与 `registerHookInvocationEventType` / `registerWorkflowRunEventType` 同口径（`extension-events.ts:59-81`）；未注册的进程读到该行 → `parseExtensionEventLine` 返回 null → 跳过并告警（与未知扩展类型现状一致，不破坏 seq 空间）。

### 2.4 SessionHubHooks 扩展

`packages/core/src/server/sessions-types.ts` `SessionHubHooks`（:96-123）加（可选，向后兼容）：

```ts
onUserInputRequest?(request: UserInputRequestContract, deliverTo: string[]): void;
onUserInputSettled?(
  requestId: string,
  answer: UserInputAnswer,
  reason: UserInputSettleReason,
): void;
```

多点送达语义与 `onApprovalRequest` :108-110 一致（自身 + 祖先链）。

### 2.5 SessionHub 方法与选项

`SessionHubOptions`（sessions-types.ts:125-172）加：

```ts
userInputTimeoutMs?: number;   // 默认 120_000，与 approvalTimeoutMs :133 同口径
```

`SessionHub`（经 `sessions-approval.ts` 同层）新增，命名对齐既有 `respondApproval` / `listPendingApprovals` / `pendingApprovalsFor`：

```ts
requestUserInput(
  sessionId: string,
  payload: Omit<UserInputRequestContract, 'requestId' | 'sessionId' | 'expiresAt' | 'createdAt'> & { expiresAt?: string },
): Promise<UserInputAnswer>;

respondUserInput(requestId: string, answer: UserInputAnswer): UserInputResponseAck;

listPendingUserInputs(): UserInputRequestContract[];
pendingUserInputsFor(sessionId: string): UserInputRequestContract[];
```

内部实现镜像 `makeApprovalHandler`（sessions-approval.ts:55-127）：生成 `requestId=randomUUID()`、构造 contract、register 到 `UserInputQueue`、启动 deadline timer、多点 emit `onUserInputRequest`、await deferred promise；respond/timeout/cancel settle promise 并 emit `onUserInputSettled`。

### 2.6 UserInputQueue 草案

```ts
// packages/core/src/interaction/user-input-queue.ts
export class UserInputQueue {
  private readonly pendings = new Map<string, { request: UserInputRequestContract; settle: (answer: UserInputAnswer, reason: UserInputSettleReason) => void; timer?: NodeJS.Timeout }>();
  private readonly settledRegistry = new Map<string, 'applied' | 'expired'>();
  // register / respond / settle / settleAll / listPending / listForSession / remember
  // 语义与 ApprovalQueue (approval-queue.ts) 对齐：
  //   live + 未过期 → applied（resolve promise with answer）
  //   live + 已过期 → expired（resolve promise with {action:'cancel'}，fail-closed）
  //   迟到 → duplicate/expired（按 settledRegistry）
  //   未知 → unknown
}
```

### 2.7 与 approval 通道的复用/区分

- **复用**：队列 Map + settledRegistry 去重；deadline timer；多点送达 deliverTo；`on*Request`/`on*Settled` 观察者模式；respond ack 三/四态；`settleAll` 关闭兜底；listPending/listForSession。
- **区分**：
  - approval 是工具权限询问，decision 为 5 态枚举，落定为 boolean，且有 scope/grant/always-rule 缓存；userInput 是显式问询，answer 为开放结构 `{optionId, freeText, action, content}`，落定为 `Promise<UserInputAnswer>`，无授权缓存。
  - approval 由 `decide` 策略缝触发（ask/allow/deny）；userInput 由工具/MCP/外部显式调用 `requestUserInput` 触发，不经过策略缝。
  - 两套独立 hook/方法，避免 approval 语义被 userInput 污染，也避免 UI zod 的 kind/payload.kind 一致性被破坏（`snapshot.ts:329-331` superRefine）。

### 2.8 幂等与 deadline 语义

- **幂等键**：`requestId`。`respondUserInput` 重复调用：首次 applied；后续按 settledRegistry 返回 `duplicate`（若首次 applied）或 `expired`（若首次 timeout/cancel/expired）；从未见过 → `unknown`。与 `ApprovalQueue.respond` :71-96 一致。
- **Producer Promise**：仅首次 applied/timeout/cancel 解析；后续 respond 不重复 resolve（settled 标记保护，镜像 approval-queue.ts :99-108 的 `if (node === undefined) return`）。
- **Deadline**：`expiresAt` ISO8601；`isApprovalExpired` 同口径（`types.ts:199-205`，非法/已过 → 过期，fail-closed）。过期时 queue 自动 settle(reason='expired'/'timeout')，resolve promise 为 `{ action:'cancel' }`，emit `onUserInputSettled`，adapter 清除 pendingInteraction。默认 `userInputTimeoutMs=120_000`。
- **Snooze**：ZCode 有 `snoozeInteractionAutoResolution`（plan T2 已定「先回 noop-accepted，ZS3 不实现倒计时暂停语义，登记」）。本提案 **不** 在 core 实现 snooze；adapter 对 snooze 命令继续回 noop-accepted（与 T2 审批一致）。若编排者要求真 snooze，归 ZS4（需 queue 支持暂停/恢复 timer）。

---

## 3. 备选方案对比

### 3.1 Adapter 侧伪造 core 事件（否决）

- **方案**：adapter 自行合成 `interaction/request` 事件写入/广播，不等 core。
- **否决理由**：违反红线⑩（无假入口）与 Global Constraints ②（core 零改动纪律除批准窗口）；无 durable roundtrip，respond 无法回填 producer，resume 后 pending 丢失；V5 验收「T6 未批不伪造 core 事件」直接失败；且伪造事件无法通过 `parseEventLine`/zod 校验链，破坏 JSONL 消费者信任。

### 3.2 复用 approval 通道硬塞 userInput（否决）

- **方案**：把 userInput 问询伪装成一个 approval request，answer 塞进 `reason`/args。
- **否决理由**：形状冲突——`ApprovalRequestContract`（types.ts:157-169）字段为 `tool/args/scope/expiresAt`，decision 为 5 态 allow/deny；userInput payload 为 `prompt/options/questions/freeText/sensitive/schema`，answer 为开放结构。硬塞会破坏 approval 的 grant/always-rule 语义与 scope 校验，且 UI 侧 `resolveInteraction` 的 answer 与 approval 的 optionId→decision 映射（plan §T2）不一致；zod 的 `pendingInteraction.kind === payload.kind` superRefine（snapshot.ts:329-331）要求独立 kind，无法伪装。

### 3.3 仅扩展事件、无 hook（否决）

- **方案**：只落盘 extension event，adapter 通过轮询/读日志获取。
- **否决理由**：无实时推送，无法满足弹窗即时性与 deadline；与 approval 的实时 hook 模式不一致；resume 仍需 hook 重建 in-flight 状态。

---

## 4. 兼容性与风险

### 4.1 对既有 JSONL 消费者的影响

- approval 请求本就不落盘（`approval-queue.ts:1-2` 注释：队列是操作状态），因此新增的 userInput 问询若仅走 hook，**不改变 JSONL 格式**，旧 reader 零影响。
- 若启用审计落盘（§2.3 可选），新增 type 为 extension event，旧 `parseEventLine`（types.ts:180-198）对未知 type 返回 null → 跳过+告警，seq 空间保持；`parseExtensionEventLine`（extension-events.ts:121-143）未注册时返回 null，不崩溃。无数据迁移。
- `SessionHubHooks` 新字段为可选（`?`），旧装配代码（不传）零回归。

### 4.2 `api-surface-baseline.json` 需同步的条目

新增导出名（若按 §2.1 新建模块并 `export *`）：`UserInputOption`、`UserInputQuestionOption`、`UserInputQuestion`、`UserInputRequestContract`、`UserInputAnswer`、`UserInputResponseAck`、`UserInputResponseAckState`、`UserInputSettleReason`、`UserInputQueue`、`isUserInputAnswer`；若新增 `registerUserInputEventTypes` 函数则再 +1。`SessionHub`/`SessionHubHooks` 已导出，方法/字段不新增导出名。同步命令：`pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`（api-surface.test.ts:9, :240-244），更新 `packages/core/test/fixtures/api-surface-baseline.json`。

### 4.3 回滚方式

全部为加性：删除新模块 + 类型 + hooks 字段 + SessionHub 方法 + 导出行 + 重新同步 baseline（`H2_UPDATE_API_SNAPSHOT=1`）即可；无 schema/数据迁移；已落盘的 extension event 行在回滚后变为未知类型 → 被跳过。Feature gate：不批准则 T6 整体登记 ZS4，adapter 维持 `pendingInteractions: []`（agent-service.ts:71）现状。

---

## 5. 测试计划

### 5.1 core 单测（`packages/core/test/`）

- `user-input-queue.test.ts`（新建）：
  - register + respond → `applied`，promise resolve 为传入 answer；
  - 重复 respond → `duplicate`（首次 applied）/ `expired`（首次 timeout）；
  - timeout（`userInputTimeoutMs`）→ `expired`，promise resolve `{action:'cancel'}`，settledRegistry 记 'expired'；
  - 未知 requestId → `unknown`；
  - `expiresAt` 已过 → register 后立即 expired（fail-closed）；
  - `settleAll('cancelled')` → 全部 pending resolve `{action:'cancel'}`。
- `session-user-input.test.ts`（新建，assembly 风格）：
  - `requestUserInput` 触发 `onUserInputRequest(request, deliverTo)`，deliverTo 含自身+祖先；
  - `respondUserInput` 触发 `onUserInputSettled(requestId, answer, 'response')`；
  - `listPendingUserInputs` / `pendingUserInputsFor` 过滤正确。

### 5.2 adapter service 层帧序列断言（`packages/zcode-adapter/test/`）

- `v4-integration.test.ts` 扩展（或 `agent-service.test.ts`）：
  - 模拟 producer 调用 `hub.requestUserInput`（或 mock queue emit）→ 断言发出 `state.updated` 帧，`patch.pendingInteractions` 含 `{interactionId, kind:'userInput', payload.kind:'userInput', payload.prompt, ...}` 且 `payload.kind === interaction.kind`（zod superRefine）；
  - 发送 `resolveInteraction{interactionId, answer:{optionId}}` → 断言 `pendingInteractions` 清空 + ACK `result.resolvedBy{clientId, optionId}`；
  - 重复 resolve → `noop`（reasonCode `proto.alreadyResolved`）；
  - deadline 到期 → 服务端自动 clear + `state.updated`；
  - 产出帧用 `zcode-protocol-v4` zod schema parse（P2-2 口径，plan Task 0 Step 2）。

---

## 6. 验收清单（编排者）

### 批准意味着

- 授权 T6 第二笔实现：core 窗口 commit（类型 + 队列 + hook + 方法 + 可选审计事件 + 单测 + baseline 同步）与 adapter 笔（投影 + resolveInteraction + 帧序列单测），各独立 commit、`api-surface-baseline.json` 同步。
- core diff 仅 T6 批准窗口（Global Constraints ②），可通过 `git diff --stat main..HEAD -- packages/core` 核对。
- V5「T6 未批不伪造 core 事件」转为「T6 已批，真实实现」。

### 否决意味着

- T6 整体登记 ZS4（映射表 3.5 升级为 ZS4 项，与 plan 风险表「core elicitation 提案被否 → T6 整体入 ZS4」一致）；adapter 不得伪造 core 事件；`pendingInteractions` 维持 `[]`；不阻塞 T1–T5 交付；V5 仍通过（未批不伪造）。

---

## 7. 需编排者拍板的决策点

1. **审计落盘**：userInput 问询是否落盘为 extension event `interaction/user-input-request`（+ resolved），还是仅 hook（approval 不落盘 precedent）？影响 JSONL 体积与 reader 兼容测试。
2. **deadline 默认值与自动应答语义**：`userInputTimeoutMs` 默认 120_000 是否合适？timeout 时 resolve 为 `{action:'cancel'}` 并清 pending，还是仅清 pending 不 resolve producer（影响工具调用挂起）？
3. **producer 范围**：本提案窗口是否包含 built-in `ask_user` 工具（作为 producer），还是仅冻结往返原语、producer 归 ZS4/后续 Task？（推荐：仅原语，producer 归后续，保持最小加性。）

> 待核实：core MCP client（`packages/core/src/mcp/client.ts`）是否已支持 elicitation 回调；若支持，producer 可由 MCP 侧触发，本提案的 `requestUserInput` 原语仍为必要桥。本提案未读该文件，结论按「无」处理。

---

## 8. 编排者拍板（2026-10-21，ZS3 执行期）

**结论：批准，按「仅原语 + 落盘审计」窗口实施。**

1. **审计落盘：批准落盘**。计划 Task 6 明文要求 `interaction/request` 落盘事件；且 resume 后 pending 需可重建。要求：request/resolved 均以 extension event 落盘并注册类型，旧 reader 遇未知类型跳过不崩；`sensitive` 只透传，payload 不额外收集用户正文。
2. **deadline：默认 120_000ms；超时 fail-closed** —— resolve `{action:'cancel'}` + 清 pending + 落 `interaction/user-input-resolved{reason:'timeout'}`。producer 是 await，不 resolve 会挂死工具调用；与 approval 的 fail-closed 同口径。adapter 侧清理后必须发 `state.updated` 让弹窗消失。
3. **producer 范围：仅冻结往返原语**，不含 built-in `ask_user`；producer 归 ZS4/后续。MCP elicitation 若已存在只作为 producer 接入点，不扩大本窗口。
4. **补充约束**：snooze 不在 core 实现，adapter 继续 noop-accepted 并如实注释；core 提交单笔（类型+队列+hook+方法+事件注册+单测+`api-surface-baseline.json` 同步），adapter 笔待 T0–T5 合入后执行，避免同文件冲突。
