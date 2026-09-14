// React 入口：订阅 store + 启动 controller。
// P6 装配（D-50～D-59）：模型配置页注册进设置壳的 models 分区（同 id 接管内建过渡面板）。
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { registerModelsSettingsSection } from './settings/models/index.js';
import '@harness2/ui-shared/styles/shell.css';

registerModelsSettingsSection();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
