// image-paste.ts — P2-B：图片粘贴键位契约 + 图片载荷接口（G-12）。
//
// 规格依据：docs/refs/refs-grok-build.md G-12——Windows 用 **Alt+V**（`Ctrl+V` 被终端占）；
// Linux 区分 PRIMARY / CLIPBOARD（`Shift+Insert` 走 PRIMARY）；拖拽亦可。
//
// 🟡 登记（G-12 部分）：本模块只落**键位契约与载荷/接收方接口**；真实剪贴板读取与终端
// 透传（OSC 52 / kitty graphics / sixel / SGR 2004 之外的图片通道都是终端私有能力）
// 依赖真机差异，下放 P7 / 真机清单（docs/ai-framework/plans/2026-09-13-terminal-real-machine-checklist.md）。
// 本阶段不做假入口：不读剪贴板、不发 ANSI 图片序列。
//
// 与 keymaps.ts 的关系：Alt+V 和弦已登记在 SIMPLE_KEYMAP / VIM_KEYMAP（action 'paste.image'）；
// 本文件导出同一和弦的常量副本供不走键位表的装配层（如旧壳通道）直接引用，两处必须一致
// （一致性有测试锁住）。
import type { Chord } from './keymaps.js';

/** G-12 图片粘贴和弦（Windows 口径）：Alt+V。与 keymaps.ts 'paste.image' 绑定一致。 */
export const IMAGE_PASTE_CHORD: Chord = { key: 'v', alt: true };

/** 图片来源（G-12 的三条入口；'primary-selection' 仅 Linux） */
export type ImagePasteSource = 'clipboard' | 'primary-selection' | 'file-drop';

/** 一张待注入的图片载荷（字节不解码、不重编码，原样透传给模型侧编码器） */
export interface ImagePayload {
  /** MIME 类型（'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'；未知用 'application/octet-stream'） */
  readonly mimeType: string;
  /** 原始字节（编码后图片数据，如 PNG 文件字节；非裸像素） */
  readonly data: Uint8Array;
  /** 来源通道（G-12） */
  readonly source: ImagePasteSource;
  /** 可选文件名（拖拽入口带；剪贴板通常无） */
  readonly fileName?: string;
}

/** 图片接收方接口（接收方注入——接线层实现，通常落到 composer 的图片 chip 列表）。
 * 返回 false = 拒收（不支持该类型 / chip 容量满 / 无附件能力），调用方据此给提示。 */
export interface ImagePasteSink {
  acceptImage(image: ImagePayload): boolean;
}

/** 本阶段支持的图片 MIME（与主流模型多模态输入对齐；不在表内的载荷由 sink 拒收） */
export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** MIME 是否在支持列表（大小写不敏感；参数段忽略，'image/png; charset=x' 判 true） */
export function isSupportedImageMime(mimeType: string): boolean {
  const bare = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return SUPPORTED_IMAGE_MIME_TYPES.includes(bare);
}

/** 平台键位与入口差异（G-12 数据化；供状态行 / cheatsheet / 文档用） */
export interface ImagePastePlatformNote {
  readonly platform: 'windows' | 'linux' | 'macos';
  /** 主和弦（写入 keymaps 表的那条） */
  readonly primaryChord: string;
  /** 平台差异说明 */
  readonly notes: readonly string[];
}

export const IMAGE_PASTE_PLATFORM_NOTES: readonly ImagePastePlatformNote[] = [
  {
    platform: 'windows',
    primaryChord: 'Alt+V',
    notes: ['Ctrl+V 被终端占（本地粘贴语义），图片粘贴用 Alt+V（G-12）'],
  },
  {
    platform: 'linux',
    primaryChord: 'Alt+V',
    notes: ['区分 PRIMARY / CLIPBOARD 两套选择区', 'Shift+Insert 走 PRIMARY（G-12）', '拖拽亦可（G-12）'],
  },
  {
    platform: 'macos',
    primaryChord: 'Alt+V',
    notes: ['Ctrl+V 在部分终端族同样被占，统一 Alt+V 口径', '拖拽亦可（G-12）'],
  },
];

/** 按平台取键位说明（未知平台回退 windows 口径） */
export function imagePasteNoteFor(platform: string): ImagePastePlatformNote {
  return IMAGE_PASTE_PLATFORM_NOTES.find((n) => n.platform === platform) ?? IMAGE_PASTE_PLATFORM_NOTES[0]!;
}
