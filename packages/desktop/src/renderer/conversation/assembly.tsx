// assembly.tsx — 桌面**组装根**：把桌面专属能力注入共享会话席位（`@harness2/ui-shared`）。
//
// 实现在共享包（`renderer/conversation/seat.tsx`：转录 + 常驻 composer + 提交边界 + 草稿隔离），
// 本文件只剩「桌面侧的决定」，不重新实现任何业务语义：
//   1. Z2-05（Z-16）：主区事实**单一 chat** —— 不再有视图注册表 / 视图选择持久缝 / trajectory
//      主视图注册（那一层已退役）；trajectory 是右栏 tab（Z-14 `model-trajectory:{sessionId}`），
//      由 `components/SidePanel.tsx` 挂载 `TrajectoryViewContent`；
//   2. D-46 浮层测量宿主单例（chat 转录的 composer 预留）+ P2-5 轨迹定位通道单例；
//   3. D-86 ② inspect 消费者：工具卡「查看轨迹」→ **打开/激活右栏该会话的 trajectory tab**
//      （不再切换主视图），定位参数经 `TrajectoryFocusStore` 传递；
//   4. 桌面缺口的**如实登记**：图片授权读取通道与文件上传通道当前都不存在（恒 null / 如实失败）；
//   5. 会话头：桌面用 ConversationHeader（`getContextUsage` 等桌面 IPC 面），经共享席位的 `header` 缝注入。
import type { ReactNode } from 'react';
import {
  ConversationSeat as SharedConversationSeat,
  type ConversationSeatProps as SharedConversationSeatProps,
} from '@harness2/ui-shared/renderer/conversation/seat.js';
import type { UploadTransport } from '@harness2/ui-shared/renderer/conversation/composer/attachments.js';
import { ComposerChain } from '@harness2/ui-shared/renderer/conversation/composer/composer-chain.js';
import {
  createImageUrlCache,
  type ConversationImageReader,
  type ImageUrlCache,
} from '@harness2/ui-shared/renderer/conversation/views/image-url-cache.js';
import {
  ConversationStatusPanel,
  statusPanelHasContent,
} from '@harness2/ui-shared/renderer/conversation/status-panel/ConversationStatusPanel.js';
import { toolNavigation, type TrajectoryViewConsumer } from '@harness2/ui-shared/renderer/tool/index.js';
import { trajectoryTabId, sidePaneStore } from '@harness2/ui-shared/renderer/side-pane/index.js';
import { backgroundTasksPaneRequests } from './background-tasks-requests.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { store } from '../app-shared.js';
import {
  createComposerOverlayHost,
  createTrajectoryFocusStore,
  type ComposerOverlayHost,
  type TrajectoryFocusStore,
} from '../trajectory/index.js';

export {
  createConversationComposerPort,
  type ConversationComposerPort,
  type ConversationSession,
} from '@harness2/ui-shared/renderer/conversation/seat.js';

/**
 * D-46 的壳侧测量宿主（应用单例）：会话席位观察 composer 浮层真实高度并写 CSS 变量
 * `--composer-inset`（chat 转录的滚动叶容器消费）—— 一处测量、一处消费。
 */
export const conversationComposerOverlay: ComposerOverlayHost = createComposerOverlayHost();

/**
 * P2-5（D-86 ②）的定位通道（应用单例）：工具卡 inspect 的 `callId`/`seq` 经此到达右栏轨迹 tab，
 * 打开轨迹时选中并滚动到对应记录。一处写入（消费者）、一处读取（轨迹内容组件），只在内存。
 */
export const conversationTrajectoryFocus: TrajectoryFocusStore = createTrajectoryFocusStore();

/**
 * D-39 授权读取（宿主注入）。**缺口登记**：preload 暴露的 IPC 面（`Harness2Api`）没有图片/附件授权
 * 读取通道，`readFileForRef` / `getSnapshotForCall` 都只回文本快照、不是图片 URL 来源。
 * 故此处恒 null —— 视图拿不到图就显示占位，**绝不伪造 URL**；待主进程新增通道后只改这里。
 */
export const desktopConversationImageRead: ConversationImageReader = () => null;

/** 应用级图片 URL 缓存（会话内逐附件去重；右栏轨迹 tab 的附件预览走同一入口） */
export const conversationImageUrls: ImageUrlCache = createImageUrlCache({
  read: desktopConversationImageRead,
});

