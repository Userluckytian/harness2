// 带水位增量（S0/S3 契约）的客户端接收判定：纯逻辑，与 core WatermarkCursor 同语义。
// 职责：丢弃「重复/重叠（迟到 offset）」与「缺口（超前 offset）」的块——调用方只把
// 判定通过的块拼进在途文本。首块必须 offset==0；续块必须 offset == 上一块 offset + 上一块长度。
// 红线：这里只做展示投影的连续性判定；不写任何事件、不改模型上下文。

export interface DeltaWatermark {
  /** 上一块起始偏移 */
  offset: number;
  /** 上一块文本长度（UTF-16 code unit，与 core 一致） */
  length: number;
}

/** 判定并登记一块 delta；不连续（重复/重叠/缺口/非法 offset）→ null（调用方丢弃） */
export function acceptDelta(
  prev: DeltaWatermark | undefined,
  chunkOffset: number,
  text: string,
): DeltaWatermark | null {
  if (!Number.isInteger(chunkOffset) || chunkOffset < 0) return null;
  if (prev === undefined) {
    if (chunkOffset !== 0) return null; // 首块必须从 0 开始
    return { offset: 0, length: text.length };
  }
  if (chunkOffset !== prev.offset + prev.length) return null; // 重复/重叠/缺口
  return { offset: chunkOffset, length: text.length };
}
