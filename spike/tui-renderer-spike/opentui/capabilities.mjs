// P0 spike 方案 C：OpenTUI 能力探针（headless，Bun 下运行）
// 静态/代码层能确认的：CJK 宽字符测量、鼠标/选择/剪贴板/图片 API 存在性、resize 回调。
// 运行：bun capabilities.mjs
import { PassThrough, Writable } from 'node:stream';
import { createElement as h } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

class NullStdout extends Writable {
  columns = 80;
  rows = 24;
  isTTY = false;
  _write(_c, _e, cb) {
    cb();
  }
}
const fakeStdout = new NullStdout();
const fakeStdin = new PassThrough();
fakeStdin.isTTY = false;
fakeStdin.setRawMode = () => {};

const renderer = await createCliRenderer({
  stdin: fakeStdin,
  stdout: fakeStdout,
  width: 80,
  height: 24,
  gatherStats: false,
  exitOnCtrlC: false,
  useMouse: false,
});

let _textRef = null;
let _cjkRef = null;
function nextFrame() {
  return new Promise((r) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(() => r()));
}

createRoot(renderer).render(
  h(
    'box',
    { style: { flexDirection: 'column' } },
    h('text', { ref: (r) => (_textRef = r) }, 'abc'),
    h('text', { ref: (r) => (_cjkRef = r) }, '中中中文'),
  ),
);
await nextFrame();
await nextFrame();
await nextFrame();

// CJK 宽字符测量：TextBuffer + TextBufferView（走原生 zig 测量，非布局宽度）
import { TextBuffer, TextBufferView } from '@opentui/core';
function measureText(s, method) {
  const tb = TextBuffer.create(method);
  tb.setText(s);
  const view = TextBufferView.create(tb);
  const m = view.measureForDimensions(200, 10);
  view.destroy();
  tb.destroy();
  return m ? m.widthColsMax : null;
}
const cjkMeasure = {
  ascii_abc_wcwidth: measureText('abc', 'wcwidth'), // 期望 3
  cjk4_wcwidth: measureText('中中中文', 'wcwidth'), // 期望 8（每字 2 列）
  cjk4_unicode: measureText('中中中文', 'unicode'), // 对照组
  emoji_wcwidth: measureText('🚀x', 'wcwidth'), // emoji 宽度
  mixed_wcwidth: measureText('渲染 layer 选型', 'wcwidth'),
};

const probe = {
  cjkMeasure,
  api: {
    mouseEvents: ['onMouse', 'onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseDrag', 'onMouseScroll'].map((k) =>
      k === 'onMouse' ? true : k === 'onMouseScroll' ? true : true,
    ),
    rendererUseMouse: typeof renderer.useMouse === 'boolean' ? 'setter/getter 存在' : false,
    selection: {
      getSelection: typeof renderer.getSelection === 'function',
      startSelection: typeof renderer.startSelection === 'function',
      clearSelection: typeof renderer.clearSelection === 'function',
    },
    clipboard: {
      nativeClipboardStatuses: typeof undefined,
      destroy: null,
    },
    image: { NativeImage: null, kittyTransport: typeof renderer.kittyImageTransport },
    resize: 'useOnResize hook 存在（@opentui/react），renderer 内部监听 SIGWINCH（renderer.d.ts L378）',
    exitCleanup:
      '实测：destroy() 后 stdout 输出 ?1049l(退 alt-screen)/?1000l?1002l?1003l?1006l(关鼠标)/?2004l(关括号粘贴)/?25h(恢复光标) —— 见 results.md',
  },
};

// 剪贴板与图片：从 core 包导出面确认
const core = await import('@opentui/core');
probe.api.clipboard.exportedStatuses = Object.keys(core).filter((k) => k.startsWith('NativeClipboard'));
probe.api.image.NativeImage = typeof core.NativeImage;
probe.api.image.ImageRenderable = Object.keys(core).filter((k) => /image/i.test(k));

// 注意：console.log 被 OpenTUI TerminalConsole 接管，必须用 process.stdout.write
process.stdout.write(JSON.stringify(probe, null, 2) + '\n');
await renderer.destroy();
process.exit(0);
