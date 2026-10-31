// 入站文本安全过滤（飞书/QQ 适配器共用）。
// 漏洞 #309 修复：入站 content 增加控制字符/长度上限过滤——此前飞书 text 原样 trim 后
// 进入 agent 会话，本地伪造事件可注入任意文本（含控制字符/超长文本）；QQ 同理。

/** 入站文本长度上限（按 code point 计，超限截断） */
export const MAX_INBOUND_TEXT_LENGTH = 4000;

/**
 * 剥离控制字符（保留制表符与换行），并截断到 MAX_INBOUND_TEXT_LENGTH。
 * 覆盖：C0（\x00-\x08、\x0b-\x1f）、C1（\x7f-\x9f）、
 * 零宽/双向控制（\u200b-\u200f、\u202a-\u202e、\u2060-\u2064、\ufeff）。
 */
export function sanitizeInboundText(raw: string): string {
  const stripped = raw
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .trim();
  if (stripped.length <= MAX_INBOUND_TEXT_LENGTH) return stripped;
  // 按 code point 截断，避免切断代理对产生非法字符
  return Array.from(stripped).slice(0, MAX_INBOUND_TEXT_LENGTH).join('');
}
