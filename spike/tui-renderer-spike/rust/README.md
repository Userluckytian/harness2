# 方案 D：Rust ratatui + crossterm（与 grok-build 同栈）

## 复跑命令

```bash
cd spike/tui-renderer-spike/rust
cargo build --release
# headless 压测（不需要真终端，输出帧耗原始数字）：
./target/release/tui-spike-d.exe --bench
# 真机 demo（Windows Terminal 内运行；j/k/PageUp/PageDown 滚动，滚轮滚动，q 退出）：
./target/release/tui-spike-d.exe
```

数据：`../common/transcript-10k.txt`（与其他方案同一份 10k 行合成转录，编译期经 `CARGO_MANIFEST_DIR` 定位）。

## 工具链成本（T0-5 登记项）

- 本机已装：cargo/rustc 1.97.1（若 CI/其他机器没有 Rust 工具链，需额外安装 + 交叉编译三平台产物的 CI 成本）
- `cargo add ratatui crossterm` 锁定 **181 个包**
- 构建时间与产物体积：见 results.md
- 许可：ratatui MIT、crossterm MIT（经 `cargo metadata`/crate 页面核实，见 results.md）

## demo 能力面（与 grok 同栈的直接对照）

- ✅ alt-screen 进出 + raw mode + 退出恢复（crossterm 内建）
- ✅ SGR 鼠标滚轮（crossterm 内建鼠标事件）
- ✅ 宽字符断行（ratatui 内建 unicode-width）
- ✅ 差量刷新（ratatui Buffer diff 内建）
- ⚠️ 与 harness2 集成需 IPC 面：Rust 前端经 core serve（HTTP/WS）通信 = 新增协议面与双端维护
