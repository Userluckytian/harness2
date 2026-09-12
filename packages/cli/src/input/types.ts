// types.ts — P1 统一输入层事件类型（渲染引擎无关：不依赖 ink/react/DOM/Node 特有 API）。
//
// 设计要点：
//  - 每个事件都带 `consumed` 字段：分发器（dispatcher.ts）在某个层级消费事件时置 true。
//    消费标记由分发器写入，解析器只产出 consumed=false 的新事件；上层据此判断是否需要
//    兜底处理（如 status bar 提示、未识别按键回显）。
//  - KeyEvent.modifiers 只保留终端能表达的三元修饰（shift/alt/ctrl）；
//    kitty CSI-u 的完整修饰位（super/hyper/meta/caps_lock）在解析时丢弃，仅保留
//    三元子集（终端协议编码见 kitty keyboard protocol 文档：shift=1 alt=2 ctrl=4 ...）。
//  - 鼠标列/行统一为 0 基整数（SGR/X10 报文是 1 基，解析器减一归一），避免上层各处 -1。
export interface KeyModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** kitty CSI-u 解码附带的编码信息（legacy 序列不存在该字段）。 */
export interface KittyKeyInfo {
  /** kitty unicode-key-code（可打印字符即 Unicode 码点；13=Enter 9=Tab 27=Esc 127=Backspace） */
  codepoint: number;
  /** kitty 事件类型：press（默认）/ repeat / release（CSI code;mods:event u 的第三段） */
  event?: 'press' | 'repeat' | 'release';
}

export interface KeyEvent {
  type: 'key';
  /** 规范键名（'enter' | 'tab' | 'backspace' | 'escape' | 'up' | 'down' | 'left' | 'right' |
   *  'home' | 'end' | 'insert' | 'delete' | 'pageup' | 'pagedown' | 'f1'..'f4'）；
   *  可打印字符（含中文等 UTF-8 文本）则为字符本体。 */
  key: string;
  modifiers: KeyModifiers;
  /** kitty CSI-u 编码信息；legacy 转义序列无此字段 */
  kitty?: KittyKeyInfo;
  /** 可打印字符时的文本（=== key）；控制键/功能键为 undefined */
  text?: string;
  /** 分发器消费标记（解析器恒产出 false） */
  consumed: boolean;
}

export type MouseEventKind = 'up' | 'down' | 'move' | 'scroll';

export interface MouseEvent {
  type: 'mouse';
  kind: MouseEventKind;
  /** 0 基按钮号；kind='scroll' 时 0=滚轮上、1=滚轮下；move 事件沿用来源按钮位（无则 0） */
  button: number;
  /** 0 基列（SGR/X10 的 1 基 x 减一） */
  col: number;
  /** 0 基行（SGR/X10 的 1 基 y 减一） */
  row: number;
  modifiers: KeyModifiers;
  /** 分发器消费标记（解析器恒产出 false） */
  consumed: boolean;
}

export interface FocusEvent {
  type: 'focus';
  /** 'in' = 终端窗口获得焦点（CSI I）；'out' = 失焦（CSI O） */
  direction: 'in' | 'out';
  /** 分发器消费标记（解析器恒产出 false） */
  consumed: boolean;
}

export interface PasteEvent {
  type: 'paste';
  /** bracketed paste 的原样聚合文本（不做 CRLF 归一——归一是 paste.ts 的职责，保持分层） */
  text: string;
  /** 分发器消费标记（解析器恒产出 false） */
  consumed: boolean;
}

export type InputEvent = KeyEvent | MouseEvent | FocusEvent | PasteEvent;

/** 构造一个零修饰的空 modifiers（解析器内部用）。 */
export function noModifiers(): KeyModifiers {
  return { shift: false, alt: false, ctrl: false };
}

/** 修饰位码 → KeyModifiers（bit0=shift, bit1=alt, bit2=ctrl；bit3 以上 kitty 扩展丢弃）。 */
export function modifiersFromBits(bits: number): KeyModifiers {
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}
