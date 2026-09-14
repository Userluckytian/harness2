// web 壳入口：组装 serve 客户端 → 共享应用壳 → 页面。
//
// 与桌面壳的区别只在**端口实现**：桌面 = preload 桥（window.harness2，主进程持 serve 与 token），
// web = 浏览器直连 serve（HTTP + WS）。页面与交互全部来自 `@harness2/ui-shared`。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import '@harness2/ui-shared/styles/shell.css';
import '@harness2/ui-shared/styles/sidebar.css';
import './web.css';
import { WebApp } from './app.js';
import { readWebEnv } from './env.js';
import { createServeClient } from './serve-client.js';

const env = readWebEnv();
const client = createServeClient({ origin: env.origin, token: env.token });
const shell = createAppShell(client);

// 桌面壳的这些启动步骤在本壳**不适用**（端口未提供，调用会安全地不做任何事）：
//   initLayout / initMetadata / initDrafts —— web 无布局文件、无展示态覆层、草稿仅内存。
void shell.controller.initLayout();
void shell.controller.initMetadata();
void shell.controller.initDrafts();
shell.controller.start();

const container = document.getElementById('root');
if (container === null) throw new Error('未找到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <WebApp
      shell={shell}
      // serve 要求 cwd：serve 客户端用「最近列出的会话 cwd」兜底（本壳无目录选择通道）；
      // 兜底失败会由 controller 记成可见错误帧，按钮不假装成功。
      onNewSession={() => void shell.controller.newSession()}
    />
  </StrictMode>,
);
