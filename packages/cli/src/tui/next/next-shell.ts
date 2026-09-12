// next-shell.ts — W3：next 渲染层接入 chat 命令（HARNESS2_RENDERER=next 开关，默认关闭）。
//
// 职责：与 runInkChat 平行的第二条 chat 装配——复用 setupChatSession（同一 runtime/审批/
// 会话语义，禁止两套装配），渲染与输入改走 next 库：Screen + createInputParser +
// createChatController + renderChat 画帧。开关在 runInkChat.tsx 入口分支
// （process.env.HARNESS2_RENDERER === 'next' → runNextChat），其余路径一行不动。
//
// 装配对照（与 InkShell 的对齐面与取舍，均如实钉死）：
// - 转录流式：复用 useTurnStream 导出的 terminalEvent 纯函数；handler 的 50ms 缓冲逻辑为
//   等价复刻（useTurnStream 是 React hook，不可直接复用），见 createTurnStreamBridge。
//   差异：Ink 的 live 快照渲染在转录底部、不产生转录项；next 的 Scrollback 无原地更新能力，
//   live 文本以 `assistant/step`（turnId+stepIndex 稳定 id，reducer put 原地替换）承载，
//   每次替换触发全量重投影（取舍：换增量追加的简单性；长会话下 50ms 全量重投影是已知开销）。
// - 投影增量：记住上次投影的 item 引用数组与行数；item 前缀引用全等（reducer 不改旧 item，
//   替换必产生新引用）→ 只 appendLines 新增行；否则（tool/result 原地合并、live step 替换、
//   折叠变化）全量重投影重建 Scrollback（follow/scrollTop 尽力保留，注明取舍）。
// - 提交路径：对齐 InkShell——Enter → submit(text)；忙时 FIFO 入队、收尾 drain（选对齐面
//   最小者：完整复刻队列语义，但队列取消面板 Ctrl+X 未接，见文件尾「next 模式暂缺项」）。
// - 审批：askApproval → ApprovalGate → Approval overlay（标题 'Approval' + y/a/n 项，
//   ↑↓ / 数字 1-3 / Enter 选择，Esc / Ctrl+C 取消）。choice 映射与 Ink 版一致（allow→y、
//   allow-always→a、deny→n；gate 直接产出 y/a/n，由 setupChatSession 归一）。
//   未复用 runInkChat 的 createDialogController：其 DialogRequest.render 是 React 节点，
//   与 next 渲染不兼容，且会引入 ink/react 依赖与模块环；gate 为其非 React 等价复刻。
// - Ctrl+C：createCtrlCGuard（忙时取消 / 空闲 2s 窗口双击退出，退出码 130）——对齐 Composer。
//   Ctrl+D：按 2026-09-12 keymap 裁决 = 半页下滚（chat-controller 内置消费），**不退出**——
//   退出只走 Ctrl+C 双击与 /exit（Ink Composer 的空草稿 Ctrl+D 退出语义不带入 next 层）。
// - 退出：createShutdown + bindShutdownSignals（SIGTERM/SIGHUP 同一幂等路径）；raw mode 由
//   本层管理（screen.start 后 setRawMode(true)，退出还原）；SIGINT 不绑定（Ctrl+C 走键盘
//   协议，raw mode 下内核不投递 SIGINT，与 Ink 行为一致）。另有 process 'exit' 兜底还原
//   （bindEmergencyExitRestore：exit 回调内只能同步写，见函数注释）。
// - notifier / steer 观察 / resize（screen.resize + resizeChat + 强制全量重投影）/ DECSET
//   1004 焦点上报（parser 产出 focus 事件 → focused 标记，notifier 策略自然生效）均已接。
//
// next 模式暂缺项（对齐 Ink 的差距，诚实登记、不伪造）：
//   1. 斜杠命令已全集接齐（P3-C）：ink 版有的命令在本层均有等价行为——共享命令（/undo /redo
//      /new /resume /fork /exit /quit /sessions）委托 ink-commands.runSharedCommand（真实
//      CommandContext + 磁盘重投影）；/help /? /mode /context /compact /reasoning /tasks
//      本地实现（与 ink 同文案）；/plan /auto /always-approve 为 next 层 UI 模式命令。
//      登记差异：/sessions 无参为转录文本列表（ink 为选择浮层，浮层化暂缺）；/mode 无参 =
//      UI 模式循环一次（等价 Shift+Tab）、带参接受四态名（ink 为 core 审批模式别名 + 选择
//      浮层，core 契约冻结不改）；未知命令走共享「未知命令」文案（不再有本层「暂不支持」分支）。
//   2. 队列面板（Ctrl+X 取消排队条目）与 RetryPanel（重试预算展示）未接。
//   3. 工具卡 output 的磁盘补齐（enrichSubagentResults）未接：live 流 tool/result 不带 output，
//      工具结果行只有状态无输出摘要；live 工具卡也不显示 childSessionId 入口（StreamEvent 契约
//      所限）——子会话候选改由 onChildEvent 登记补齐（见 P3-D），磁盘重投影后转录 item 自带。
//   4. 工具卡/推理块仍为纯文本行近似（无边框/反色）；逐行前景色已落地（P3-A：
//      projection fg → Scrollback 行对象 fg → drawScrollback 逐行绘制，单 fg 兜底保留）。
//   5. 软折行视觉行内 ↑↓ 移动（Infinity 宽度逻辑行移动）未接；候选补全已接（P3-C，见下）。
//
// P3-D 子代理块（耗时/动画）+ 全屏子视图（2026-09-12，对齐 grok 16-subagents）：
//   - 耗时：subagent tool/call → tool/result 的 turn 事件流间隔（UI 层近似计时——含审批
//     等待/调度延迟，非 core runTurn durationMs，如实登记）；投影文案 `完成（43s）`（对齐
//     grok "Subagent completed in 43s"）；<1s 视为即时完成不显示（0s 噪音）；无记录不伪造。
//   - 运行动画：busy 且存在运行中子代理块（subagentStarts 非空）时 150ms setInterval 循环
//     invalidation（braille spinner SPINNER_FRAMES，next-shell 持有帧序并传入投影，只替换
//     运行中子代理行前缀）；空闲/无运行中块停表；spinner tick 走 reprojectAll 全量重建
//     （items 引用不变时 syncProjection 会早退）。
//   - 全屏子视图：滚动区焦点 `v` 打开（键位裁决与差异登记见 keymap 文档冲突项 6；grok 为
//     选中块 Enter/Ctrl+F）。0 个子会话 = 瞬时提示；1 个 = 直开；多个 = overlay 列表选择
//     （↑↓/j/k/数字/Enter，Esc/q 取消）。视图 = 独立 Scrollback（projectSession 磁盘重放
//     ∪ onChildEvent 事件，seq id 幂等合并）+ composer 层降为 1 行「q/Esc 返回」提示行
//     （chat-screen.subagentView 态：草稿/候选/指示不画）；运行中的子会话经 SubagentHooks
//     .onChildEvent 实时追加进该视图（setupChatSession 装配层传参 → runNextChat sink 延迟
//     转发 → harness；core 零改动）。视图内 ↑↓ 单行 / PgUp/PgDn 翻页 / 滚轮 ±3。
//
// P3-C 斜杠命令全集 + 模糊补全（2026-09-12，对齐 grok `/` 内联下拉 + ink matchCommands）：
//   - 候选触发：draft 以 '/' 开头且不含空格/换行（= ink Composer 的 commandNameActive 语义）；
//     逐字过滤实时重算（syncCandidates 在 invalidate 内，draft 变化必经 feed → invalidate）。
//   - 过滤排序 filterCommands：前缀命中 > 子序列命中（isSubsequence），各自按字典序（ink 的
//     matchCommands 是纯前缀，本层为其模糊超集；空输入 = 全部命令字典序）。
//   - Tab / Enter 接受候选：草稿写回 `/cmd `（**含尾随空格**，即退出候选态；再按 Enter 才
//     发送）。差异登记：grok 选中即执行、ink Enter 提交原草稿；本层采用任务规格的两段式
//     （接受 → 可继续补参数 → 再 Enter 发送）。
//   - 悬停/滚轮改选（grok panes.rs:958）：候选画在 composer 层顶部，命中测试
//     composer.candidateItemAt（相对候选区顶行 → item 下标，含滚动窗口映射）；next 层在
//     dispatcher 装 candidateMouseLayer（approval 与 composer 之间）：move 命中候选行改
//     activeIndex、滚轮在候选行上 ±1 循环（候选区外滚轮照常滚转录）。真机悬停需 all-motion
//     鼠标上报，本层补写 DECSET 1003（MOUSE_ALL_MOTION_ON，与 renderer MOUSE_ON 的
//     1000;1002;1006 叠加；退出对称关闭）。
//   - /undo /redo /new /resume /fork /sessions /exit 的重投影语义复用 runSharedCommand：
//     rewind/会话切换后以 projectSession(dir) 整体重建转录（reprojectFromDisk；磁盘读取失败
//     保底重投影内存转录，不伪造），并清空折叠覆盖集（对齐 ink 重投影清 expandedIds）。
//
// P3-A 键位（2026-09-12 keymap-parity 裁决落地，next 层）：
//   - Tab = 输入框/滚动区双态焦点（候选可见时 Tab 仍是接受候选，dispatcher 候选优先）；
//     滚动区焦点下 h/l/e/E 生效（块折叠键族），其余字母键自动回到输入框照常插入
//     （grok simple 模式语义）；指示器显示 'scrollback'。
//   - e = 展开全部块 / E = 折叠全部块（collapsed 覆盖集全量重置：e = 收录全部可折叠
//     item 下标，E = 清空集）；h/l = 折叠/展开最近一次工具/推理 item（next 无块光标，
//     取最近可折叠 item，对齐旧 Ctrl+O 定位策略；grok 是选中块导航，差异登记 keymap 文档）。
//   - Ctrl+O = always-approve 切换（grok YOLO）：UI 开关自动代答 'a'——新审批 ask 时经
//     gate.choose('a') 走 gate 的 resolve 路径，**不绕过 core 审批队列**（红线 6）；开关
//     开启瞬间已挂起的审批不自动代答（当次仍手动回答）；底边指示器显示 'always-approve'。
//     旧 Ctrl+O 折叠语义由 e/E/h/l 接管。
//
// P3-B 键位（2026-09-12 keymap-parity 裁决落地，next 层）：
//   - 审批 blocking card 键位对齐 grok permission prompt：Tab/Shift+Tab 在选项间循环走行
//     （↑↓ 保留）；1-3 数字直选；Enter 确认高亮项；Ctrl+F 展开/收起审批 query 全文（按
//     显示宽度折行进 items，差异：chat-setup 的审批 query 只携带工具名文案、不含工具参数
//     ——askApproval 契约冻结不可改，grok 是「展开完整参数」，此处展开的是全文案，参数级
//     展开待 gate 契约扩展，差异已登记 keymap 文档）；Ctrl+C 取消（ASK_CANCELLED）；Ctrl+O
//     always-approve（保留）。
//   - Esc = 寄放焦点（grok permission prompt 语义）：关闭键盘接管但**不回答不关闭卡片**——
//     overlay 保留显示、审批仍挂起（gate.pending() 非 null），controller.focus() 键盘回
//     composer（照常编辑/提交）；寄放态 Tab 显式回卡重新接管；新 gate.ask / settle 均复位
//     寄放态。寄放态下 Ctrl+C 走 composer 路径 → interrupt() → gate.cancel()（grok 同义）。
//   - Shift+Tab = 模式循环 Normal→Plan→Auto→Always-approve→Normal（composer 焦点下生效；
//     审批卡接管时 dispatcher 卡片层优先消费 Shift+Tab = 反向走行，层级天然区分；寄放态
//     键盘在 composer，Shift+Tab 循环模式、Tab 回卡）。
//   - 模式四态落地语义（红线 6：审批不得弱化，mode 不自动回答审批）：
//     normal = 现状；plan / auto = **UI 声明态**——core 无 plan/auto 模式契约且冻结，仅底边
//     指示 + 提交时转录打 [plan mode]/[auto mode] 灰色 system 提示行，**不改变任何审批/执行
//     行为**（诚实实现，不伪造 core 能力；grok 的 auto=自动审批与红线 6 冲突，故不做「gate
//     默认高亮 allow 项」，避免诱导一键放行）；always-approve = 与 Ctrl+O 共享同一状态
//     （单态变量：开启时**新**审批经 gate.choose('a') 走 resolve 路径代答，红线 6 不绕过
//     core 审批队列；挂起当次不代答；关闭回 normal）。
//   - 斜杠命令 /plan /auto /always-approve 直接设置对应模式（/always-approve 为 toggle，
//     grok 语义；/plan /auto 幂等设置）。
//   - 底边指示顺序：模式（normal 省略）· scrollback 焦点 · 寄放提示 · 瞬时 hint。
import type { ChatOptions } from '../../legacy-chat.js';
import {
  ASK_CANCELLED,
  setupChatSession,
  type ChatRuntime,
  type StreamEvent,
  type TurnResult,
  type TurnStreamHandler,
} from '../../chat-setup.js';
import { HELP_TEXT, parseCommand } from '../../commands.js';
import { getContextUsage, type AnySessionEvent } from '@harness2/core';
import { runSharedCommand, type InkCommandIo } from '../ink-commands.js';
import { expandContextRefs, hasContextRefs } from '../../context-ref.js';
import { createInputParser, type InputParser } from '../../input/parser.js';
import { createInputDispatcher, type InputDispatcher, type InputLayer } from '../../input/dispatcher.js';
import type { InputEvent } from '../../input/types.js';
import { summarizeArgs, turnSummaryLine } from '../../render.js';
import { describeSteerResult } from '../../steer.js';
import { createUiScheduler, type UiScheduler } from '../scheduler.js';
import {
  bindShutdownSignals,
  createCtrlCGuard,
  createShutdown,
  type ExitReason,
  type ShutdownController,
} from '../shutdown.js';
import { createNotifier, stderrSink, type Notifier } from '../notify.js';
import {
  emptyTranscript,
  isSubagentTool,
  projectSession,
  sessionEventToTranscript,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptState,
} from '../transcript.js';
import type { WriteTarget } from '../renderer/diff-presenter.js';
import { ALT_SCREEN_EXIT, MOUSE_OFF, SHOW_CURSOR } from '../renderer/ansi.js';
import { Screen } from '../renderer/screen.js';
import { renderChat, resizeChat, layoutChat, type ChatScreenState } from './chat-screen.js';
import { projectTranscript, subagentDescription, type ProjectionLine } from './projection.js';
import { Scrollback } from './scrollback.js';
import { wrapTextByWidth, type OverlaySpec } from './overlay.js';
import { candidateItemAt } from './composer.js';
import {
  attachInput,
  createChatController,
  createComposerLayer,
  type AttachedInput,
  type ChatController,
} from './chat-controller.js';
import { terminalEvent } from '../useTurnStream.js';

