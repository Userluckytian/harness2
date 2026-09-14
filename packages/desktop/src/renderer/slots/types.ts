// slot 系统类型（D-01：声明式席位注册表；D-02：功能包带类型化 props 填席）。
// 三类席位：
//   single —— 同席位只保留一份（后注册/高优先级者接管，用于「可被包接管」的槽，如 sidebar.brand）
//   keyed  —— 按 key 注册（拒重复 key、保注册顺序；保留 key 只能由声明者注入，如 main 的 conversation）
//   list   —— 有序多份（order 升序，同 order 按注册顺序；如 shell.overlay 的多层覆层）
import type { ComponentType } from 'react';

/** 席位类型（D-01 的 single / keyed / list 三态） */
export type SeatKind = 'single' | 'keyed' | 'list';

/** 席位声明：由壳（或能力包）先声明，再允许注入内容 */
export interface SeatDeclaration {
  /** 席位的全局唯一 id（点分命名，如 'main' / 'shell.overlay'） */
  readonly id: string;
  readonly kind: SeatKind;
  /** 声明者标识（D-02：能力包名；保留 key 只接受声明者注入） */
  readonly owner: string;
  /** keyed 席位的合法 key 集合；不填 = 不限（保留 key 仍需由声明者注入） */
  readonly keys?: readonly string[];
  /** 保留 key：语义由壳定义、只能由声明者 owner 注入（如 main 的 'conversation' = 会话界面） */
  readonly reservedKeys?: readonly string[];
  /** 人类可读说明（文档/调试用） */
  readonly description?: string;
}

/** 席位贡献：一个功能包往某个席位注入的一份内容（带类型化 props） */
export interface SlotContribution<P extends object = Record<string, never>> {
  /** 目标席位 id（必须已声明） */
  readonly seat: string;
  /** 注入方标识（D-02：每个 UI 能力一个包名） */
  readonly owner: string;
  /** keyed 席位必填；single/list 忽略 */
  readonly key?: string;
  /** single 席位抢占优先级（大者胜；同级后注册者胜 → 「接管」语义） */
  readonly priority?: number;
  /** list 席位排序（升序；相同按注册顺序） */
  readonly order?: number;
  readonly component: ComponentType<P>;
  /** 传给 component 的 props（与 P 类型一致 —— D-02 的「类型化 props」） */
  readonly props?: P;
}

/** 类型擦除后的登记项：渲染闭包 + 元数据（React 绑定只认这个形状） */
export interface SlotEntry {
  readonly seat: string;
  readonly owner: string;
  readonly key: string | null;
  readonly priority: number;
  readonly order: number;
  /** 注册序号（同优先级/同 order 的稳定次序依据） */
  readonly seq: number;
  /**
   * 渲染该贡献（注入时捕获的静态 props + 宿主当帧给的 ownerProps）。
   * @param ownerProps - 席位宿主按几何/当帧事实补传的 props（如右栏的 width / canShow），
   *   覆盖同名静态 props；缺省则只用注入时捕获的 props。
   */
  readonly render: (ownerProps?: Readonly<Record<string, unknown>>) => React.ReactNode;
}
