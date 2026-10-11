// 分屏拖拽载荷（Z-19）：左侧会话行 → 主区分屏格的模块级在途状态。
//
// 为什么还要一份模块级回退：HTML5 DnD 的 `dataTransfer` 在 jsdom 里不是标准实现
// （`fireEvent` 默认不带 dataTransfer），单测无法只靠它验证「拖入生成第二格」。
// 生产路径**优先** dataTransfer（真实 DnD 语义），模块级载荷是等价回退，两者写入同一会话 id。
let dragging: string | null = null;

export const workbenchDrag = {
  /** 拖拽开始：登记在途会话 id */
  begin(sessionId: string): void {
    dragging = sessionId;
  },
  /** 拖拽结束（drop 或 dragend）：清空在途 */
  end(): void {
    dragging = null;
  },
  /** 当前在途会话 id（无则 null） */
  current(): string | null {
    return dragging;
  },
};
