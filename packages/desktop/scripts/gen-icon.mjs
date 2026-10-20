// Z-47 托盘/任务栏图标生成器：手写像素点阵（5x7 字体 ×缩放），产出标准 32bpp BMP-ICO
// （16/32/48 三档，含 AND 掩码；Windows 通知区域高 DPI 下不糊）。
// 用法：node packages/desktop/scripts/gen-icon.mjs  → 写 packages/desktop/assets/icon.ico
// 产物入库（构建不依赖 node-canvas/sharp 等图像库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// —— 字形点阵（5 列 × 7 行，'#' = 前景）——
const H = ['    #', '    #', ' ## #', '## ###', '#   #', '#   #', '#    '];
const TWO = [' ### ', '#   #', '   # ', '  #  ', ' #   ', '#    ', '#####'];

const BG = [0x16, 0x16, 0x16]; // zai-dark 底（与窗口底色一致）
const FG = [0xf8, 0xf8, 0xf8]; // 前景

/** 把两枚字形画进 size×size 网格：scale × 5×7 字形 + 2 列字距，整体居中 */
function render(size, scale) {
  const gw = 5 * scale;
  const gh = 7 * scale;
  const totalW = gw * 2 + scale; // 字距 = 1 个 scale 单位
  const ox = Math.max(0, Math.floor((size - totalW) / 2));
  const oy = Math.max(0, Math.floor((size - gh) / 2));
  const px = new Array(size * size).fill(null); // null = 透明
  const put = (x, y, c) => {
    if (x >= 0 && x < size && y >= 0 && y < size) px[y * size + x] = c;
  };
  const glyph = (g, gx) => {
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if ((g[r] ?? '')[col] !== '#') continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) put(gx + col * scale + sx, oy + r * scale + sy, FG);
      }
    }
  };
  // 底板：整个网格先铺深色（不透明圆角感：四角各挖 scale×scale）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const corner =
        (x < scale && y < scale) ||
        (x >= size - scale && y < scale) ||
        (x < scale && y >= size - scale) ||
        (x >= size - scale && y >= size - scale);
      if (!corner) put(x, y, BG);
    }
  }
  glyph(H, ox);
  glyph(TWO, ox + gw + scale);
  return px;
}

/** 单尺寸 BMP 体：BITMAPINFOHEADER(高×2) + BGRA 自底向上像素 + 1bpp AND 掩码 */
function bmpEntry(size, px) {
  const header = Buffer.alloc(40);
  header.writeInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 双高
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = px[y * size + x];
      const o = ((size - 1 - y) * size + x) * 4;
      if (c === null) {
        body.writeUInt32LE(0, o); // 全 0 = 透明
      } else {
        body[o] = c[2]; // B
        body[o + 1] = c[1]; // G
        body[o + 2] = c[0]; // R
        body[o + 3] = 255; // A
      }
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size); // 全 0 = 不显示 AND 掩码（用 alpha）
  return Buffer.concat([header, body, mask]);
}

function ico(sizes) {
  const entries = sizes.map(({ size, scale }) => ({ size, data: bmpEntry(size, render(size, scale)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    d.writeUInt8(0, 2);
    d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4); // planes（BMP 条目惯例）
    d.writeUInt16LE(32, 6); // bitCount
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    return d;
  });
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets', 'icon.ico');
mkdirSync(dirname(out), { recursive: true });
const buf = ico([
  { size: 16, scale: 1 },
  { size: 24, scale: 2 },
  { size: 32, scale: 2 },
  { size: 48, scale: 3 },
  // electron-builder win.icon 最低要求 256×256（exe/任务栏用）；托盘取 16/24/32/48 档
  { size: 256, scale: 10 },
]);
writeFileSync(out, buf);
console.log(`icon written: ${out} (${buf.length} bytes)`);
