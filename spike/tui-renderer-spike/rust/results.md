# 方案 D 结果（ratatui + crossterm，2026-09-12）

> 环境登记（T0-1）：Windows 10.0.26200 x64（Git Bash）；Node v22.23.1；pnpm 11.13.0；cargo/rustc 1.97.1；
> 数据：`../common/transcript-10k.txt`（10000 行，与 A/B/C 同一份；构成 60% ASCII / 20% CJK / 10% emoji / 10% 200~400 字符长行）。

## 1. 构建与工具链成本

| 项                             | 值                                                                                                                | 来源                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 依赖锁定                       | 182 个包（ratatui 0.30.2 + crossterm 0.29.0 及传递依赖）                                                          | `cargo add ratatui crossterm` 输出      |
| 网络成本                       | crates.io 下载两次因「transfer too slow」中断，第 3 次（加大 `CARGO_HTTP_TIMEOUT=120 CARGO_NET_RETRY=10`）成功    | 会话原始日志                            |
| 编译时间（增量后成功一次全量） | 29.12s（`Finished release profile`）                                                                              | 见 §4 命令记录                          |
| 二进制体积                     | 2,317,344 bytes（≈2.2MB，release，未 strip）                                                                      | `ls -la target/release/tui-spike-d.exe` |
| target 目录                    | 150MB（中间产物，不入 git）                                                                                       | `du -sh target`                         |
| 许可                           | ratatui MIT、crossterm MIT；182 包中非宽松仅 `terminfo: WTFPL`（同为宽松许可，非传染）；`cargo metadata` 逐包核查 | 同上                                    |

## 2. headless 压测（`--bench`，TestBackend 120x40）

```
$ ./target/release/tui-spike-d.exe --bench
mode=ratatui-bench lines=10000 terminal=120x40
initial_render_ms=0.504
scroll_frames=2000 avg_ms=0.175 p50_ms=0.171 p95_ms=0.204 p99_ms=0.249
idle_diff_frames=500 avg_ms=0.127 p95_ms=0.122
exit=0
```

对照门槛（p95 < 33ms）：**通过，余量 ≈160 倍**。差量刷新由 ratatui Buffer diff 内建（idle 帧 0.12ms 证实 diff 路径生效）。

## 3. 能力面（与 grok 同栈）

- ✅ alt-screen 进出 + raw mode + 退出恢复（crossterm 内建）
- ✅ SGR 鼠标滚轮/点击（crossterm 内建鼠标事件）
- ✅ CJK/宽字符断行（ratatui 内建 unicode-width；`Paragraph + Wrap` 不切半边）
- ✅ 差量刷新（内建）
- ⚠️ **集成成本是主要代价**：Rust 前端需经 core serve（HTTP/WS）通信 = 新增 IPC 协议面；桌面端/CI 需按平台分发独立 exe；团队引入第二种语言。

## 4. 复跑命令记录（原文）

```bash
cd spike/tui-renderer-spike/rust
cargo add ratatui crossterm          # 182 packages locked, exit 0
CARGO_NET_RETRY=10 CARGO_HTTP_TIMEOUT=120 cargo build --release
# → Finished `release` profile [optimized] target(s) in 29.12s; 2 warnings（未使用项，spike 级）
./target/release/tui-spike-d.exe --bench
# → 输出见 §2
./target/release/tui-spike-d.exe     # 真机 demo（待真机项：滚轮/键盘/resize 观感）
```

## 5. 门槛判定（总览 §4.2）

| 门槛           | 判定                 | 说明                                                                        |
| -------------- | -------------------- | --------------------------------------------------------------------------- |
| Node≥22 可运行 | ❌（不适用）         | 根本不走 Node 运行时；换来的等价问题是「Rust 工具链 + 三平台编译产物分发」  |
| 性能           | ✅                   | p95 0.204ms                                                                 |
| 打包           | ⚠️                   | 需为 desktop 增加分发 Rust 二进制的 extraResources 通道 + CI 三平台交叉编译 |
| 体验底线       | ✅（代码级）/ 待真机 | 宽字符/alt-screen/鼠标由框架内建保证；真机观感待确认                        |
| 许可           | ✅                   | MIT（ratatui/crossterm），依赖链无传染性许可                                |