/** next 渲染开关（runInkChat 入口分支用；默认关闭 → legacy ink 不变） */
export function shouldUseNextRenderer(env: Record<string, string | undefined>): boolean {
  return env.HARNESS2_RENDERER === 'next';
}

// —— 常量（对齐既有装配的口径）——
const CTRL_C_WINDOW_MS = 2000; // Composer.CTRL_C_WINDOW_MS
const LIVE_FLUSH_MS = 50; // useTurnStream.FLUSH_MS
const IDLE_FLUSH_MS = 50; // chat-controller 文件头建议的空闲冲刷周期
const HINT_CLEAR_MS = 2000; // Composer 瞬时提示展示时长
const BRACKETED_PASTE_ON = '\x1b[?2004h'; // ansi.ts 无此常量（既有文件只读），本层自定义
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const FOCUS_REPORT_ON = '\x1b[?1004h'; // DECSET 1004 焦点上报（ansi.ts 无现成常量，同上自定义）
const FOCUS_REPORT_OFF = '\x1b[?1004l';
// DECSET 1003 全 motion 鼠标上报（真机悬停改选必需；renderer 的 MOUSE_ON 只有 1000;1002;1006
// = 按钮/拖动 motion。本层补写开启、退出对称关闭；headless 测试直接喂 SGR 序列不受影响）
const MOUSE_ALL_MOTION_ON = '\x1b[?1003h';
const MOUSE_ALL_MOTION_OFF = '\x1b[?1003l';

const SHORTCUTS: readonly string[] = ['Enter 发送', 'Shift+Enter 换行', 'Esc 停止', 'Ctrl+C 退出', 'PgUp/PgDn 滚动'];

// —— P3-D 子代理块（耗时/动画）与全屏子视图 ——
/** spinner 帧序（braille 圆点，grok 运行中块动画同类字符族） */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** spinner 推进周期（ms） */
export const SPINNER_INTERVAL_MS = 150;
/**
 * P3-D 键位裁决（差异登记 keymap 文档）：滚动区焦点下 `v` 打开子代理全屏视图（多子代理 =
 * 列表选择）。grok 是「选中块 + Enter/Ctrl+F」——本层无块光标，且 Enter 在滚动区焦点保留
 * 提交语义（肌肉记忆不迁移），故取独立字母键 v（view）。
 */
export const SUBAGENT_VIEW_KEY = 'v';
/** 视图态 composer 层提示行 */
const SUBVIEW_HINT = 'q/Esc 返回 · ↑↓/PgUp/PgDn/滚轮 滚动';

const APPROVAL_ITEMS: readonly string[] = ['y 允许（本次）', 'a 总是允许（本会话）', 'n 拒绝'];
const APPROVAL_ANSWERS: readonly string[] = ['y', 'a', 'n'];

/**
 * 模式四态（P3-B，grok Shift+Tab 循环序）：plan / auto 为 UI 声明态（core 无契约且冻结，
 * 不改变审批/执行行为，红线 6）；always-approve 与 Ctrl+O 共享同一状态。
 */
export type UiMode = 'normal' | 'plan' | 'auto' | 'always-approve';
const MODE_CYCLE: readonly UiMode[] = ['normal', 'plan', 'auto', 'always-approve'];

/** plan 态提交消息时打进转录的声明提示（灰色 system 行） */
const PLAN_MODE_NOTICE = '[plan mode] 下一条消息建议以规划为主：先探索并给出实现计划（UI 声明态：不改变审批/执行行为）';

// —— P3-C 命令注册表（next 层命令全集；wiring = 行为来源，note = 与 ink 的差异登记）——

/** 命令接线方式：local = 本层实现（与 ink 同文案/语义）；shared = 委托 ink-commands.runSharedCommand */
export type NextCommandWiring = 'local' | 'shared';

export interface NextCommandEntry {
  /** 命令名（不含 '/'） */
  name: string;
  wiring: NextCommandWiring;
  /** 与 ink 的差异登记（缺省 = 无差异） */
  note?: string;
}

/**
 * next 层斜杠命令注册表（P3-C 全集）。共享命令（/new /sessions /resume /fork /undo /redo
 * /exit /quit 别名）委托 ink-commands.runSharedCommand（真实 CommandContext + 磁盘重投影）；
 * 本地命令与 ink runInkChat.handleCommand 同文案。quit / ? 为共享实现的别名（不在候选表，
 * 与 ink matchCommands 的候选口径一致——候选只含 COMMAND_REGISTRY 名 + next 扩展）。
 */
export const NEXT_COMMANDS: readonly NextCommandEntry[] = [
  { name: 'new', wiring: 'shared' },
  { name: 'sessions', wiring: 'shared', note: '无参 = 转录文本列表（ink 为选择浮层；浮层化登记暂缺）' },
  { name: 'resume', wiring: 'shared' },
  { name: 'fork', wiring: 'shared' },
  { name: 'undo', wiring: 'shared' },
  { name: 'redo', wiring: 'shared' },
  { name: 'help', wiring: 'local' },
  { name: 'exit', wiring: 'shared' },
  {
    name: 'mode',
    wiring: 'local',
    note: '无参 = UI 四态循环一次（等价 Shift+Tab）；带参接受四态名直接设置（ink 为 core 审批模式别名 + 选择浮层，core 契约冻结不改）',
  },
  { name: 'context', wiring: 'local' },
  { name: 'compact', wiring: 'local', note: '自动压缩提示（与 ink 同文案，不静默）' },
  { name: 'reasoning', wiring: 'local' },
  { name: 'tasks', wiring: 'local', note: '只读提示（与 ink 同文案）：请用 harness2 cron list' },
  { name: 'plan', wiring: 'local', note: 'next 层 UI 声明态（ink 无此命令）' },
  { name: 'auto', wiring: 'local', note: 'next 层 UI 声明态（ink 无此命令）' },
  { name: 'always-approve', wiring: 'local', note: 'next 层 always-approve 开关（ink 无此命令）' },
];

