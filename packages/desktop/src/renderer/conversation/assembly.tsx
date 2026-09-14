// assembly.tsx — 桌面**组装根**：把桌面专属能力注入共享会话席位（`@harness2/ui-shared`）。
//
// 实现在共享包（`renderer/conversation/seat.tsx`：视图环 + 常驻 composer + 提交边界 + 草稿隔离），
// 本文件只剩「桌面侧的决定」，不重新实现任何业务语义：
//   1. 视图注册表：注册**真实存在**的视图 —— `chat`（共享转录渲染，D-30/D-32）+ `trajectory`
//      （桌面 P6-A `ui-trajectory`，D-40：视图环里的 Trajectory 标签页，不是弹窗）；
//   2. 视图选择持久缝（D-31/D-14）：桌面用**内存**实现 —— 不碰任何浏览器端持久化存储
//      （`test/layout/no-persistence` 有反向守卫）；保留 `subscribe` 让环外改写（D-86 ② inspect
//      跳轨迹）即时生效，无持久源时按规则回落 `chat`；
//   3. D-46 浮层测量宿主单例 + D-86 ② 轨迹定位通道单例（桌面专属消费者）；
//   4. 桌面缺口的**如实登记**：图片授权读取通道与文件上传通道当前都不存在（恒 null / 如实失败）；
//   5. 会话头：桌面用 ConversationHeader（`getContextUsage` 等桌面 IPC 面），经共享席位的 `header` 缝注入。
import type { ReactNode } from 'react';
import {
  ConversationChatView,
  ConversationSeat as SharedConversationSeat,
  type ConversationSeatProps as SharedConversationSeatProps,
  type ConversationSession,
} from '@harness2/ui-shared/renderer/conversation/seat.js';
import type { UploadTransport } from '@harness2/ui-shared/renderer/conversation/composer/attachments.js';
import { ComposerChain } from '@harness2/ui-shared/renderer/conversation/composer/composer-chain.js';
import {
  createImageUrlCache,
  type ConversationImageReader,
  type ImageUrlCache,
} from '@harness2/ui-shared/renderer/conversation/views/image-url-cache.js';
import { CHAT_VIEW_KEY } from '@harness2/ui-shared/renderer/conversation/views/view-selection.js';
import {
  createConversationViewRegistry as createViewRegistry,
  type ConversationViewRegistry,
} from '@harness2/ui-shared/renderer/conversation/views/view-registry.js';
import { createInMemoryPersistence, type Persistence } from '@harness2/ui-shared/renderer/ports.js';
import { toolNavigation, type TrajectoryViewConsumer } from '@harness2/ui-shared/renderer/tool/index.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import {
  TRAJECTORY_VIEW_KEY,
  createComposerOverlayHost,
  createTrajectoryFocusStore,
  createTrajectoryViewDefinition,
  type ComposerOverlayHost,
  type TrajectoryFocusStore,
} from '../trajectory/index.js';

export {
  CONVERSATION_CHAT_OWNER,
  ConversationChatView,
  createConversationComposerPort,
  type ConversationComposerPort,
  type ConversationSession,
} from '@harness2/ui-shared/renderer/conversation/seat.js';

/** 注册表装配可选项（P6 接线棒：D-46 的浮层测量宿主按需注入） */
export interface DesktopViewRegistryOptions {
  /** D-46：壳持有的 composer 浮层测量宿主（交给轨迹视图读实测预留高度） */
  readonly composerHost?: ComposerOverlayHost;
  /** P2-5：D-86 ② inspect 的定位通道（交给轨迹视图定位 callId/seq 对应记录） */
  readonly focusStore?: TrajectoryFocusStore;
}

/**
 * 会话视图注册表：只注册**真实存在**的视图 —— `chat`（共享转录）+ `trajectory`
 * （桌面 `ui-trajectory`，D-40）。注册顺序 = 标签顺序。
 */
export function createDesktopConversationViewRegistry(
  options: DesktopViewRegistryOptions = {},
): ConversationViewRegistry<ConversationSession> {
  const registry = createViewRegistry<ConversationSession>();
  registry.register({
    key: CHAT_VIEW_KEY,
    title: 'Chat',
    owner: 'ui-chat',
    component: ConversationChatView,
  });
  registry.register(
    createTrajectoryViewDefinition<ConversationSession>({
      ...(options.composerHost !== undefined ? { composerHost: options.composerHost } : {}),
      ...(options.focusStore !== undefined ? { focusStore: options.focusStore } : {}),
    }),
  );
  return registry;
}

/**
 * D-46 的壳侧测量宿主（应用单例）：会话席位观察 composer 浮层真实高度，
 * 轨迹视图经 `useComposerOverlayInset` 读同一条状态 —— 一处测量、两处消费。
 */
export const conversationComposerOverlay: ComposerOverlayHost = createComposerOverlayHost();

