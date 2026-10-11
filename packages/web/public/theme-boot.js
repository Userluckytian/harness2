// 首屏防闪（Z1-05）：在模块脚本之前同步把主题写到 <html>，避免 React 挂载前的白/闪。
// 外部脚本（web 无 CSP script-src 限制，但为与桌面同源实现保持一份逻辑）。
// 约束：不读 IPC（同步不可得）、不引任何外部资源；偏好缺省 system。
// 与 desktop renderer/theme.ts 的写入契约保持一致（class / dark / data-theme / color-scheme）。
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
  } catch (e) {
    // 防闪失败不阻断应用启动
  }
})();