/** pattern 是否为 target 的子序列（空 pattern 恒真） */
function isSubsequence(pattern: string, target: string): boolean {
  if (pattern.length === 0) return true;
  let i = 0;
  for (const ch of target) {
    if (ch === pattern[i]) i += 1;
    if (i >= pattern.length) return true;
  }
  return false;
}

/**
 * 模糊过滤候选（P3-C）：输入草稿（'/...'）→ 候选列表（带 '/' 前缀）。
 * 前缀命中 > 子序列命中（isSubsequence），各自按字典序；空输入 = 全部命令字典序。
 * ink 的 matchCommands 是纯前缀过滤，本层为其模糊超集（候选口径同源：注册表名 + next 扩展）。
 */
export function filterCommands(input: string): string[] {
  const prefix = input.replace(/^\/+/, '').toLowerCase();
  const names = NEXT_COMMANDS.map((c) => c.name).sort();
  if (prefix.length === 0) return names.map((n) => `/${n}`);
  const prefixHits = names.filter((n) => n.startsWith(prefix));
  const subHits = names.filter((n) => !n.startsWith(prefix) && isSubsequence(prefix, n));
  return [...prefixHits, ...subHits].map((n) => `/${n}`);
}

// —— 审批 gate（createDialogController 的非 React 等价，见文件头取舍说明）——

export interface ApprovalGate {
  /** 审批提问：resolve 值为 'y' | 'a' | 'n' | ASK_CANCELLED（与 setupChatSession 契约一致） */
  ask(query: string): Promise<string>;
  /** 用户选择（数字/Enter 路径）；未挂起时 no-op */
  choose(answer: 'y' | 'a' | 'n'): void;
  /** 取消（Esc / Ctrl-C / 新提问挤占）；未挂起时 no-op */
  cancel(): void;
  /** 当前挂起的提问（null = 无） */
  pending(): string | null;
}

export interface ApprovalGateBindings {
  /** ask() 挂起时回调（装配层据此打开 overlay） */
  onOpen(query: string): void;
  /** ask() 结算（选择/取消/挤占）后回调（装配层据此关闭 overlay） */
  onSettled(): void;
}

/** 创建审批 gate；bind 由装配层在创建 harness 时调用（ask 可先于 bind 发生，事件不回放） */
export function createApprovalGate(): ApprovalGate & { bind(bindings: ApprovalGateBindings): void } {
  let bindings: ApprovalGateBindings | null = null;
  let current: { query: string; resolve: (answer: string) => void } | null = null;

  function settle(answer: string): void {
    const c = current;
    if (c === null) return;
    current = null;
    bindings?.onSettled();
    c.resolve(answer);
  }

  return {
    ask(query) {
      if (current !== null) settle(ASK_CANCELLED); // 新提问挤占旧挂起（对齐 dialog.open 的 pending.resolve）
      return new Promise<string>((resolve) => {
        current = { query, resolve };
        bindings?.onOpen(query);
      });
    },
    choose(answer) {
      settle(answer);
    },
    cancel() {
      settle(ASK_CANCELLED);
    },
    pending: () => (current !== null ? current.query : null),
    bind(b) {
      bindings = b;
    },
  };
}

// —— turn 流桥（useTurnStream 的非 React 等价复刻；terminalEvent 纯函数直接复用）——

interface TurnStreamBridge {
  handler: TurnStreamHandler;
  /** turn 结束：清 timer 并产出终态事件（final/partial/empty；与 useTurnStream.finalize 同语义） */
  finalize(result: TurnResult | undefined): TranscriptEvent | null;
  reset(): void;
  dispose(): void;
}

/**
 * 差异说明（与 useTurnStream 对照）：Ink 的 live 快照只驱动 React 重渲、不产生转录项；
 * next 的 Scrollback 无法原地更新，live 文本以 assistant/step（turnId+stepIndex 稳定 id）
 * 承载——50ms flush 用当前 stepIndex 原地替换（reducer put 幂等），工具边界 flushStep
 * 递增 stepIndex 另起新段。终态 turn-final 与末段 step 文本重复时由装配层去重跳过
 * （否则 assistant:<turnId> 与 step:N 会显示两份相同正文）。
 */
