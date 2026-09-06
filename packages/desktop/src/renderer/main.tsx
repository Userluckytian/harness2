// React 入口：订阅 store + 启动 controller。
import { createRoot } from 'react-dom/client';
import { App, controller } from './App';
import './styles.css';

controller.start();
createRoot(document.getElementById('root')!).render(<App />);
