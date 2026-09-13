// image-paste 单测：G-12 Alt+V 键位契约、载荷/接收方接口、MIME 守卫、平台说明表。
import { describe, expect, it } from 'vitest';
import { noModifiers, type KeyEvent } from '../../../src/input/types.js';
import { SIMPLE_KEYMAP, VIM_KEYMAP, chordMatches } from '../../../src/tui/input/keymaps.js';
import {
  IMAGE_PASTE_CHORD,
  IMAGE_PASTE_PLATFORM_NOTES,
  type ImagePasteSink,
  isSupportedImageMime,
  imagePasteNoteFor,
} from '../../../src/tui/input/image-paste.js';

function altKeyEvent(key: string): KeyEvent {
  return { type: 'key', key, modifiers: { ...noModifiers(), alt: true }, consumed: false };
}

describe('G-12 键位契约：Alt+V（Windows；Ctrl+V 被终端占）', () => {
  it('IMAGE_PASTE_CHORD 与两套键位表的 paste.image 绑定一致（跨文件一致性）', () => {
    for (const table of [SIMPLE_KEYMAP, VIM_KEYMAP]) {
      const binding = table.find((b) => b.action === 'paste.image')!;
      expect(binding.chords).toEqual([IMAGE_PASTE_CHORD]);
    }
  });

  it('legacy 编码（\x1bv → key=v + alt 位）命中；裸 v / 大写 V 不命中', () => {
    expect(chordMatches(IMAGE_PASTE_CHORD, altKeyEvent('v'))).toBe(true);
    expect(chordMatches(IMAGE_PASTE_CHORD, { ...altKeyEvent('v'), modifiers: noModifiers() })).toBe(false);
    expect(chordMatches(IMAGE_PASTE_CHORD, altKeyEvent('V'))).toBe(false);
  });
});

describe('G-12 图片载荷与接收方接口', () => {
  it('sink 契约：接收方注入，acceptImage 返回是否接收（true 落 chip / false 拒收给提示）', () => {
    const received: string[] = [];
    const sink: ImagePasteSink = {
      acceptImage(image) {
        if (!isSupportedImageMime(image.mimeType)) return false;
        received.push(image.fileName ?? image.mimeType);
        return true;
      },
    };
    expect(sink.acceptImage({ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]), source: 'clipboard' })).toBe(
      true,
    );
    expect(
      sink.acceptImage({
        mimeType: 'image/jpeg',
        data: new Uint8Array([9]),
        source: 'file-drop',
        fileName: 'cat.jpg',
      }),
    ).toBe(true);
    expect(sink.acceptImage({ mimeType: 'text/plain', data: new Uint8Array([1]), source: 'clipboard' })).toBe(false);
    expect(received).toEqual(['image/png', 'cat.jpg']);
  });

  it('MIME 守卫：支持列表四类；大小写不敏感、参数段忽略；未知类型拒绝', () => {
    expect(isSupportedImageMime('image/png')).toBe(true);
    expect(isSupportedImageMime('image/jpeg')).toBe(true);
    expect(isSupportedImageMime('image/gif')).toBe(true);
    expect(isSupportedImageMime('image/webp')).toBe(true);
    expect(isSupportedImageMime('IMAGE/PNG')).toBe(true);
    expect(isSupportedImageMime('image/png; charset=binary')).toBe(true);
    expect(isSupportedImageMime('text/plain')).toBe(false);
    expect(isSupportedImageMime('application/octet-stream')).toBe(false);
  });
});

describe('G-12 平台差异说明表（数据化）', () => {
  it('三平台条目齐备；Windows 主口径 Alt+V 并注明 Ctrl+V 被占', () => {
    const win = imagePasteNoteFor('windows');
    expect(win.primaryChord).toBe('Alt+V');
    expect(win.notes.join('\n')).toContain('Ctrl+V 被终端占');
    expect(IMAGE_PASTE_PLATFORM_NOTES.map((n) => n.platform)).toEqual(['windows', 'linux', 'macos']);
  });

  it('Linux 条目含 PRIMARY / CLIPBOARD 区分与 Shift+Insert 走 PRIMARY（G-12 原文要点）', () => {
    const linux = imagePasteNoteFor('linux');
    const text = linux.notes.join('\n');
    expect(text).toContain('PRIMARY');
    expect(text).toContain('CLIPBOARD');
    expect(text).toContain('Shift+Insert');
  });

  it('未知平台回退 windows 口径', () => {
    expect(imagePasteNoteFor('haiku').platform).toBe('windows');
  });
});
