// Z9-4：渲染端终端端口（冻结契约，**逐字照抄**自阶段计划
// `docs/ai-framework/plans/2026-10-13-phase-Z9-terminal-and-web-settings.md` §1.3）。
//
// 唯一缝：共享层（TerminalPanel）只依赖本接口，不 import electron / Node 内建 /
// `window.harness2` / 任何壳桥。两壳各自实现：
//   * desktop：preload contextBridge → IPC `terminal:*` → 主进程 / core（Z9-3）；
//   * web    ：serve 的 WS 帧 `terminal/*`（Z9-2 / Z9-6）。
//
// `available === false` 的语义（红线⑩）：该壳此刻没有可用通道（web 无 WS / 桌面 PTY 不可用）
// → UI 必须如实禁用、不创建 xterm、不摆假提示符；**绝不**在无通道时渲染一个假终端。
export interface TerminalPort {
  open(opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): () => void;
  onExit(cb: (id: string, exitCode: number | undefined) => void): () => void;
  available: boolean; // false（web 无通道 / 桌面 PTY 不可用）→ UI 如实禁用，不摆假终端
}