/**
 * P2-5（D-86 ②）的定位通道（应用单例）：工具卡 inspect 的 `callId`/`seq` 经此到达轨迹视图，
 * 打开轨迹时选中并滚动到对应记录。一处写入（消费者）、一处读取（轨迹视图），只在内存。
 */
export const conversationTrajectoryFocus: TrajectoryFocusStore = createTrajectoryFocusStore();

/** 应用级视图注册表（渲染端单例；与 shellSlots 同层） */
export const conversationViewRegistry = createDesktopConversationViewRegistry({
  composerHost: conversationComposerOverlay,
  focusStore: conversationTrajectoryFocus,
});

/**
 * 视图选择持久缝（D-31 / D-14）：**内存**实现 —— 只在本进程存活期内记住每个会话的选择。
 * 刻意不落浏览器存储（D-14 明令）；要跨重启持久须由宿主另注入实现。实现来自共享包端口工厂。
 */
export function createInMemoryViewSelectionPersistence(): Persistence {
  return createInMemoryPersistence();
}

export const conversationViewPersistence: Persistence = createInMemoryViewSelectionPersistence();

/**
 * D-86 ②：把轨迹视图登记为 `inspect` 的消费者。工具卡的「查看轨迹」由此真实可见并生效：
 *   * 未注册时 `toolNavigation.canInspect()` 为 false → 工具卡不渲染该入口（不摆死按钮）；
 *   * 已注册时点击 → 记下 `callId`/`seq` 定位请求（P2-5）并把**该会话**的视图选择写成 `trajectory`，
 *     视图环经 `subscribe` 即时切过去（不伪造点击、不新开第二个详情视图）。
 */
export function createTrajectoryInspectConsumer(
  persistence: Persistence,
  viewKey: string = TRAJECTORY_VIEW_KEY,
  focusStore?: TrajectoryFocusStore,
): TrajectoryViewConsumer {
  return {
    key: viewKey,
    open: (request) => {
      if (request.sessionId.length === 0) return;
      focusStore?.request(request);
      persistence.write(request.sessionId, viewKey);
    },
  };
}

/** 应用级注册（disposer 导出供测试/热重载回收；正常生命周期与进程同寿） */
export const disposeTrajectoryInspect = toolNavigation.registerTrajectoryView(
  createTrajectoryInspectConsumer(conversationViewPersistence, TRAJECTORY_VIEW_KEY, conversationTrajectoryFocus),
);

/**
 * D-39 授权读取（宿主注入）。**缺口登记**：preload 暴露的 IPC 面（`Harness2Api`）没有图片/附件授权
 * 读取通道，`readFileForRef` / `getSnapshotForCall` 都只回文本快照、不是图片 URL 来源。
 * 故此处恒 null —— 视图拿不到图就显示占位，**绝不伪造 URL**；待主进程新增通道后只改这里。
 */
export const desktopConversationImageRead: ConversationImageReader = () => null;

/** 应用级图片 URL 缓存（会话内逐附件去重；Chat 与 Trajectory 共用同一入口） */
export const conversationImageUrls: ImageUrlCache = createImageUrlCache({ read: desktopConversationImageRead });

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

/** 桌面会话头（共享席位经 `header` 缝注入；信息来自桌面 IPC 面） */
function desktopConversationHeader(info: { sessionId: string; cwd?: string }): ReactNode {
  return <ConversationHeader sessionId={info.sessionId} cwd={info.cwd} />;
}

/** 桌面侧入参：共享席位除 `registry` 外都可省；注册表缺省取桌面单例（测试可显式注入） */
export type ConversationSeatProps = Omit<SharedConversationSeatProps, 'registry'> & {
  readonly registry?: ConversationViewRegistry<ConversationSession>;
};

/**
 * 会话席位（ui-conversation）：共享实现 + 桌面缺省注入（注册表 / 持久缝 / 图片缓存 / composer 链 /
 * 浮层宿主 / 会话头）。语义零改动：桌面既有调用点与测试的入参面不变。
 */
export function ConversationSeat(props: ConversationSeatProps): ReactNode {
  return (
    <SharedConversationSeat
      {...props}
      registry={props.registry ?? conversationViewRegistry}
      persistence={props.persistence ?? conversationViewPersistence}
      imageUrls={props.imageUrls ?? conversationImageUrls}
      chain={props.chain ?? conversationComposerChain}
      composerOverlayHost={props.composerOverlayHost ?? conversationComposerOverlay}
      header={props.header ?? desktopConversationHeader}
      // 桌面缺省文件上传通道：如实失败并给出**桌面侧**原因（主进程未暴露上传 IPC），
      // 与共享包的中性缺省文案不同 —— 保持桌面既有行为与既有测试断言不变。
      transport={props.transport ?? desktopUploadTransport}
    />
  );
}
