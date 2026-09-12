// dispatcher.ts — P1 统一输入层的事件分发器（纯逻辑，零 ink/react 依赖，可单测）。
//
// 职责：把 parser 产出的语义事件按**层级优先级**逐层投递；某层返回 true = 消费
// （事件停止下传，event.consumed 置 true）；返回 false = 未消费（传给下一层）；
// 全部层未消费时调用 fallback 兜底（如全局快捷键、状态栏提示、回显），dispatch 返回 false。
//
// 默认优先级（数组头部最高）：overlay > approval card > composer > scrollback。
//   - overlay：命令面板/帮助/模式选择等浮层（存在时互斥接管键盘）；
//   - approval：审批确认卡（ConfirmDialog 等阻塞式卡片）；
//   - composer：草稿输入框（普通字符、光标移动、历史）；
//   - scrollback：转录浏览（滚动、折叠、复制）。
// 顺序可配置：layers 数组即优先级，调用方可增删/重排层级（P2 渲染层复用时按需装配）。
//
// FocusEvent 焦点路由说明：
//   终端焦点事件（CSI I / CSI O，focus-events 1004）表达的是「终端窗口失焦/回焦」，
//   不是应用内层级的焦点切换——应用内焦点属于各层自己的状态。因此默认按普通级联分发；
//   若装配方希望焦点事件只送达某个明确的层（如只在 composer 里暂停闪烁光标），
//   传 `focusTarget: '<层名>'`：FocusEvent 只投递给该层，其余层不收到；指定层不存在时
//   退回普通级联。KeyEvent/MouseEvent/PasteEvent 不受 focusTarget 影响，恒按级联分发。
import type { InputEvent } from './types.js';

/** 默认层级顺序（数组头部优先级最高）。 */
export const DEFAULT_LAYER_ORDER = ['overlay', 'approval', 'composer', 'scrollback'] as const;

export interface InputLayer {
  /** 层名（诊断与 focusTarget 路由用） */
  name: string;
  /** 处理事件：true = 消费（停止下传），false = 未消费（传下一层） */
  handle: (event: InputEvent) => boolean;
}

export interface InputDispatcherOptions {
  /** 按优先级排列的层级（数组头部最先收到事件）；缺省 = overlay/approval/composer/scrollback */
  layers?: InputLayer[];
  /** 全部层未消费时的兜底（不返回值；是否「兜底也消费」由调用方依据 dispatch 返回值决定） */
  fallback?: (event: InputEvent) => void;
  /** 焦点事件（FocusEvent）的定向路由目标层名；缺省按普通级联分发（见文件头说明） */
  focusTarget?: string;
}

export interface InputDispatcher {
  /** 分发一个事件；返回是否被某层消费（消费时 event.consumed 已置 true） */
  dispatch: (event: InputEvent) => boolean;
  /** 当前层名顺序（诊断/测试用） */
  layers: () => readonly string[];
}

export function createInputDispatcher(options: InputDispatcherOptions = {}): InputDispatcher {
  const layers: readonly InputLayer[] =
    options.layers ??
    DEFAULT_LAYER_ORDER.map((name) => ({
      name,
      handle: () => false, // 默认层为空实现：全不消费 → fallback
    }));
  const fallback = options.fallback;

  function dispatch(event: InputEvent): boolean {
    // 焦点定向路由：focusTarget 指定时 FocusEvent 只投递给该层
    if (event.type === 'focus' && options.focusTarget !== undefined) {
      const target = layers.find((l) => l.name === options.focusTarget);
      if (target !== undefined) {
        const consumed = target.handle(event);
        if (consumed) event.consumed = true;
        else fallback?.(event);
        return consumed;
      }
      // 指定层不存在 → 退回普通级联（继续往下走）
    }
    for (const layer of layers) {
      if (layer.handle(event)) {
        event.consumed = true;
        return true;
      }
    }
    fallback?.(event);
    return false;
  }

  return {
    dispatch,
    layers: () => layers.map((l) => l.name),
  };
}