/**
 * 文件上传 transport。**缺口登记**：桌面桥没有上传 IPC（core/gateway 也没有上传端点），
 * 因此如实失败（不伪造 token）。文件仍会走 `FileUploadQueue`（并发 2、FIFO、失败不阻塞后续），
 * 失败项留在附件列表供重提 —— 待上传通道落地后只替换本对象。
 */
export const desktopUploadTransport: UploadTransport = {
  upload: async () => {
    throw new Error('未配置文件上传通道（主进程未暴露上传 IPC）');
  },
};

/** composer 链（D-38）：壳持有唯一实例；当前无 takeover 注册项（无人接管 = 默认 composer 常驻） */
export const conversationComposerChain = new ComposerChain();

/**
 * D-86 ②：把轨迹 tab 登记为 `inspect` 的消费者（P2-5 改道）。工具卡的「查看轨迹」由此真实可见并生效：
 *   * 未注册时 `toolNavigation.canInspect()` 为 false → 工具卡不渲染该入口（不摆死按钮）；
 *   * 已注册时点击 → 记下 `callId`/`seq` 定位请求（`TrajectoryFocusStore`）并**打开/激活右栏该
 *     会话的 trajectory tab**（Z-14 `model-trajectory:{sessionId}`；tab 状态在 side-pane 内存
 *     Map，D-14 不落盘）。右栏若收起，由 `SidePanel` 订阅同一焦点通道自动展开 —— 不静默丢请求。
 */
export function createTrajectoryInspectConsumer(focusStore?: TrajectoryFocusStore): TrajectoryViewConsumer {
  return {
    key: 'trajectory',
    open: (request) => {
      if (request.sessionId.length === 0) return;
      focusStore?.request(request);
      sidePaneStore.open(request.sessionId, trajectoryTabId(request.sessionId));
    },
  };
}

/** 应用级注册（disposer 导出供测试/热重载回收；正常生命周期与进程同寿） */
export const disposeTrajectoryInspect = toolNavigation.registerTrajectoryView(
  createTrajectoryInspectConsumer(conversationTrajectoryFocus),
);

/** 桌面会话头（共享席位经 `header` 缝注入；信息来自桌面 IPC 面） */
function desktopConversationHeader(info: { sessionId: string; cwd?: string }): ReactNode {
  return <ConversationHeader sessionId={info.sessionId} cwd={info.cwd} />;
}

/**
 * Z3-03（Z-17）：桌面会话状态面板（共享席位经 `statusPanel` 缝注入）。
 * 数据源 = 桌面单例 store 的 S7 只读视图缓存（planState / changeReview）+ 会话流任务表；
 * 有内容才渲染（statusPanelHasContent 与面板组件同一份数据口径）——无数据返回 null，
 * seat 的槽位包裹行整个不渲染，不留占位高度。
 * Z2-08 轻联动：Agents 子块的「在右栏打开」接到请求通道，右栏宿主（SidePanel）消费 ——
 * 打开/激活 background-tasks tab + 右栏收着就展开（不静默丢请求）。
 */
function desktopStatusPanel(info: { sessionId: string }): ReactNode {
  if (!statusPanelHasContent(store, info.sessionId)) return null;
  return (
    <ConversationStatusPanel
      store={store}
      sessionId={info.sessionId}
      onOpenTasksPane={() => backgroundTasksPaneRequests.request()}
    />
  );
}

/** 桌面侧入参：共享席位全部可省；缺省注入桌面单例（测试可显式覆盖） */
export type ConversationSeatProps = SharedConversationSeatProps;

/**
 * 会话席位（ui-conversation）：共享实现 + 桌面缺省注入（图片缓存 / composer 链 / 浮层宿主 /
 * 会话头 / 状态面板）。语义零改动：桌面既有调用点与测试的入参面不变。
 */
export function ConversationSeat(props: ConversationSeatProps): ReactNode {
  return (
    <SharedConversationSeat
      {...props}
      chain={props.chain ?? conversationComposerChain}
      composerOverlayHost={props.composerOverlayHost ?? conversationComposerOverlay}
      header={props.header ?? desktopConversationHeader}
      // Z3-03：状态面板（Z-17）——桌面缺省注入；测试可传 statusPanel 覆盖（与其他缝同一口径）
      statusPanel={props.statusPanel ?? desktopStatusPanel}
      // 桌面缺省文件上传通道：如实失败并给出**桌面侧**原因（主进程未暴露上传 IPC），
      // 与共享包的中性缺省文案不同 —— 保持桌面既有行为与既有测试断言不变。
      transport={props.transport ?? desktopUploadTransport}
    />
  );
}
