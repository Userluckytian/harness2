// prefill.ts — composer 引用预填请求通道（Z4-02 文件行内评论 / Z4-03 转录划词「询问」）。
//
// 为什么是通道而不是直接调 store/controller：composer 的**活草稿 store**（ComposerStore）
// 只存在于 `ConversationSeat` 内部（D-33 每会话一个、换会话换绑），而预填入口分散在
// 右栏文件 tab（desktop SidePanel）与转录（ui-shared ChatTranscript）——两者都够不到
// 那个 store 实例。通道把「请求」与「消费」解耦：
//   生产：入口组件 `request({ sessionId, quote, focus })`（quote 已由 shared/quote-block 构造好）；
//   消费：ConversationSeat 订阅通道，把 quote **追加**进本席位会话的活草稿 —— 与建议 chip
//         同一条编辑原语（`insert-text`，composer-state），随后由 seat 既有订阅经
//         `controller.setDraft` 落盘。不是只写持久层（那条路活 composer 不可见）。
//
// 与 backgroundTasksPaneRequests 的快照通道（引用判新）不同，这里用**事件式监听 +
// nonce 消费去重**：同一会话可能有两个席位（Z2-06 分屏把同一会话绑进两格），快照判新
// 无法让两个消费者商定「谁消费」；nonce 的首个 `consume()` 返回 true，其余席位据此跳过。
//
// 只在内存、只在进程内（D-14：不落任何浏览器存储）。

/** 一次预填请求（quote 为已构造好的引用块文本；nonce 由通道分配） */
export interface ComposerPrefillRequest {
  /** 目标会话（只有绑定该会话的席位消费） */
  readonly sessionId: string;
  /** 引用块文本（shared/quote-block 的产物；空串请求不消费） */
  readonly quote: string;
  /** 是否在预填后把焦点交回 composer（Z4-03 划词要；Z4-02 评论不要） */
  readonly focus: boolean;
  /** 单调递增；消费去重的唯一依据 */
  readonly nonce: number;
}

export interface ComposerPrefillChannel {
  /** 发一次预填请求（同步通知所有订阅席位；返回带 nonce 的完整请求） */
  request(req: Omit<ComposerPrefillRequest, 'nonce'>): ComposerPrefillRequest;
  /** 订阅（事件式：监听器直接收到请求载荷；返回退订函数） */
  subscribe(listener: (req: ComposerPrefillRequest) => void): () => void;
  /**
   * 消费一个 nonce：**首个**调用者返回 true（应当事），同一 nonce 的后续调用返回 false
   * （同会话多席位 / 重复通知据此去重，绝不重复插入）。
   */
  consume(nonce: number): boolean;
}

export function createComposerPrefillChannel(): ComposerPrefillChannel {
  let nonce = 0;
  let lastConsumed = 0;
  const listeners = new Set<(req: ComposerPrefillRequest) => void>();
  return {
    request(req) {
      nonce += 1;
      const full: ComposerPrefillRequest = { ...req, nonce };
      for (const listener of [...listeners]) listener(full);
      return full;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    consume(n) {
      // nonce 严格递增且消费只发生在 request 的同步通知里 → 与 lastConsumed 比较即可
      if (n <= lastConsumed) return false;
      lastConsumed = n;
      return true;
    },
  };
}

/** 应用单例（入口组件生产、ConversationSeat 消费共用同一条内存态） */
export const composerPrefill: ComposerPrefillChannel = createComposerPrefillChannel();

/**
 * 追加语义（Z4-02 交付口径）：预填**追加而非覆盖**；非空草稿先空一行分隔（'\n\n'）。
 * 空白草稿（含纯空白字符）视同空草稿 → 直接引块开头，不留噪声前缀。
 * 返回「应插入到草稿末尾」的文本；空串 = 无可插入内容（调用方跳过派发）。
 */
export function prefillAppendText(existingDraft: string, quote: string): string {
  if (quote.length === 0) return '';
  return existingDraft.trim().length === 0 ? quote : `\n\n${quote}`;
}