function createTurnStreamBridge(onEvent: (event: TranscriptEvent) => void): TurnStreamBridge {
  let buffer: { turnId: string | undefined; text: string; reasoning: string } = {
    turnId: undefined,
    text: '',
    reasoning: '',
  };
  let stepIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 50ms live flush：把当前累积作为 step 项原地替换（有正文/推理才发，避免空气泡） */
  function flushLive(): void {
    timer = null;
    emitStep();
  }

  function emitStep(): boolean {
    const hasText = buffer.text.trim().length > 0;
    const hasReasoning = buffer.reasoning.trim().length > 0;
    if (!hasText && !hasReasoning) return false;
    onEvent({
      type: 'assistant/step',
      ...(buffer.turnId !== undefined ? { turnId: buffer.turnId } : {}),
      stepIndex,
      text: hasText ? buffer.text : '',
      ...(hasReasoning ? { reasoning: buffer.reasoning } : {}),
    });
    return true;
  }

  /** 工具边界 flushStep（对齐 useTurnStream：发了才递增 stepIndex 并清空缓冲） */
  function flushStep(): void {
    clearTimer();
    if (emitStep()) {
      stepIndex += 1;
      buffer = { turnId: buffer.turnId, text: '', reasoning: '' };
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(flushLive, LIVE_FLUSH_MS);
  }

  const handler: TurnStreamHandler = (event: StreamEvent) => {
    if (event.type === 'text-delta') {
      buffer.turnId = event.turnId;
      buffer.text += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'reasoning-delta') {
      buffer.turnId = event.turnId;
      buffer.reasoning += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'tool-call') {
      buffer.turnId = event.turnId;
      flushStep(); // 顺序保真：先落本 step 正文，再落工具项（后续文本另起一段）
      onEvent({
        type: 'tool/call',
        seq: 0,
        callId: event.call.id,
        tool: event.call.name,
        args: event.call.arguments,
        summary: summarizeArgs(event.call.arguments),
        turnId: event.turnId,
      });
      return;
    }
    // tool-result
    buffer.turnId = event.turnId;
    onEvent({
      type: 'tool/result',
      callId: event.callId,
      ok: event.ok,
      ...(event.error !== undefined ? { error: event.error } : {}),
      turnId: event.turnId,
    });
  };

  return {
    handler,
    finalize(result) {
      clearTimer();
      return terminalEvent(result, {
        turnId: buffer.turnId,
        text: buffer.text,
        reasoning: buffer.reasoning,
      });
    },
    reset() {
      clearTimer();
      stepIndex = 0;
      buffer = { turnId: undefined, text: '', reasoning: '' };
    },
    dispose() {
      clearTimer();
    },
  };
}

// —— 装配层依赖（测试注入缝；runNextChat 传真终端）——

/**
 * P3-D：子会话事件缝（SubagentHooks.onChildEvent 的接收端）。runNextChat 用一个可变 sink
 * 桥接 setupChatSession（装配期先于 harness 创建，故经 set 延迟注册 handler）。
 */
export interface SubagentEventSink {
  set(handler: (sessionId: string, event: AnySessionEvent) => void): void;
}

export interface NextChatHarnessDeps {
  /** 渲染输出（Screen 的 WriteTarget；columns/rows 提供初始尺寸） */
  out: WriteTarget & { columns?: number; rows?: number };
  /** 装配期启动行（setupChatSession 的 line 钩子收集） */
  bootLines?: readonly string[];
  /** 环境变量（notifier 策略等；缺省 {} —— 测试确定性） */
  env?: Record<string, string | undefined>;
  /** 提醒 sink（缺省 stderrSink） */
  notifyWrite?: (s: string) => void;
  /** 审批 gate（runNextChat 先创建再传给 setupChatSession.askApproval） */
  gate: ApprovalGate & { bind?: (b: ApprovalGateBindings) => void };
  /** shutdown.finish 内的终端还原（runNextChat：拆屏/还原 raw mode/runtime.finish） */
  cleanup?: () => void | Promise<void>;
  /** 退出码出口（缺省 no-op；测试捕获，runNextChat 写 process.exitCode） */
  exit?: (code: number) => void;
  /** 外部已 start 的 Screen（runNextChat 自管启动序列时传入；缺省内部创建并 start） */
  screen?: Screen;
  /** P3-D：子会话事件缝（缺省不接——无实时追加，视图只走磁盘重放/内存累积降级） */
  subagentEventSink?: SubagentEventSink;
}

export interface NextChatHarness {
  /** Chat 整帧状态（滚动区/草稿/浮层/状态行——测试断言面） */
  readonly state: ChatScreenState;
  /** 喂原始输入字节（parser→dispatcher→controller 全链；有事件则渲染） */
  feed(bytes: Uint8Array | string): number;
  /** 空闲冲刷（孤立 ESC / 断流 paste 兜底）；真实路径由 50ms 定时器驱动 */
  flushIdle(now?: number): number;
  /** 立即排空 UI 调度器并渲染（测试确定性缝） */
  flushUi(): void;
  /** 终端尺寸变化（screen.resize + scrollback cols 契约同步） */
  resize(cols: number, rows: number): void;
  /** 提交入口（对齐 InkShell.submit：忙时入队、空闲执行；命令/turn 同一入口） */
  submit(text: string): void;
  /** Ctrl+C 语义入口（guard 协议；测试可直调，键盘路径经 controller.onInterrupt） */
  interrupt(): void;
  /** 退出请求（忙时先 abort、收尾后收敛；对齐 InkShell commandIo.requestExit） */
  requestExit(reason?: ExitReason): void;
  /** 审批选择/取消（编程入口；键盘路径经 approval 层） */
  approve(answer: 'y' | 'a' | 'n'): void;
  cancelApproval(): void;
  pendingApproval(): string | null;
  /** scrollback 逻辑行快照（测试断言用；wrap 段拼回 = 原逻辑行） */
  logicalLines(): string[];
  /** P3-D：子视图逻辑行快照（null = 视图未打开） */
  subagentViewLines(): string[] | null;
  isBusy(): boolean;
  queueSnapshot(): readonly string[];
  awaitDone(): Promise<number>;
  /** 仅清理 timers（不触发退出；测试 afterEach 用） */
  dispose(): void;
}

export function createNextChatHarness(runtime: ChatRuntime, deps: NextChatHarnessDeps): NextChatHarness {
  const env = deps.env ?? {};
  const screen =
    deps.screen ??
    (() => {
      const s = new Screen(deps.out, Math.max(1, deps.out.columns ?? 80), Math.max(1, deps.out.rows ?? 24));
      s.start({ mouse: env.HARNESS2_MOUSE !== '0' });
      return s;
    })();

  // DECSET 1004 焦点上报（审查 P2）：与 screen.start 同一写出目标补写开启序列（幂等，
  // 重复写无害）；关闭序列在 runNextChat 的 cleanup 随 screen.stop 一并写出。开启后
  // parser 产出 focus 事件 → dispatcher 兜底更新 focused → notifier 策略自然生效。
  deps.out.write(FOCUS_REPORT_ON);
  // DECSET 1003 全 motion 鼠标上报（P3-C 悬停改选；与 screen.start 的 MOUSE_ON 叠加，幂等）
  deps.out.write(MOUSE_ALL_MOTION_ON);

  // —— 状态 ——
  let transcript = emptyTranscript();
  const bootLines = deps.bootLines ?? [];
  bootLines.forEach((text, i) => {
    transcript = transcriptReducer(transcript, { type: 'system', id: `boot:${i}`, text });
  });
  const state: ChatScreenState = {
    scrollback: new Scrollback([], Math.max(1, screen.cols - 1)),
    draft: '',
    cursor: 0,
    candidates: null,
    overlays: [],
    shortcuts: SHORTCUTS,
    statusline: '',
    indicators: [],
  };

  let busy = false;
  let exitRequested = false;
  let pendingExitReason: ExitReason = 'exit';
  let userSeq = 0;
  let sysSeq = 0;
  let steerSeq = 0;
  let hint: string | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let focused = true; // DECSET 1004 焦点（缺省聚焦；unfocused 策略下不响，保守处理）
  const queue: string[] = [];
  let collapsed = new Set<number>(); // 折叠覆盖标记集（itemIndex 取反默认折叠态）
  // 模式四态（P3-B，见文件头语义说明）：plan/auto 为声明态不改行为；always-approve 与
  // Ctrl+O 共享此单态变量（开启时新审批经 gate.choose('a') 代答，红线 6）。
  let uiMode: UiMode = 'normal';
  let scrollbackFocus = false; // Tab 双态焦点：false = 输入框（默认），true = 滚动区（折叠键族生效）

  // —— P3-D 子代理块（耗时/动画）与全屏子视图状态 ——
  // 耗时为 UI 层近似计时：subagent tool/call → tool/result 的 turn 事件流间隔（含审批等待/
  // 调度延迟，非 core runTurn durationMs），如实登记差异；<1s 视为即时完成不显示（0s 噪音）。
  const subagentStarts = new Map<string, number>(); // callId → Date.now()（运行中）
  const subagentDurations = new Map<string, number>(); // callId → 秒（完成/失败后保留，重投影用）
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  // 子会话登记（onChildEvent 桥；childId → 描述 = 子会话首条 user/message 文本）。
  // live 流的 tool/result 不带 output（StreamEvent 契约），childSessionId 不能从父转录解析——
  // 视图候选以本登记 + 转录 item（磁盘重投影后）并集为准。
  const childSessions = new Map<string, string | undefined>();
  const childEvents = new Map<string, AnySessionEvent[]>(); // onChildEvent 原始事件（打开视图时与磁盘合并）
  const childTranscripts = new Map<string, TranscriptState>(); // 增量累积（视图实时追加用）
  let subView: { childId: string } | null = null; // 非 null = 全屏子视图
  let subPicker: { items: string[]; targets: string[]; activeIndex: number } | null = null; // 多子代理选择

  const contentCols = (): number => Math.max(1, screen.cols - 1);

  // —— 投影同步（增量追加 / 全量重建，见文件头取舍） ——
  let syncedItems: readonly TranscriptItem[] = [];
  let syncedLineCount = 0;

  function projectLines(): ProjectionLine[] {
    return projectTranscript(transcript.items, {
      cols: contentCols(),
      collapsed,
      // P3-D：耗时命中才随行显示；spinner 仅在动画定时器活动时传当前帧
      ...(subagentDurations.size > 0 ? { durations: subagentDurations } : {}),
      ...(spinnerTimer !== null ? { spinner: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] } : {}),
    });
  }

  function rebuildScrollback(lines: readonly ProjectionLine[]): void {
    const old = state.scrollback;
    // 行对象直传（text + fg）：projection 的逐行配色随行进入 scrollback（P3-A 配色落地）
    const sb = new Scrollback(lines, contentCols());
    if (!old.follow) {
      // anchor 模式尽力保留视口：绝对 scrollTop 平移（新 maxScroll 钳制；取舍：重建即丢
      // wrap 缓存，anchor 语义以物理行数近似保持）
      sb.goToTop();
      if (old.scrollTopRow > 0) sb.scrollBy(old.scrollTopRow);
    }
    state.scrollback = sb;
  }

  function syncProjection(): void {
    const lines = projectLines();
    const items = transcript.items;
    let appendable = items.length >= syncedItems.length;
    if (appendable) {
      for (let i = 0; i < syncedItems.length; i += 1) {
        if (items[i] !== syncedItems[i]) {
          appendable = false;
          break;
        }
      }
    }
    if (appendable && items.length === syncedItems.length && lines.length === syncedLineCount) return; // 无变化
    if (appendable) {
      const added = lines.slice(syncedLineCount);
      if (added.length > 0) state.scrollback.appendLines(added); // ProjectionLine 直传（text + fg）
    } else {
      rebuildScrollback(lines);
    }
    syncedItems = [...items];
    syncedLineCount = lines.length;
  }

  /** 折叠/强制全量重投影（折叠变化时整体重建，见任务规格取舍） */
  function reprojectAll(): void {
    const lines = projectLines();
    rebuildScrollback(lines);
    syncedItems = [...transcript.items];
    syncedLineCount = lines.length;
    invalidate();
  }

  // —— P3-D 运行动画：busy 且存在运行中子代理块时 150ms 循环 invalidation ——
  // spinner 改变的只是运行中子代理行的前缀字符（items 引用不变，syncProjection 的
  // 「无变化」早退会跳过）→ tick 走 reprojectAll 全量重建（150ms 周期，帧开销可忽略）。
  function updateSpinner(): void {
    const shouldRun = busy && subagentStarts.size > 0;
    if (shouldRun && spinnerTimer === null) {
      spinnerFrame = 0;
      spinnerTimer = setInterval(() => {
        spinnerFrame += 1;
        reprojectAll();
      }, SPINNER_INTERVAL_MS);
    } else if (!shouldRun && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // —— P3-D 全屏子视图（滚动区焦点 v 打开；q/Esc 返回；键位差异登记 keymap 文档）——

  /** 子会话候选：转录 item（有 childSessionId，磁盘重投影后才有）∪ onChildEvent 登记，保序去重 */
  function subagentCandidates(): Array<{ childId: string; desc: string }> {
    const out: Array<{ childId: string; desc: string }> = [];
    const seen = new Set<string>();
    for (const item of transcript.items) {
      if (item.kind === 'tool' && isSubagentTool(item.tool) && item.childSessionId !== undefined) {
        seen.add(item.childSessionId);
        out.push({ childId: item.childSessionId, desc: subagentDescription(item) });
      }
    }
    for (const [childId, desc] of childSessions) {
      if (!seen.has(childId)) out.push({ childId, desc: desc ?? childId });
    }
    return out;
  }

  function syncPickerOverlay(): void {
    if (subPicker === null) return;
    state.overlays = [
      { title: '选择子会话', items: subPicker.items, activeIndex: subPicker.activeIndex, showNumbers: true },
    ];
  }

  /** v 入口：0 个 = 瞬时提示；1 个 = 直开；多个 = 列表选择浮层 */
  function openSubagentPicker(): void {
    const subs = subagentCandidates();
    if (subs.length === 0) {
      showHint('（无可打开的子会话）');
      return;
    }
    if (subs.length === 1) {
      openSubagentView(subs[0]!.childId);
      return;
    }
    subPicker = {
      items: subs.map((s, i) => `${i + 1}. ${s.desc}（${s.childId}）`),
      targets: subs.map((s) => s.childId),
      activeIndex: 0,
    };
    controller.blur(); // 列表接管键盘
    syncPickerOverlay();
    invalidate();
  }

  function closeSubPicker(cancel: boolean): void {
    const picker = subPicker;
    subPicker = null;
    state.overlays = [];
    controller.focus();
    if (!cancel && picker !== null) {
      openSubagentView(picker.targets[picker.activeIndex] ?? picker.targets[0]!);
      return;
    }
    invalidate();
  }

  /** 子会话不可读时的如实降级：错误行进转录（绝不伪造内容） */
  function childTranscriptError(childId: string, message: string): TranscriptState {
    return transcriptReducer(emptyTranscript(), {
      type: 'system',
      id: `subview-err:${childId}`,
      text: `无法读取子会话 ${childId}: ${message}（子会话目录不存在或日志尚未落盘）`,
    });
  }

  function openSubagentView(childId: string): void {
    // 重建子转录 = 磁盘重放（权威，含落盘全量）∪ onChildEvent 事件（运行中/磁盘缺失兜底）。
    // 事件按 seq 派生 id（sessionEventToTranscript），与磁盘同源事件 put() 幂等去重。
    childTranscripts.set(childId, loadChildTranscript(childId));
    subView = { childId };
    controller.blur(); // 视图接管键盘（composer 不画，无输入）
    rebuildSubview();
    invalidate();
  }

  /** 磁盘重放 + live 事件合并（locate 失败/无目录时降级 live 事件；两者皆空 = 如实错误行） */
  function loadChildTranscript(childId: string): TranscriptState {
    let located = false;
    let dirError: string | undefined;
    let ts = emptyTranscript();
    try {
      const dir = runtime.sessionManager.locate(childId);
      if (dir !== undefined) {
        ts = projectSession(dir);
        located = true;
      }
    } catch (e) {
      dirError = (e as Error)?.message ?? String(e);
    }
    for (const ev of childEvents.get(childId) ?? []) {
      const te = sessionEventToTranscript(ev);
      if (te !== null) ts = transcriptReducer(ts, te);
    }
    if (ts.items.length === 0) {
      return childTranscriptError(childId, dirError ?? (located ? '日志为空' : '未定位到子会话目录'));
    }
    return ts;
  }

  /** 子视图重建（打开/实时追加/子转录更新时）：子转录 → 投影 → 独立 Scrollback */
  function rebuildSubview(): void {
    if (subView === null) return;
    const ts = childTranscripts.get(subView.childId) ?? emptyTranscript();
    const sb = new Scrollback(projectTranscript(ts.items, { cols: contentCols() }), contentCols());
    state.subagentView = { scrollback: sb, hint: `子会话 ${subView.childId} · ${SUBVIEW_HINT}` };
  }

  function closeSubagentView(): void {
    subView = null;
    state.subagentView = null;
    controller.focus();
    invalidate();
  }

  // —— 渲染与 chrome ——
  function refreshChrome(): void {
    const parts = [String(runtime.mode()), `provider ${runtime.provider.name}`];
    if (busy) parts.push('⏺ 运行中…');
    if (queue.length > 0) parts.push(`已排队 ${queue.length}`);
    state.statusline = parts.join(' · ');
    // 底边指示（P3-B 顺序：模式 · 焦点 · 其他）：normal 省略模式名，scrollback（Tab 焦点）、
    // 审批寄放提示常驻，hint 瞬时叠加
    const ind: string[] = [];
    if (uiMode !== 'normal') ind.push(uiMode);
    if (scrollbackFocus) ind.push('scrollback');
    if (approvalParked) ind.push('审批待答（Tab 回卡）');
    if (hint !== null) ind.push(hint);
    state.indicators = ind;
  }

  function invalidate(): void {
    syncCandidates();
    refreshChrome();
    renderChat(screen, state);
  }

  // —— 候选补全（P3-C：draft 以 '/' 开头且不含空格/换行 = ink commandNameActive 语义）——
  // controller（冻结）接受候选/编辑后只改 state.draft/candidates.activeIndex，候选重算由本层
  // 在 invalidate 内完成（draft 变化必经 feed → invalidate，天然逐字过滤）。
  function syncCandidates(): void {
    const draft = state.draft ?? '';
    const active = draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n');
    const prev = state.candidates;
    if (!active) {
      state.candidates = null;
      return;
    }
    const items = filterCommands(draft);
    if (items.length === 0) {
      state.candidates = null;
      return;
    }
    // 过滤结果不变（如纯 ↑↓ 导航）：保留 controller 改写的高亮；否则（增删字符）钳制旧高亮
    const keep = prev !== null && prev.items.length === items.length && prev.items.every((it, i) => it === items[i]);
    const activeIndex = keep
      ? (prev?.activeIndex ?? 0)
      : Math.min(Math.max(0, prev?.activeIndex ?? 0), items.length - 1);
    state.candidates = { items, activeIndex };
  }

  /** 接受当前高亮候选：草稿写回 `/cmd `（含尾随空格 = 退出候选态；再 Enter 才发送） */
  function acceptCandidate(): void {
    const cands = state.candidates;
    if (cands === null || cands.items.length === 0) return;
    const chosen = cands.items[Math.min(cands.activeIndex, cands.items.length - 1)] ?? '';
    if (!chosen.startsWith('/')) return;
    state.draft = `${chosen} `;
    state.cursor = state.draft.length;
  }

  // —— UI 调度器（T4 有界合并，对齐 InkShell 的 16ms/64 批）——
  const scheduler: UiScheduler<TranscriptEvent> = createUiScheduler<TranscriptEvent>({
    flushMs: 16,
    maxBatch: 64,
    onFlush: (batch) => {
      transcript = batch.reduce(transcriptReducer, transcript);
      syncProjection();
      invalidate();
    },
  });

  function dispatch(event: TranscriptEvent): void {
    scheduler.push(event);
  }

  function flushUi(): void {
    scheduler.flushNow();
  }

  function sendSystem(text: string): void {
    sysSeq += 1;
    dispatch({ type: 'system', id: `sys:${sysSeq}`, text });
    flushUi(); // 低频：立即落定可见（对齐 InkShell 命令输出的即时性）
  }

  // —— 提示（Ctrl+C 协议瞬时提示；绝不写入草稿）——
  function clearHint(): void {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hint !== null) {
      hint = null;
      invalidate();
    }
  }

  function showHint(msg: string): void {
    clearHint();
    hint = msg;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      hint = null;
      invalidate();
    }, HINT_CLEAR_MS);
    invalidate();
  }

  // —— 审批 overlay（P3-B blocking card：键盘接管 / 寄放两态 + Ctrl+F 全文展开）——
  let approvalActiveIndex = 0;
  let approvalExpanded = false; // Ctrl+F 展开 query 全文（差异登记：query 无参数数据，见文件头）
  let approvalParked = false; // Esc 寄放：卡片只显示不接管键盘，审批仍挂起
  let approvalQueryRows = 0; // 展开态全文行数（显示高亮 = 行数 + 选项下标）

  /** 构建审批卡 spec：收起 = 标题承载 query（按宽裁剪）；展开 = query 全文折行进 items 前段 */
  function buildApprovalSpec(): OverlaySpec {
    const query = gate.pending() ?? '';
    if (!approvalExpanded) {
      approvalQueryRows = 0;
      return {
        title: `Approval · ${query}`,
        items: APPROVAL_ITEMS,
        activeIndex: approvalActiveIndex,
        showNumbers: true,
      };
    }
    // 全文行缩进两格与选项区分；展开宽度按内容区收敛（前缀 + 余量）
    const qLines = wrapTextByWidth(query, Math.max(16, contentCols() - 6));
    approvalQueryRows = qLines.length;
    return {
      title: 'Approval · 全文（Ctrl+F 收起）',
      items: [...qLines.map((l) => `  ${l}`), ...APPROVAL_ITEMS],
      activeIndex: approvalQueryRows + approvalActiveIndex,
      showNumbers: true,
    };
  }

  function openApproval(_query: string): void {
    // 问题全文放标题行（drawOverlay 按宽裁剪）；选项固定 y/a/n——对齐 Ink ConfirmDialog 的
    // 「问题 + 选择列表」语义（近似：无独立问题行，标题承载）。query 统一经 gate.pending()
    // 取（buildApprovalSpec 的单一数据源，新提问挤占后 spec 以最新挂起为准）
    approvalActiveIndex = 0;
    approvalExpanded = false;
    approvalParked = false;
    scrollbackFocus = false; // 审批接管时焦点语义回输入框（避免结算后指示器/折叠键族残留滚动区态）
    state.overlays = [buildApprovalSpec()];
    controller.blur(); // overlay 互斥接管键盘（对齐 InkShell 的 overlayOpen 语义）
    invalidate();
  }

  /** Esc 寄放：卡片保持显示、审批仍挂起，键盘交还 composer（grok park 语义，见文件头） */
  function parkApproval(): void {
    approvalParked = true;
    controller.focus();
    invalidate();
  }

  /** 寄放态显式回卡（Tab）：重新接管键盘 */
  function retakeApproval(): void {
    approvalParked = false;
    controller.blur();
    invalidate();
  }

  function closeApproval(): void {
    state.overlays = [];
    approvalParked = false;
    approvalExpanded = false;
    scrollbackFocus = false; // 结算回 composer 焦点（审查 P2-1：指示器与折叠键族同步复位）
    controller.focus();
    invalidate();
  }

  /** 重建审批卡 spec（走行/展开/收起/resize 后统一走此函数，activeIndex 以选项下标为源） */
  function syncApprovalOverlay(): void {
    if (state.overlays.length > 0) state.overlays = [buildApprovalSpec()];
  }

  function chooseApproval(index: number): void {
    const answer = APPROVAL_ANSWERS[index];
    if (answer === undefined) return;
    gate.choose(answer as 'y' | 'a' | 'n');
  }

  // —— 模式四态（P3-B；plan/auto 声明态不改行为，红线 6 见文件头）——
  function setMode(mode: UiMode): void {
    if (uiMode === mode) return; // 幂等（/plan /auto 重复设置保持）
    uiMode = mode;
    invalidate();
  }

  /** Shift+Tab 循环：Normal→Plan→Auto→Always-approve→Normal（grok 循环序） */
  function cycleMode(): void {
    const idx = MODE_CYCLE.indexOf(uiMode);
    setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'normal');
  }

  // —— Ctrl+O always-approve（UI 开关；开关态只影响**新**审批的代答，见文件头红线 6）——
  function toggleAlwaysApprove(): void {
    setMode(uiMode === 'always-approve' ? 'normal' : 'always-approve');
  }

  const gate = deps.gate;
  gate.bind?.({
    onOpen: (query) => {
      openApproval(query);
      // always-approve 开启时自动代答 'a'：经 gate.choose 走 resolve 路径（红线 6：
      // 不绕过 core 审批队列）；切换瞬间已挂起的审批不在此路径（onOpen 只对新 ask 触发）
      if (uiMode === 'always-approve') gate.choose('a');
    },
    onSettled: () => closeApproval(),
  });

  // —— Ctrl+C 协议（对齐 Composer）——
  const ctrlCGuard = createCtrlCGuard({ windowMs: CTRL_C_WINDOW_MS });

  function abortCurrentTurn(): void {
    if (!busy) return;
    sendSystem('^C（正在取消当前 turn…）');
    runtime.abortTurn();
  }

  function interrupt(): void {
    if (gate.pending() !== null) {
      gate.cancel(); // 审批挂起时 Ctrl+C = 取消审批（对齐 Ink 的 Esc/Ctrl+C 便利取消）
      return;
    }
    const verdict = ctrlCGuard.press({ busy });
    if (verdict === 'cancel') {
      clearHint();
      abortCurrentTurn();
      return;
    }
    if (verdict === 'confirm') {
      clearHint();
      requestExit('sigint');
      return;
    }
    showHint('（再按一次 Ctrl+C 退出）');
  }

  // —— 退出（createShutdown 幂等路径；忙时先 abort、收尾后收敛）——
  const shutdown: ShutdownController = createShutdown({
    finish: async () => {
      attached.detach();
      clearTimers();
      await deps.cleanup?.();
    },
    exit: (code) => {
      deps.exit?.(code);
    },
  });

  function requestExit(reason: ExitReason = 'exit'): void {
    if (shutdown.isShuttingDown()) return;
    if (busy) {
      // turn 进行中：先取消，等本轮收尾后由 finally 触发退出（对齐 InkShell requestExit）
      exitRequested = true;
      pendingExitReason = reason;
      runtime.abortTurn();
      return;
    }
    shutdown.request(reason);
  }

  // —— 提交 / 队列（对齐 InkShell.submit 的 FIFO 队列语义）——
  function enqueue(text: string): void {
    queue.push(text);
    invalidate();
  }

  function drainQueue(): void {
    if (shutdown.isShuttingDown()) return;
    const next = queue.shift();
    if (next === undefined) return;
    invalidate();
    void handleUserText(next);
  }

  function submit(text: string): void {
    if (text.trim().length === 0) return;
    if (busy) {
      enqueue(text);
      return;
    }
    void handleUserText(text);
  }

  async function runTurnText(text: string): Promise<void> {
    bridge.reset();
    busy = true;
    userSeq += 1;
    // 输入优先：user 回显立即落定（对齐 InkShell dispatchInputNow）
    scheduler.setInputPriority(true);
    scheduler.push({ type: 'user/message', seq: 0, id: `user:live:${userSeq}`, text });
    scheduler.flushNow();
    scheduler.setInputPriority(false);
    invalidate();
    let result: TurnResult | undefined;
    try {
      // @file/@dir 引用解析（对齐 InkShell：发送前预处理，回显保持原文）
      let sendText = text;
      if (hasContextRefs(text)) {
        const ref = expandContextRefs(text, { cwd: runtime.root, root: runtime.root });
        if (ref.hasRefs && ref.header.length > 0) sendText = `${ref.header}\n\n${text}`;
      }
      result = await runtime.runUserTurn(sendText, bridge.handler);
      const terminal = bridge.finalize(result);
      if (terminal !== null && !isDuplicateFinal(terminal)) dispatch(terminal);
      if (result !== undefined) {
        dispatch({ type: 'status', id: `status:${userSeq}`, text: turnSummaryLine(result) });
      }
    } catch (e) {
      sendSystem(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      bridge.reset();
      busy = false;
      updateSpinner(); // P3-D：turn 结束（含取消/异常）→ 空闲停表
      scheduler.flushNow(); // final flush：终态/状态行立即落定
      invalidate();
      // 回合结束提醒（cancelled 不发；退出中不发；异常结束照发——对齐 InkShell）
      if (!shutdown.isShuttingDown()) {
        notifier.onTurnComplete({ focused, cancelled: result?.stopReason === 'cancelled' });
      }
      if (exitRequested && !shutdown.isShuttingDown()) {
        exitRequested = false;
        shutdown.request(pendingExitReason);
      } else {
        drainQueue();
      }
    }
  }

  // —— 命令（P3-C 全集；共享命令委托 runSharedCommand，差异登记见文件头）——
  function handleUserText(text: string): void {
    const parsed = parseCommand(text);
    if (parsed !== null) {
      sysSeq += 1;
      scheduler.setInputPriority(true);
      scheduler.push({ type: 'system', id: `echo:${sysSeq}`, text: `> ${text}` });
      scheduler.flushNow();
      scheduler.setInputPriority(false);
      handleCommand(parsed);
      return;
    }
    // plan 声明态：提交消息时在转录打灰色提示行（不改执行，红线 6 见文件头）
    if (uiMode === 'plan') sendSystem(PLAN_MODE_NOTICE);
    void runTurnText(text);
  }

  /**
   * P3-C 重投影（对齐 ink reprojectTranscript）：/undo /redo 追加 rewind/marker、会话切换
   * （/new /resume /fork）之后，用 projectSession 从磁盘会话日志整体重建转录（被遮蔽的
   * user/assistant 条目消失、恢复时再现）。先落定待处理事件；清空折叠覆盖集（对齐 ink 清
   * expandedIds，避免旧 item 下标残留）；磁盘读取失败保底重投影内存转录（不伪造）。
   */
  function reprojectFromDisk(): void {
    flushUi();
    collapsed = new Set<number>();
    const current = runtime.getCurrent();
    if (current !== null) {
      try {
        transcript = projectSession(current.dir);
      } catch {
        // 磁盘读取失败：保持内存转录（下方 reprojectAll 兜底刷新视图）
      }
    }
    reprojectAll();
  }

  /** 共享命令执行缝（委托 ink-commands.runSharedCommand；print/reproject/requestExit 对齐 InkShell） */
  const commandIo: InkCommandIo = {
    print: (t) => sendSystem(t),
    reproject: () => reprojectFromDisk(),
    requestExit: () => requestExit('exit'),
  };

  function handleCommand(parsed: { name: string; rest: string }): void {
    switch (parsed.name) {
      case '/help':
      case '/?':
        sendSystem(HELP_TEXT);
        return;
      // —— 共享命令（P3-C）：/undo /redo（rewind 重投影）/new /resume /fork /sessions /exit
      // /quit /? 与未知命令 → ink-commands.runSharedCommand（真实 CommandContext；未知命令
      // 由共享 handleCommand 输出「未知命令」，不再有本层「暂不支持」分支）
      case '/exit':
      case '/quit':
        requestExit('exit');
        return;
      // —— 本地 UI 命令（与 ink runInkChat.handleCommand 同文案；差异登记见文件头）——
      case '/mode': {
        const arg = parsed.rest.trim().toLowerCase();
        if (arg.length === 0) {
          cycleMode(); // 无参 = 循环切换一次（等价 Shift+Tab；任务规格二选一取循环，登记差异）
          showHint(`模式：${uiMode}${uiMode === 'plan' || uiMode === 'auto' ? '（声明态）' : ''}`);
          return;
        }
        if ((MODE_CYCLE as readonly string[]).includes(arg)) {
          setMode(arg as UiMode);
          sendSystem(
            `已切换模式: ${arg}${arg === 'plan' || arg === 'auto' ? '（UI 声明态：不改变审批/执行行为）' : ''}`,
          );
          return;
        }
        sendSystem(`error: 未知模式 ${parsed.rest}（可选: ${MODE_CYCLE.join(', ')}）`);
        return;
      }
      case '/context': {
        const current = runtime.getCurrent();
        const usage = current !== null ? getContextUsage(current.dir) : undefined;
        sendSystem(`上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`);
        return;
      }
      case '/compact':
        sendSystem('压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。');
        return;
      case '/reasoning': {
        const arg = parsed.rest.trim().toLowerCase();
        if (arg.length === 0) {
          sendSystem(`推理展示: ${runtime.reasoning() ? '开启' : '关闭'}（/reasoning on|off）`);
          return;
        }
        if (arg === 'on') {
          runtime.setReasoning(true);
          sendSystem('推理展示已开启（turn 内按 Ctrl+R 展开/收起折叠块）。');
          return;
        }
        if (arg === 'off') {
          runtime.setReasoning(false);
          sendSystem('推理展示已关闭。');
          return;
        }
        sendSystem(`error: 未知参数 ${parsed.rest}（用 on|off，或留空查看当前状态）`);
        return;
      }
      case '/tasks':
        sendSystem('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
        return;
      // —— 模式命令（P3-B；plan/auto 声明态、always-approve toggle，见文件头语义）——
      case '/plan':
        setMode('plan');
        sendSystem('[plan mode] 已声明 plan 模式（UI 声明态：仅提示，不改变审批/执行行为；Shift+Tab 可切回）');
        return;
      case '/auto':
        setMode('auto');
        sendSystem(
          '[auto mode] 已声明 auto 模式（UI 声明态：grok 的 auto=自动审批与红线 6 冲突，本层不自动放行，审批仍需人工回答）',
        );
        return;
      case '/always-approve': {
        const turningOn = uiMode !== 'always-approve';
        setMode(turningOn ? 'always-approve' : 'normal');
        sendSystem(
          turningOn
            ? '[always-approve] 已开启（开启后的新审批自动代答 a，经 gate resolve 路径；再跑 /always-approve 或 Ctrl+O 关闭）'
            : '[always-approve] 已关闭（审批恢复人工回答）',
        );
        return;
      }
      default:
        // /undo /redo /new /resume /fork /sessions（无参文本列表）与未知命令 → 共享实现
        runSharedCommand(parsed, runtime, commandIo);
    }
  }

  // —— turn 流桥与终态去重 ——
  let lastStep: { turnId: string | undefined; text: string } | null = null;
  const bridge = createTurnStreamBridge((event) => {
    if (event.type === 'assistant/step') lastStep = { turnId: event.turnId, text: event.text };
    // P3-D 耗时（UI 层近似计时，见状态区注释）：subagent tool/call 起表，tool/result 结算
    if (event.type === 'tool/call' && isSubagentTool(event.tool)) {
      subagentStarts.set(event.callId, Date.now());
      updateSpinner();
    } else if (event.type === 'tool/result' && subagentStarts.has(event.callId)) {
      const startedAt = subagentStarts.get(event.callId) ?? Date.now();
      subagentStarts.delete(event.callId);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (seconds >= 1) subagentDurations.set(event.callId, seconds); // <1s 即时完成不显示
      updateSpinner();
    }
    dispatch(event);
  });

  // —— P3-D：onChildEvent 桥（SubagentHooks → 子会话登记 + 视图实时追加）——
  // runNextChat 在 setupChatSession 装配期注入 SubagentHooks（core 导出面，core 零改动），
  // 事件经 sink 延迟注册到本 handler；writer 先落盘后回调（core 侧保证）。
  deps.subagentEventSink?.set((sessionId, event) => {
    if (!childSessions.has(sessionId)) childSessions.set(sessionId, undefined);
    if (event.type === 'user/message') {
      const text = event.payload.text;
      if (typeof text === 'string' && text.length > 0 && childSessions.get(sessionId) === undefined) {
        childSessions.set(sessionId, text.split('\n')[0]?.trim() || undefined);
      }
    }
    let list = childEvents.get(sessionId);
    if (list === undefined) {
      list = [];
      childEvents.set(sessionId, list);
    }
    list.push(event);
    const te = sessionEventToTranscript(event);
    if (te !== null) {
      const prev = childTranscripts.get(sessionId) ?? emptyTranscript();
      childTranscripts.set(sessionId, transcriptReducer(prev, te));
    }
    if (subView !== null && subView.childId === sessionId) {
      rebuildSubview(); // 实时追加：视图打开中 → 独立 Scrollback 全量重建（子会话行数有限）
      invalidate();
    }
  });

  /** turn-final 与末段 step 文本重复时跳过（避免同正文显示两份，见 bridge 差异说明） */
  function isDuplicateFinal(event: TranscriptEvent): boolean {
    if (event.type !== 'turn-final') return false;
    return (
      lastStep !== null &&
      event.text === lastStep.text &&
      (lastStep.turnId === undefined || event.turnId === undefined || event.turnId === lastStep.turnId)
    );
  }

  // —— 折叠键族（P3-A，keymap 裁决：旧 Ctrl+O 折叠语义迁移至 e/E/h/l）——
  // collapsed 覆盖集语义（见 projection.ts）：在集 = 与该 item 默认折叠态取反；
  // 工具/推理 item 的默认态都是折叠 → 全量展开 = 收录全部可折叠下标，全量折叠 = 清空集。
  function isCollapsibleItem(item: TranscriptItem | undefined): boolean {
    return item !== undefined && (item.kind === 'tool' || (item.kind === 'assistant' && item.reasoning !== undefined));
  }

  /** 最近一次工具/推理 item 下标（next 无块光标，h/l 取最近可折叠 item，对齐旧 Ctrl+O 定位） */
  function lastCollapsibleIndex(): number {
    for (let i = transcript.items.length - 1; i >= 0; i -= 1) {
      if (isCollapsibleItem(transcript.items[i])) return i;
    }
    return -1;
  }

  /** e：展开全部块（覆盖集 = 全部可折叠 item 下标 + 全量重投影） */
  function expandAllBlocks(): void {
    const next = new Set<number>();
    transcript.items.forEach((item, i) => {
      if (isCollapsibleItem(item)) next.add(i);
    });
    collapsed = next;
    reprojectAll();
  }

  /** E：折叠全部块（覆盖集清空 = 纯默认态，全量重投影） */
  function collapseAllBlocks(): void {
    collapsed = new Set<number>();
    reprojectAll();
  }

  /** h/l：折叠（false）/ 展开（true）最近一次工具/推理块 */
  function setNearestBlockExpanded(expand: boolean): void {
    const idx = lastCollapsibleIndex();
    if (idx < 0) return;
    const next = new Set(collapsed);
    if (expand) next.add(idx);
    else next.delete(idx);
    collapsed = next;
    reprojectAll();
  }

  // —— 输入装配（parser → dispatcher（approval > composer）→ 兜底）——
  // 审批卡键位（P3-B，grok permission prompt 契约，见文件头）：Tab/Shift+Tab 循环走行、
  // 1-3 数字直选、Enter 确认、↑↓ 保留（grok 亦有）、Ctrl+F 展开全文、Esc 寄放（不回答
  // 不关闭）、Ctrl+C 取消、Ctrl+O always-approve。寄放态（approvalParked）本层全放行：
  // 键盘回 composer，Tab 由 extraKeyHandler 显式回卡。
  const approvalLayer: InputLayer = {
    name: 'approval',
    handle: (event: InputEvent): boolean => {
      if (gate.pending() === null || approvalParked) return false;
      if (event.type !== 'key') return false;
      const ev = event;
      const n = APPROVAL_ITEMS.length;
      if (ev.key === 'up' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        approvalActiveIndex = (approvalActiveIndex - 1 + n) % n;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      if (ev.key === 'down' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        approvalActiveIndex = (approvalActiveIndex + 1) % n;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      // Tab/Shift+Tab 在选项间循环走行（grok：never move focus out of the card）
      if (ev.key === 'tab' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        approvalActiveIndex = (approvalActiveIndex + (ev.modifiers.shift ? -1 : 1) + n) % n;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        chooseApproval(approvalActiveIndex);
        return true;
      }
      if (!ev.modifiers.ctrl && !ev.modifiers.alt) {
        const idx = ['1', '2', '3'].indexOf(ev.key);
        if (idx >= 0) {
          chooseApproval(idx);
          return true;
        }
      }
      // Ctrl+F 展开/收起审批 query 全文（grok 为完整工具参数；我方 query 无参数数据，
      // 展开全文案，差异已登记 keymap 文档）
      if (ev.modifiers.ctrl && ev.key === 'f') {
        approvalExpanded = !approvalExpanded;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      // Esc = 寄放焦点：不回答不关闭（卡片保持显示、审批挂起，键盘回 composer）
      if (ev.key === 'escape') {
        parkApproval();
        return true;
      }
      if (ev.modifiers.ctrl && ev.key === 'c') {
        gate.cancel();
        return true;
      }
      // Ctrl+O 在审批卡上切换 always-approve（grok 卡片键位）：只动开关，**不代答当次**
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return true;
      }
      return false;
    },
  };

  const controller: ChatController = createChatController(state, {
    onSubmit: (text) => submit(text),
    onInterrupt: () => interrupt(),
    extraKeyHandler: (ev) => {
      if (ev.modifiers.ctrl && ev.key === 'c') return 'ignored'; // 让内置 onInterrupt（guard 协议）处理
      // 其余任意按键重置退出协议（对齐 Composer：非 Ctrl+C 按键清窗口与提示）
      ctrlCGuard.reset();
      clearHint();
      // Ctrl+D 不在此拦截：keymap 裁决 = 半页下滚，由 chat-controller 内置消费（半页滚动
      // 与退出语义不冲突——退出只走 Ctrl+C 双击与 /exit，见文件头裁决说明）
      if (ev.key === 'escape') {
        if (busy) {
          abortCurrentTurn(); // 忙时 Esc：停止当前 turn（不清草稿，对齐 Composer）
          return 'consumed';
        }
        state.draft = '';
        state.cursor = 0;
        return 'consumed';
      }
      // Ctrl+O = always-approve 切换（keymap 裁决；旧折叠语义迁移 e/E/h/l，见文件头）
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return 'consumed';
      }
      // 寄放态 Tab = 显式回卡（grok：card parked → Tab hands keyboard back to the card；
      // Shift+Tab 保持模式循环，见下方差异登记）
      if (approvalParked && ev.key === 'tab' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        retakeApproval();
        return 'consumed';
      }
      // 候选可见时 Tab / Enter = 接受高亮候选（P3-C）：草稿写回 `/cmd `（含尾随空格即退出
      // 候选态，再 Enter 才发送；grok 选中即执行、ink Enter 提交原草稿，差异登记见文件头）。
      // extraKeyHandler 先于 controller 内置候选裁决调用，本层拦截后 controller 的
      // 「Enter 提交高亮候选」不会触发。
      if (
        state.candidates !== null &&
        state.candidates.items.length > 0 &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        ((ev.key === 'tab' && !ev.modifiers.shift) || (ev.key === 'enter' && !ev.modifiers.shift))
      ) {
        acceptCandidate();
        return 'consumed';
      }
      // Shift+Tab = 模式循环（composer 焦点语义；审批卡接管时 dispatcher 卡片层优先消费
      // 为反向走行，到不了这里；候选可见时模式循环仍生效——全局 chord 优先级高于候选）
      if (ev.key === 'tab' && ev.modifiers.shift && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        cycleMode();
        showHint(`模式：${uiMode}${uiMode === 'plan' || uiMode === 'auto' ? '（声明态）' : ''}`);
        return 'consumed';
      }
      // Tab = 输入框/滚动区双态焦点（keymap 裁决采纳）。候选可见时不在本层切换：
      // 条件短路返回 'ignored'，Tab 落到 controller 内置裁决 = 接受候选（优先级保持）
      if (
        ev.key === 'tab' &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        !ev.modifiers.shift &&
        state.candidates === null
      ) {
        scrollbackFocus = !scrollbackFocus;
        invalidate();
        return 'consumed';
      }
      // 滚动区焦点下的块折叠键族（仅无 Ctrl/Alt 修饰；grok 为选中块导航，此处 h/l 取
      // 最近工具/推理 item，差异已登记 keymap 文档）
      if (scrollbackFocus && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        if (ev.key === 'e') {
          expandAllBlocks();
          return 'consumed';
        }
        if (ev.key === 'E') {
          collapseAllBlocks();
          return 'consumed';
        }
        if (ev.key === 'h') {
          setNearestBlockExpanded(false);
          return 'consumed';
        }
        if (ev.key === 'l') {
          setNearestBlockExpanded(true);
          return 'consumed';
        }
        // P3-D 键位裁决：v = 打开子代理全屏视图（0 提示 / 1 直开 / 多选列表；差异登记 keymap）
        if (ev.key === SUBAGENT_VIEW_KEY) {
          openSubagentPicker();
          return 'consumed';
        }
        if (ev.text !== undefined && ev.text.length > 0) {
          // 其余字母键自动回到输入框（grok simple 模式语义），字符照常走内置插入
          scrollbackFocus = false;
          invalidate();
          return 'ignored';
        }
      }
      return 'ignored';
    },
  });

  // —— 候选鼠标层（P3-C 悬停/滚轮改选，grok panes.rs:958；位于 approval 与 composer 之间）——
  // 候选画在 composer 层顶部（chat-screen layoutChat：composer.top 起的候选行），命中测试
  // 用 composer.candidateItemAt（含滚动窗口映射）。move 命中候选行改选；滚轮在候选行上
  // ±1 循环；候选区外的滚轮/移动不消费（composer 层照常滚动转录）。controller blur 期
  // （审批卡接管）不抢事件（composer 层同 guard）。
  const candidateMouseLayer: InputLayer = {
    name: 'candidate-mouse',
    handle: (event: InputEvent): boolean => {
      if (event.type !== 'mouse' || !controller.isFocused()) return false;
      const cands = state.candidates;
      if (cands === null || cands.items.length === 0) return false;
      const layout = layoutChat(screen.rows, screen.cols, state);
      if (layout.candidateRows <= 0) return false;
      const relRow = event.row - layout.composer.top;
      if (relRow < 0 || relRow >= layout.candidateRows) return false;
      if (event.kind === 'move') {
        const idx = candidateItemAt(cands.items.length, cands.activeIndex, relRow);
        if (idx !== null && idx !== cands.activeIndex) {
          cands.activeIndex = idx;
          invalidate();
        }
        return true;
      }
      if (event.kind === 'scroll') {
        const n = cands.items.length;
        cands.activeIndex = (cands.activeIndex + (event.button === 0 ? -1 : 1) + n) % n;
        invalidate();
        return true;
      }
      return false;
    },
  };

  // —— P3-D 子视图/选择列表键盘层（位于 approval 与 composer 之间：审批仍最优先）——
  // 列表浮层：↑↓/j/k 走行、数字直选、Enter 打开、Esc/q 取消。
  // 视图态（controller 已 blur，composer 层不消费）：q/Esc 返回、↑↓ 单行、PgUp/PgDn 翻页、
  // 滚轮 ±3；其余放行（审批期间 approval 层优先接管，视图保留在后）。
  const subagentLayer: InputLayer = {
    name: 'subagent-view',
    handle: (event: InputEvent): boolean => {
      if (subPicker !== null) {
        const picker = subPicker; // 局部快照（闭包内 TS 收窄；closeSubPicker 会置空外层变量）
        if (event.type !== 'key') return false;
        const ev = event;
        const n = picker.items.length;
        const move = (delta: number): void => {
          picker.activeIndex = (picker.activeIndex + delta + n) % n;
          subPicker = picker;
          syncPickerOverlay();
          invalidate();
        };
        if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(-1);
          return true;
        }
        if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(1);
          return true;
        }
        if (!ev.modifiers.ctrl && !ev.modifiers.alt && /^[1-9]$/.test(ev.key)) {
          const idx = Number(ev.key) - 1;
          if (idx < n) {
            picker.activeIndex = idx;
            closeSubPicker(false);
            return true;
          }
        }
        if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
          closeSubPicker(false);
          return true;
        }
        if (ev.key === 'escape' || ev.key === 'q') {
          closeSubPicker(true);
          return true;
        }
        return false;
      }
      if (subView === null) return false;
      if (event.type === 'mouse') {
        if (event.kind !== 'scroll') return false;
        const sb = state.subagentView?.scrollback;
        if (sb === undefined) return false;
        if (event.button === 0) sb.wheelUp();
        else sb.wheelDown();
        invalidate();
        return true;
      }
      if (event.type !== 'key') return false;
      const ev = event;
      const sb = state.subagentView?.scrollback;
      if (sb === undefined) return false;
      if ((ev.key === 'q' || ev.key === 'escape') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeSubagentView();
        return true;
      }
      if (ev.key === 'up') {
        sb.scrollBy(-1);
        invalidate();
        return true;
      }
      if (ev.key === 'down') {
        sb.scrollBy(1);
        invalidate();
        return true;
      }
      if (ev.key === 'pageup') {
        sb.pageUp();
        invalidate();
        return true;
      }
      if (ev.key === 'pagedown') {
        sb.pageDown();
        invalidate();
        return true;
      }
      return false;
    },
  };

  const dispatcher: InputDispatcher = createInputDispatcher({
    layers: [approvalLayer, subagentLayer, candidateMouseLayer, createComposerLayer(controller)],
    fallback: (event) => {
      if (event.type === 'focus') {
        focused = event.direction === 'in';
        invalidate();
      }
    },
  });

  const parser: InputParser = createInputParser();
  const attached: AttachedInput = attachInput(parser, controller, dispatcher);

  function feed(bytes: Uint8Array | string): number {
    const n = attached.feed(bytes);
    if (n > 0) invalidate();
    return n;
  }

  function flushIdle(now?: number): number {
    const n = attached.flushIdle(now);
    if (n > 0) invalidate();
    return n;
  }

  // 空闲冲刷定时器（孤立 ESC → Esc 键、断流 paste 兜底；见 chat-controller 文件头）
  const idleTimer = setInterval(() => {
    flushIdle();
  }, IDLE_FLUSH_MS);

  function clearTimers(): void {
    clearInterval(idleTimer);
    scheduler.dispose();
    bridge.dispose();
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  }

  // —— steer 观察（T5：回帧 → 转录报告，对齐 InkShell）——
  runtime.observeSteer((result) => {
    steerSeq += 1;
    const { line } = describeSteerResult(result);
    sysSeq += 1;
    dispatch({ type: 'system', id: `steer:${steerSeq}`, text: line });
    flushUi();
  });

  // —— notifier（T4：回合结束提醒；sink 注入便于测试）——
  const notifier: Notifier = createNotifier(env, deps.notifyWrite ?? stderrSink());

  // 初始帧
  syncProjection();
  invalidate();

  return {
    state,
    feed,
    flushIdle,
    flushUi,
    resize(cols, rows) {
      const prevCols = screen.cols;
      resizeChat(screen, state, cols, rows);
      if (Math.max(1, cols) !== prevCols) {
        // 宽度变化：截断/摘要行按新宽度重投影（强制全量重投影；只调 rows 不重投影）
        reprojectAll();
        // 审批卡展开态的全文折行按新宽度重排（收起态标题裁剪由 drawOverlay 逐帧处理，免重建）
        syncApprovalOverlay();
      } else {
        invalidate();
      }
    },
    submit,
    interrupt,
    requestExit,
    approve(answer) {
      gate.choose(answer);
    },
    cancelApproval() {
      gate.cancel();
    },
    pendingApproval: () => gate.pending(),
    logicalLines() {
      const sb = state.scrollback;
      const out: string[] = [];
      for (let i = 0; i < sb.lineCount; i += 1) out.push(sb.rowOf(i).join(''));
      return out;
    },
    subagentViewLines() {
      const sv = state.subagentView;
      if (!sv) return null;
      const out: string[] = [];
      for (let i = 0; i < sv.scrollback.lineCount; i += 1) out.push(sv.scrollback.rowOf(i).join(''));
      return out;
    },
    isBusy: () => busy,
    queueSnapshot: () => [...queue],
    awaitDone: () => shutdown.awaitDone(),
    dispose() {
      clearTimers();
    },
  };
}

