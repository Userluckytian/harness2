# Z9 阶段计划：终端 dock（ZCode 对齐）+ web 设置面与桌面对齐

> 立项依据：用户 2026-10-13 拍板——①「终端：需要做」；②「web 和桌面对齐」（P0-4）。
> 上游依据：`docs/ai-framework/plans/2026-10-12-zcode-gap-register.md` §1.3/§1.5、`refs-zcode.md`。
> 前置事实（本轮实测确认）：
>
> - **终端席位与几何早已存在**：`TERMINAL_SEAT = 'main.terminal'`（`ui-shared/src/renderer/layout/frame-seats.ts:30`，kind=single，**注册缝**——无内容提供方时不渲染面板/开关），纵向分栏几何 `terminalMinPx=140 / max=50% / 展开 30%`（`layout/geometry.ts`）。故本阶段做的是**注入内容**，不是新建布局。
> - **PTY 可行性已坐实**：本机无 VS 构建链、GitHub 不可达（预编译产物取不到），但 `@lydell/node-pty`（平台二进制做成 npm 可选依赖，走可达 registry）实测安装 1s 且真跑 `cmd.exe` 出 ANSI 输出（`HARNESS2-PTY-OK` 命中）。**选它**（不用 node-pty 源码编译路线）。
> - **传输双形态**：桌面渲染端 = `window.harness2`（preload→IPC→主进程→core 同进程）；web = HTTP/WS→serve。故 core 侧一份终端管理器 + **两个薄传输**。

## 1 冻结契约（本阶段内部接口，改动需回填本文件）

### 1.1 core 终端管理器 `packages/core/src/terminal/manager.ts`

```ts
export interface TerminalSpawnOptions {
  cwd?: string;
  cols: number;
  rows: number;
  shell?: string;
  env?: Record<string, string>;
}
export type TerminalEvent =
  { type: 'data'; id: string; data: string } | { type: 'exit'; id: string; exitCode: number | undefined };
export interface PtyLike {
  // 便于注入假 PTY 单测；真实现 = @lydell/node-pty
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export interface TerminalManager {
  spawn(opts: TerminalSpawnOptions): { id: string };
  write(id: string, data: string): boolean; // false = 未知 id（如实，不抛）
  resize(id: string, cols: number, rows: number): boolean;
  kill(id: string): boolean;
  list(): string[];
  onEvent(cb: (e: TerminalEvent) => void): () => void;
  dispose(): void; // 杀全部并摘监听
}
export function createTerminalManager(deps?: {
  spawnPty?: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike;
  defaultShell?: string;
}): TerminalManager;
```

约束：**不 import serve / 不 import Electron**；默认 shell = Windows `process.env.ComSpec ?? 'cmd.exe'`、其余平台 `process.env.SHELL ?? '/bin/bash'`；无 PTY 可用（平台不支持）时 `spawn` 抛 `TerminalUnavailableError`（如实失败，不静默降级成假终端）。

### 1.2 跨壳线协议（新增帧；唯一事实源 `ui-shared/src/shared/protocol.ts`，core `server/ws.ts` 镜像）

| 方向          | 帧                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------- |
| client→server | `{ type: 'terminal/open'; requestId: string; cols: number; rows: number; cwd?: string }` |
| client→server | `{ type: 'terminal/input'; id: string; data: string }`                                   |
| client→server | `{ type: 'terminal/resize'; id: string; cols: number; rows: number }`                    |
| client→server | `{ type: 'terminal/close'; id: string }`                                                 |
| server→client | `{ type: 'terminal/opened'; requestId: string; id: string }`                             |
| server→client | `{ type: 'terminal/data'; id: string; data: string }`                                    |
| server→client | `{ type: 'terminal/exit'; id: string; exitCode?: number }`                               |
| server→client | `{ type: 'terminal/error'; requestId?: string; id?: string; error: string }`             |

（命名沿既有 `notify/click` 的斜杠命名空间习惯。生成/退出/错误都必须**如实回传**，UI 侧不得把 error 画成成功。）

> **实施修正（Z9-2 落地时，2026-10-13）**：**客户端** 4 帧的判别字段沿用既有 `WsClientOp` 联合的 **`op`**（core 分发 `switch(msg.op)` + OPS 白名单同为 `op` 体系；若改 `type` 会导致该联合判别分裂、既有解析全断）。**服务端** 4 帧仍用 `type`（沿用 `WsFrame`）。帧名与其余字段（requestId/cols/rows/cwd/id/data/exitCode/error）与上表逐字一致。

