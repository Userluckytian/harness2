# 方案 C：OpenTUI Spike

`@opentui/core@0.5.11` + `@opentui/react@0.5.11`（Zig 原生核 + FFI）。

## 关键结论

- **Node 22 不可运行**：原生层需要 `node:ffi`（Node ≥26）或 `bun:ffi`；engines 声明 `node>=26.4.0, bun>=1.3.0`。
- **Bun 1.4.2 + Windows x64 可运行**（`npm i -D bun` 即得，无需全局安装）。
- MIT；npm 可装；Windows 预编译 DLL 经 `@opentui/core-win32-x64` 平台包自动落盘。

## 复跑

```bash
npm i
npx bun bench.mjs          # headless 性能基准（10k 行，输出 JSON）
npx bun capabilities.mjs   # 能力探针
npx bun demo.tsx           # 交互 demo（真机；ctrl-c 退出）
npx bun hello.tsx          # 最小 hello-world
```

详细原始数据与门槛判定见 `results.md`。

## 文件

| 文件               | 用途                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `hello.tsx`        | 最小全屏 app（scrollbox + input），烟雾测试（`SPIKE_AUTO_EXIT_MS` 环境变量可自动退出） |
| `demo.tsx`         | 10k 行转录 + 滚轮 + 输入框（真机交互验证）                                             |
| `bench.mjs`        | headless 基准：初始渲染/滚动帧耗/输入回显/RSS（`SPIKE_SCROLL_FRAMES` 可调帧数）        |
| `capabilities.mjs` | CJK 宽度原生测量 + 鼠标/选择/剪贴板/图片 API 存在性                                    |
| `results.md`       | 全部原始数据 + 结论                                                                    |
