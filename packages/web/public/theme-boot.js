// 首屏防闪（Z1-05 + Z-90）：在模块脚本之前同步把主题与界面字号写到 <html>，避免 React 挂载前的白/闪。
// 外部脚本（web 无 CSP script-src 限制，但为与桌面同源实现保持一份逻辑）。
// 约束：不读 IPC（同步不可得）、不引任何外部资源；主题偏好缺省 system；字号缺省不写（走 CSS 默认 14px）。
// 与 desktop renderer/theme.ts（例外 #1）+ renderer/ui-font-size.ts（**例外 #2**）的写入契约保持一致：
//   主题   → class / dark / data-theme / color-scheme；
//   字号   → 根内联样式 --ui-font-size（key 'harness2-font-size'，12–20 整数 px 才生效；
//            localStorage 是 D-14 登记的例外通道 —— 首渲染前只有它能同步读到偏好）。
(function () {
  try {
    var KEY = 'harness2-theme';
    var pref = null;
    try {
      pref = window.localStorage.getItem(KEY);
    } catch (e) {
      pref = null; // 隐私模式/存储不可用：退回默认 system
    }
    if (pref !== 'zai-light' && pref !== 'zai-dark' && pref !== 'system') pref = 'system';
    var dark =
      pref === 'zai-dark' ||
      (pref === 'system' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches === true);
    var resolved = dark ? 'zai-dark' : 'zai-light';
    var root = document.documentElement;
    root.classList.remove(dark ? 'theme-zai-light' : 'theme-zai-dark');
    root.classList.add(dark ? 'theme-zai-dark' : 'theme-zai-light');
    if (dark) root.classList.add('dark');
    else root.classList.remove('dark');
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = dark ? 'dark' : 'light';

    // —— 界面字号（Z-90 / D-14 例外 #2，理由同主题：防首帧字号跳变）——
    var FONT_KEY = 'harness2-font-size';
    var FONT_MIN = 12;
    var FONT_MAX = 20;
    var fontRaw = null;
    try {
      fontRaw = window.localStorage.getItem(FONT_KEY);
    } catch (e) {
      fontRaw = null; // 存储不可用：不写字号，走 CSS 默认 14px
    }
    var fontPx = fontRaw === null ? NaN : Number(fontRaw);
    if (Number.isInteger(fontPx) && fontPx >= FONT_MIN && fontPx <= FONT_MAX) {
      root.style.setProperty('--ui-font-size', fontPx + 'px');
    }
  } catch (e) {
    // 防闪失败不阻断应用启动
  }
})();