> **连接归属语义（Z9-2 定）**：终端属于**创建它的 WS 连接**；`data`/`exit` 只回该连接（不按会话订阅过滤、不广播）；跨连接访问他人 id → `terminal/error` 如实拒绝；连接断开 → kill 该连接全部终端。

### 1.3 渲染端端口（`ui-shared/src/renderer/terminal/port.ts`，两壳各自实现）

```ts
export interface TerminalPort {
  open(opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): () => void;
  onExit(cb: (id: string, exitCode: number | undefined) => void): () => void;
  available: boolean; // false（web 无通道 / 桌面 PTY 不可用）→ UI 如实禁用，不摆假终端
}
```

## 2 批次与验收

| 批次                         | 内容                                                                                                        | 负责   | 验收（命令 + 期望）                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| **Z9-1** core PTY 管理器     | `terminal/manager.ts` + 假 PTY 单测 + 真 PTY 冒烟（平台支持时）                                             | 代理 A | `pnpm --filter @harness2/core run test`：新增用例全绿，core 既有 1538 零回归；真冒烟跑出标记串 |
| **Z9-2** 线协议 + serve 传输 | `shared/protocol.ts` 八帧 + `serve ws` 分发 + 鉴权/信任域沿既有路径                                         | 代理 A | core 测试新增帧用例；`ws` 既有用例零回归                                                       |
| **Z9-3** 桌面传输            | IPC `terminal:*` 四件 + `TerminalPort` 桌面实现                                                             | 代理 A | desktop 测试：假 PTY 下 open/input/data/exit 往返                                              |
| **Z9-4** 终端 UI             | `renderer/terminal/{port.ts,TerminalPanel.tsx}`（xterm 视图 + 标签条 + 新建/关闭）+ 单测（mock port）       | 代理 B | ui-shared 测试新增；既有 478 零回归；依赖 `@xterm/xterm`/`@xterm/addon-fit`                    |
| **Z9-5** 两壳装配            | 注册进 `TERMINAL_SEAT`（桌面/ web 各一）+ 侧栏/命令面板「切换终端 Ctrl+J」由占位转真 + web 端口实现         | 代理 C | 两壳测试；浏览器复核：Ctrl+J 开合、键入有回显                                                  |
| **Z9-6** web 设置对齐        | serve `GET/PUT /api/config`（分区级读写 + 密钥脱敏）+ web 设置端口接上（`sectionAllowList` 放开到桌面同集） | 代理 D | serve 测试（读写/脱敏/非法拒绝）+ web 设置页可开各分区；**写密钥另行拍板**（见 §4）            |

## 3 实施纪律（沿用既有铁律）

1. 红线⑩：无通道/不可用一律 **disabled + title + data-placeholder**，禁止假终端、假日志、假成功；
2. 密钥：**读不回显、写不落日志**；`auth.json` 这类凭据面在 web 侧的**写**能力默认不开（见 §4）；
3. 破坏性：PTY 只在用户显式开终端时创建；`dispose` 时全杀；不后台常驻；
4. core 改动只做**加性**（`api-surface-baseline.json` 快照测试需按既有流程更新并说明增量）；
5. 改 `ui-shared/src` 后必须 `build` 再跑两壳测试（dist 陈旧坑）；
6. 不 push；提交前跑六包 build/typecheck/test + lint。

## 4 待拍板（不阻塞 Z9-1～Z9-5）

- **web 侧能否写密钥/凭据**（`auth.json`、MCP 凭据）：serve 已有 token + 信任域门禁，但「网页端能改本机凭据」风险等级高于「改普通配置」。默认按**只读**实现，写能力等用户明确授权后再开。
- **终端外壳**：默认用系统默认 shell（Windows=cmd，Unix=$SHELL）。ZCode 参考端是 PowerShell 多实例；若要 1:1 换成 PowerShell 需另拍（涉及跨平台默认值）。

## 5 交接提示词（可直接粘贴）

见本文件 §2 各批次「内容」列 + 冻结契约 §1；每个代理的交接书需包含：目标批次、冻结契约原文、涉及文件路径、验收命令与期望、红线、报告要求。