// —— 真机装配（HARNESS2_RENDERER=next 分支入口；由 runInkChat.tsx 调用）——

/**
 * 进程退出兜底还原（审查 P1）：同步写出关鼠标上报 + 显示光标 + 退 alt-screen 到 stdout，
 * 并尝试复位 stdin raw mode。序列天然幂等——正常退出路径 screen.stop 已还原过，重复写无害。
 * 只能在 process 'exit' 回调内同步调用（异步操作不执行）；流已销毁时吞错，绝不阻塞退出。
 */
export function emergencyTerminalRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
): void {
  try {
    out.write(MOUSE_OFF + SHOW_CURSOR + ALT_SCREEN_EXIT);
  } catch {
    // 流已销毁：兜底写出失败不阻塞退出
  }
  try {
    stdin?.setRawMode?.(false);
  } catch {
    // 流已销毁：还原失败不阻塞退出
  }
}

/**
 * 挂 process 'exit' 监听兜底还原终端：异常退出（未捕获异常、异步还原路径被跳过等）下，
 * 进程退出前同步恢复终端状态。返回解绑函数（shutdown 收敛后调用；proc 可注入供
 * headless 测试验证注册/解绑与兜底写出序列）。
 */
export function bindEmergencyExitRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const onExit = (): void => emergencyTerminalRestore(out, stdin);
  proc.on('exit', onExit);
  return () => {
    proc.off('exit', onExit);
  };
}

