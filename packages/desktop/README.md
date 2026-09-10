# @harness2/desktop

harness2 Electron 桌面端（阶段 5）：主进程 spawn 本地 `harness2 serve --port 0`（127.0.0.1 HTTP 控制面 + WS 事件面），渲染进程零 Node（contextIsolation + sandbox + preload 桥 `window.harness2`）。

## 结构

```
src/
├── main/        # Electron 主进程（CJS，tsc → dist-electron）
│   ├── main.ts          # 启动/窗口/SMOKE 冒烟模式
│   ├── serve-manager.ts # spawn serve / 端口解析 / 健康检查 / 断线重启（退避+上限）/ 采纳既有实例
│   └── bridge.ts        # IPC 命令分发 + 服务 WS 连接与帧转发
├── preload/     # contextBridge 桥（IPC 通道名内联；sandbox 不允许 require 相对模块）
├── shared/      # 三方共享协议类型（window.harness2 API / 服务帧类型）
└── renderer/    # React 渲染端（Vite → dist/renderer）
```

## 命令

| 命令         | 说明                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `pnpm dev`   | 构建 + 打开窗口（默认加载 config provider；`H2_PROVIDER=mock` 零 key 体验）                   |
| `pnpm smoke` | 构建 + 无头冒烟：stdout 打一行 JSON `{ok,port,rendererLoaded,bridgeReady}` 后退出（exit 0/1） |
| `pnpm test`  | vitest（主进程纯函数/ServeManager 真子进程/store）                                            |
| `pnpm dist`  | 构建 + electron-builder win 打包（Task 6）                                                    |

## 安全边界（阶段 5 红线）

- 渲染进程 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`；CSP `connect-src 'none'`。
- 渲染端只经 `window.harness2`（ipcRenderer.invoke + 两个事件频道）与主进程通信；主进程只与 127.0.0.1 serve 通信。
- 密钥三不延续：/api/config 报告只有 key 来源标签，key 不出服务进程、不进 WS。
