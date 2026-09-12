# TUI 渲染层选型 Spike（P0）

> 分支 `feat/tui-p0-renderer-spike`（基于 main 58fe6fe）。**不并入主线**：只含本目录与 `docs/research/2026-09-12-tui-renderer-spike.md`。
> 对应施工单：`docs/ai-framework/plans/2026-09-12-terminal-grok-parity-execution.md` §2（T0-1~T0-7）。

## 候选

| 代号 | 方案                                          | 目录        |
| ---- | --------------------------------------------- | ----------- |
| A    | Ink 渐进增强（现有栈）                        | `ink/`      |
| B    | Node 自研最小渲染层（cell buffer + 差量刷新） | `selfdraw/` |
| C    | OpenTUI（`@opentui/core` + `@opentui/react`） | `opentui/`  |
| D    | Rust ratatui + crossterm（与 grok 同栈）      | `rust/`     |

## 统一测试协议

- **同一份数据**：`common/generate-transcript.mjs` 的 `generateLines(10000, 42)`（确定性、含 CJK/emoji/长行）。
- **同一指标**：
  1. 冷启动时间（进程起 → 首帧呈现）
  2. 10k 行初始渲染耗时
  3. 滚动帧耗：模拟连续滚轮/翻页，取 avg 与 p95（门槛：p95 < 33ms 即 ≥30fps）
  4. 输入回显延迟（按键 → 字符上屏 < 30ms）
  5. 常驻内存（RSS）
- **能力边界**：鼠标滚轮/点击、文本选择/复制、CJK 宽度、resize、alt-screen 进出恢复、异常退出清理。

## 复跑命令（每目录 README 详述）

```bash
# A: node spike/tui-renderer-spike/ink/bench.mjs
# B: node spike/tui-renderer-spike/selfdraw/bench.mjs
# C: 见 opentui/README.md（需 npm i）
# D: 见 rust/README.md（需 cargo）
```

## 环境登记（T0-1）

- Windows 10.0.26200 x64；Windows Terminal（版本见报告）；Node v22.23.1；pnpm 11.13.0；cargo/rustc 1.97.1
- 显示器与 CJK 字体：见报告