/**
 * next 渲染层的 chat 入口：setupChatSession（与 legacy/ink 共用）→ Screen 全屏帧循环。
 * 终端生命周期：进 alt-screen（Screen.start，含鼠标上报）→ DECSET 1004 焦点上报 →
 * bracketed paste 开启 → stdin raw mode；退出经 createShutdown.finish 统一还原（拆屏 /
 * 焦点上报关闭 / paste 关闭 / raw mode 还原 / runtime.finish），SIGTERM/SIGHUP 走
 * bindShutdownSignals 同一幂等路径；process 'exit' 另有同步兜底（bindEmergencyExitRestore）。
 */
export async function runNextChat(options: ChatOptions = {}): Promise<void> {
  const bootLines: string[] = [];
  const gate = createApprovalGate();
  // P3-D：SubagentHooks 接线缝（装配期先于 harness 创建 → 可变 sink 延迟转发）。
  // core 的 SubagentHooks 为导出契约，此处仅装配层传参（core/冻结区零改动）。
  const childEventSink: { handler: ((sessionId: string, event: AnySessionEvent) => void) | null } = { handler: null };
  const runtime = await setupChatSession(options, {
    line: (t) => bootLines.push(t),
    // 审批弹窗：经 gate 打开 overlay，选择后 resolve；挤占/取消 resolve 为 ASK_CANCELLED
    askApproval: (query) => gate.ask(query),
    subagentHooks: {
      onChildEvent: (sessionId, event) => childEventSink.handler?.(sessionId, event),
    },
  });

  const stdout = process.stdout as NodeJS.WriteStream & { columns?: number; rows?: number };
  const stdin = process.stdin;
  const env = process.env;
  const canRaw = stdin.isTTY === true && typeof stdin.setRawMode === 'function';
  const mouseEnabled = env.HARNESS2_MOUSE !== '0';

  const screen = new Screen(stdout, Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24));
  screen.start({ mouse: mouseEnabled });
  // DECSET 1004 由 createNextChatHarness 装配时补写（本函数传入的正是同一 stdout，单次写出）
  stdout.write(BRACKETED_PASTE_ON); // ink usePaste 由 ink 自动开启；next 路径自行开关（parser 只负责解析）
  if (canRaw) stdin.setRawMode(true);

  // 审查 P1：进程退出兜底（'exit' 回调内同步还原终端；正常路径已还原，序列幂等无副作用）
  const detachExitRestore = bindEmergencyExitRestore(stdout, canRaw ? stdin : undefined);

  const harness = createNextChatHarness(runtime, {
    out: stdout,
    bootLines,
    env,
    gate,
    screen,
    subagentEventSink: {
      set: (fn) => {
        childEventSink.handler = fn;
      },
    },
    cleanup: async () => {
      screen.stop(); // 关鼠标上报 + 显示光标 + 退 alt-screen（幂等）
      stdout.write(MOUSE_ALL_MOTION_OFF); // 关全 motion 鼠标上报（与 1003h 成对；重复写无害）
      stdout.write(FOCUS_REPORT_OFF); // 关焦点上报（与 1004h 成对；重复写无害）
      stdout.write(BRACKETED_PASTE_OFF);
      if (canRaw) {
        try {
          stdin.setRawMode(false);
        } catch {
          // 流已销毁：还原失败不阻塞退出
        }
      }
      await runtime.finish({ destroyInput: () => stdin.destroy() });
    },
    exit: (code) => {
      process.exitCode = code; // 不 abrupt process.exit，让拆屏与锁释放完成（对齐 runInkChat）
    },
  });

  const onResize = (): void => {
    harness.resize(Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24));
  };
  stdout.on('resize', onResize);
  const onData = (chunk: string | Buffer): void => {
    harness.feed(chunk); // Buffer 是 Uint8Array，parser 直接消化
  };
  stdin.on('data', onData);

  // 审查 P2 同口径：SIGTERM（kill）/SIGHUP（终端关闭）复用幂等退出路径，收敛后解绑
  const detachSignals = bindShutdownSignals((reason) => harness.requestExit(reason));

  await harness.awaitDone();
  detachSignals();
  detachExitRestore(); // 正常收敛后解绑 exit 兜底监听（无残留监听；异常路径由兜底已覆盖）
  stdout.off('resize', onResize);
  stdin.off('data', onData);
}
