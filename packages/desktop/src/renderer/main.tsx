// React 入口：订阅 store + 启动 controller。
// P6 装配（D-50～D-59）：模型配置页注册进设置壳的 models 分区（同 id 接管内建过渡面板）。
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { registerModelsSettingsSection } from './settings/models/index.js';
import { initUiFontSize } from './ui-font-size';
// GUI 视觉层（Tailwind v4 入口 + 三层 token + Zai 双主题）：依据 docs/refs/refs-zcode.md
import '@harness2/ui-shared/styles/styles.css';
import '@harness2/ui-shared/styles/shell.css';
// Z7：三栅/席位/浮层骨架样式（壳无关，随骨架下沉 ui-shared）+ 侧栏皮肤 + 桌面窗口外壳（本地）。
import '@harness2/ui-shared/styles/app-frame.css';
import '@harness2/ui-shared/styles/sidebar.css';
import './layout/desktop-window.css';

registerModelsSettingsSection();
// 界面字号恢复（Z-90）：boot 脚本（首渲染前）之后的双保险；无存储值时不写任何东西
initUiFontSize();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
