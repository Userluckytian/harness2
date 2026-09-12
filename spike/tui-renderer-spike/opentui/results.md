# 方案 C：OpenTUI（@opentui/core + @opentui/react）Spike 结果

> 环境：Windows 10.0.26200 x64，Node v22.23.1，npm 10.9.8，Bun 1.4.2（本地 npm 安装 `bun@1.4.2`）。
> 测试日期：2026-09-12。本目录内所有命令均在 `spike/tui-renderer-spike/opentui/` 下执行。

## 0. 一句话结论

**OpenTUI 在 Node 22 下不可运行**（原生 FFI 后端需要 `node:ffi`，Node 26 才有；且 engines 声明 `node>=26.4.0`）。**在 Bun 1.4.2 + Windows 下完全可用**，headless 基准全部通过（滚动 p95 ≈ 18ms < 33ms 门槛）。MIT 许可，npm 可正常安装（仅 EBADENGINE 警告）。

---

## 1. 安装与元数据

### 1.1 npm 元数据

```
命令: npm view @opentui/core version license dependencies
输出:
version = '0.5.11'
license = 'MIT'
dependencies = {
  diff: '9.0.0', marked: '17.0.1', 'strip-ansi': '7.1.2',
  'string-width': '7.2.0', 'bun-ffi-structs': '0.3.1'
}

命令: npm view @opentui/react version license dependencies peerDependencies
输出:
version = '0.5.11'
license = 'MIT'
dependencies = { '@opentui/core': '0.5.11', 'react-reconciler': '^0.33.0' }
peerDependencies = { ws: '^8.18.0', react: '>=19.2.0', 'react-devtools-core': '^7.0.1' }

命令: npm view @opentui/core os cpu engines
输出: { bun: '>=1.3.0', node: '>=26.4.0' }   ← 关键：无 os/cpu 限制，但 engines 卡 Node 26
```

**依赖许可链（全部 MIT）**：diff、marked、strip-ansi、string-width、bun-ffi-structs（MIT, 0.3.1）、react-reconciler（MIT）、react 19.3.0（MIT）、ws（MIT）。
原生 DLL 内静态链接的第三方（`node_modules/@opentui/core-win32-x64/` 附带许可文件）：LIBWEBP、GHOSTTY、LCMS2、STB、WUFFS——随包附带对应 LICENSE 文件，均为宽松或附条件许可，未见 GPL。

### 1.2 安装过程

```
命令: npm install @opentui/core @opentui/react react ws
输出:
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@opentui/core@0.5.11',
npm warn EBADENGINE   required: { bun: '>=1.3.0', node: '>=26.4.0' },
npm warn EBADENGINE   current: { node: 'v22.23.1', npm: '10.9.8' }
npm warn EBADENGINE }
added 20 packages in 3s
exit code: 0
```

- **安装成功**（仅警告；未开 engine-strict）。锁定版本：`@opentui/core 0.5.11`、`@opentui/react 0.5.11`、`react 19.3.0`。
- devDependencies 额外装了 `bun@1.4.2`（经 npm 包分发，含平台二进制）与 `tsx@4.23.13`（Node 加载器测试用）。

### 1.3 体积

```
命令: du -sh node_modules/@opentui/*
14M    node_modules/@opentui/core
6.2M   node_modules/@opentui/core-win32-x64
176K   node_modules/@opentui/react
（安装时的全量 node_modules，未含 bun/tsx devDeps 时：54M）

tarball: npm pack @opentui/core@0.5.11 → opentui-core-0.5.11.tgz = 2,302,895 B（约 2.2MB）
dist.unpackedSize: core = 13,689,887 B (184 files)；react = 87,953 B
```

注意：若改用 Bun 运行时，`bun` npm 包本体额外 ~83MB（`node_modules/bun`）。

### 1.4 预编译二进制（实际落盘）

```
命令: find node_modules/@opentui \( -name "*.node" -o -name "*.dll" -o -name "*.so" -o -name "*.zig*" \)
输出: node_modules/@opentui/core-win32-x64/opentui.dll   （6,387,240 字节，x86-64 PE）
```

- **有 Windows x64 预编译 DLL**，通过 npm optional 平台包 `@opentui/core-win32-x64` 自动落盘，无需本地编译。
- 不是 N-API `.node` 插件，而是 **FFI 动态库**：Bun 下走 `bun:ffi`，Node 下走 `node:ffi`（Node ≥26 内置实验模块）。Node 22 无此模块（见 §2）。
- 平台覆盖（`node-assets.js`）：win32-x64、darwin(arm64/x64)、linux glibc/musl(arm64/x64)——主流桌面平台全覆盖。

---

## 2. Node 22 可运行性（关键项）—— **失败**

### 2.1 `node:ffi` 缺失（根因）

```
命令: node -e "import('node:ffi').then(()=>console.log('OK')).catch(e=>console.log('FAIL:', e.code, e.message))"
输出: FAIL: ERR_UNKNOWN_BUILTIN_MODULE No such built-in module: node:ffi
exit code: 0（脚本内捕获）
```

### 2.2 导入 @opentui/core 在 Node 22 下的表现

- 模块本身**能 import**（279 个导出，JS 层正常），但任何触发原生初始化的调用都会失败：

```
命令: node -e "import('@opentui/core').then(m=>m.TextBuffer.create('hi'))…"
输出: TextBuffer.create FAIL: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet
```

### 2.3 运行 hello.tsx 的两种加载器尝试

```
命令: node --experimental-strip-types hello.tsx
输出: TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx" for …\hello.tsx
exit code: 1

命令: ./node_modules/.bin/tsx hello.tsx        （tsx 加载器，JSX 编译成功，运行时死在 FFI）
输出:
Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet
    at resolveRenderLib2 (…\@opentui\core\chunk-node-70eg2nhg.js:17805:13)
    at new CliRenderer2 (…\@opentui\src\renderer.ts:1070:17)
    at createCliRenderer2 (…\@opentui\src\renderer.ts:736:20)
exit code: 1
```

### 2.4 旧版本与 Bun 路线

- 旧版 `@opentui/core@0.1.26`（解包检查）：仅 `bun:ffi`，**没有**任何 Node 后端 → OpenTUI 历史上从未支持过 Node 22。
- Bun 可用性：本机无全局 bun；`npm i -D bun` 后 `./node_modules/.bin/bun --version` → **1.4.2**（Windows 原生支持）。

**结论：Node ≥22 门槛下 OpenTUI 不可用；可用路径 = Node 26+（实验性 node:ffi）或 Bun ≥1.3（官方一等公民，实测 1.4.2 可用）。**

---

## 3. Bun 1.4.2 + Windows 可运行性 —— 通过（headless）

### 3.1 烟雾测试（hello.tsx：scrollbox + 底部 input，非 TTY 管道输出）

```
命令: SPIKE_AUTO_EXIT_MS=2500 ./node_modules/.bin/bun hello.tsx 2>&1 >/dev/null
输出: SMOKE_OK frames=2
exit code: 0
```

stdout 原始字节中确认的关键序列（headless 也能正常驱动终端初始化）：
- 进入 alt-screen：`ESC[?1049h`
- 开启鼠标：`ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h`（SGR mouse 编码）
- 终端能力探测：CSI 6n 光标上报、Kitty keyboard 协议查询、iTerm2 图片能力查询（均带超时降级）

### 3.2 demo.tsx（10k 行 + 滚轮 + 输入框）

```
命令: timeout 10 ./node_modules/.bin/bun demo.tsx
exit code: 124（timeout 到点杀死，进程稳定运行 10s，正常渲染输出 5728 字节）
```

交互项（滚轮实际滚动、输入回显观感、CJK 显示效果）**待真机**验证：headless 无法产生真实滚轮/键盘事件。

---

## 4. 性能测量（headless，bun bench.mjs，120x40 画布）

方法（`bench.mjs`，自动化）：
- `createCliRenderer({ stdin/stdout: 假终端(丢弃输出), width:120, height:40, targetFps:60, gatherStats:true })`；
- React 树 = scrollbox(10k 行，内容来自 `common/generate-transcript.mjs` 的 `generateLines(10000, 42)`) + 底部 input；
- 初始渲染耗时 = `createRoot().render()` 调用 → 前 3 帧稳定；
- 滚动帧耗 = 劫持后的全局 `requestAnimationFrame` 每帧 `scrollBy(3)`，测 240 帧帧间隔（含布局+绘制+管线），p95/p99 由排序样本取分位；
- 输入回显 = 向假 stdin 写字符 → 逐帧轮询 `input.value` 变化（帧粒度，≤16.7ms 分辨率）；
- RSS = `process.memoryUsage.rss()`（基准结束时刻）。

原始数据（3 次独立运行）：

| 指标 | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| renderer 创建 | 5.4ms | — | — |
| **10k 行初始渲染** | 249.4ms | 252.7ms | 266.3ms |
| 滚动帧耗 avg | 17.25ms | 17.19ms | 17.27ms |
| 滚动帧耗 p95 | **17.95ms** | 17.89ms | 17.95ms |
| 滚动帧耗 p99 / max | 18.81 / 19.25ms | 18.00 / 18.55ms | 18.53 / 18.97ms |
| 输入回显延迟 avg（帧粒度） | 17.24ms | 17.34ms | 17.28ms |
| RSS | 259.8MB | 242.9MB | 244.6MB |
| renderer 内部统计 averageFrameTime | 3.30ms | 3.34ms | 3.44ms |

解读：
- 滚动帧间隔 p95 ≈ 18ms 是 **60fps 帧步进（16.7ms）+ 每帧实际工作 ≈ 3.3ms** 的结果；真实渲染负载远低于 33ms 门槛。renderer 自带 `gatherStats: true` + `getStats()`（fps/frameCount/frameTimes/averageFrameTime），已用于交叉验证。
- 输入回显 17ms 为帧对齐测量下限，满足 <30ms。
- 初始渲染 10k 行 ≈ 250ms（一次性成本）。
- 局限：headless 无真实终端写入耗时（丢弃输出）、无真实鼠标/键盘事件、单进程 CPU 栈非 Windows Terminal 实测渲染。帧耗是「帧间隔」口径，与 A/B/D 方案需统一口径对比。

---

## 5. 能力验证

### 5.1 headless 实测通过（`bun capabilities.mjs`，输出 JSON 原文）

```json
{
  "cjkMeasure": {
    "ascii_abc_wcwidth": 3,
    "cjk4_wcwidth": 8,
    "cjk4_unicode": 8,
    "emoji_wcwidth": 3,
    "mixed_wcwidth": 15
  },
  "api": {
    "rendererUseMouse": "setter/getter 存在",
    "selection": { "getSelection": true, "startSelection": true, "clearSelection": true },
    "clipboard": { "exportedStatuses": ["NativeClipboardCancelStatus","NativeClipboardCopyStatus","NativeClipboardDestroyStatus","NativeClipboardOperationStatus","NativeClipboardShutdownStatus","NativeClipboardStartStatus"] },
    "image": { "NativeImage": "function", "kittyTransport": "string", "ImageRenderable": ["ImageError","ImageLoadError","ImageRenderable","NativeImage","NativeImagePool","imageInfo","resolveImageRenderProtocol"] }
  }
}
```

- **CJK 宽字符**：原生 zig 测量（`TextBufferView.measureForDimensions`），「中中中文」= 8 列（每字 2 列，正确）；「渲染 layer 选型」= 15 列（4×2 + 7 ASCII = 15，正确）。`WidthMethod` 三档可配：`"wcwidth" | "unicode" | "unicode-wide"`（`types.d.ts` L54）。
- **鼠标 API**：Renderable 层 `onMouse/onMouseDown/onMouseUp/onMouseMove/onMouseDrag/onMouseScroll` 全部存在（`Renderable.d.ts` L74-83）；renderer `useMouse` 开关；烟雾输出实测发出 SGR mouse 启用序列。
- **文本选择/复制**：renderer `getSelection/startSelection/clearSelection` 存在；`useSelectionHandler` hook 存在；原生剪贴板（NativeClipboard* 状态枚举 + `createRendererClipboardAdapter`）存在。
- **内联图片**：`ImageRenderable`、`NativeImage/NativeImagePool`、Kitty 图片传输（`kittyImageTransport` 配置）存在。
- **异常退出清理（headless 实测 destroy()）**：stdout 末尾实测发出恢复序列原文：
  `ESC[?1003l ESC[?1002l ESC[?1000l ESC[?1006l`（关鼠标）`ESC[?2004l`（关括号粘贴）`ESC[?1049l`（**退出 alt-screen**）`ESC[?25h`（恢复光标）。grep 计数：`?1049l` ×1，`?1000l` ×1。
- **resize**：`useOnResize` hook + `useTerminalDimensions` hook 存在；renderer 注释确认监听 SIGWINCH（`renderer.d.ts` L378）。Windows 下 SIGWINCH 行为特殊，**待真机**。

### 5.2 待真机项（headless 无法验证）

- 滚轮在 Windows Terminal 实际滚动 demo（SGR 序列已发出，解析闭环未验证）。
- 鼠标拖选文本 → 复制到系统剪贴板的端到端效果。
- CJK/emoji 的实际显示效果（对齐、字体 fallback）。
- 拖动窗口缩放（Win32 resize 事件）与 SIGWINCH 等效性。
- 异常退出（kill / 未捕获异常）时的终端恢复完整性。
- 内联图片在 Windows Terminal 的显示（WT 对 Kitty 图片协议/Sixel 支持有限，可能实际不可用）。

---

## 6. 通过门槛逐条判定表

| 门槛 | 定义 | 结果 | 判定 |
| --- | --- | --- | --- |
| 平台 | Node ≥22 可运行 | Node 22 实测失败（无 `node:ffi`，engines 要求 node≥26.4/bun≥1.3；旧版也仅 bun:ffi）；Bun 1.4.2 + Win x64 实测可运行 | **未过**（仅 Bun/Node26+ 路线可用） |
| 性能 | 10k 行滚动 p95 帧耗 < 33ms | p95 = 17.95ms（帧间隔口径；内部统计 averageFrameTime ≈ 3.3ms），3 次复跑稳定 | **通过**（Bun 下） |
| 打包 | npm 可装 | npm i 成功（20 包，3s，仅 EBADENGINE 警告），Win x64 预编译 DLL 自动落盘 | **通过** |
| 体验底线 | 输入回显 < 30ms；alt-screen/退出清理 | 回显 ≈17ms（帧粒度）；destroy() 实测恢复 alt-screen/鼠标/光标/括号粘贴序列完整 | **通过**（headless 口径；真机观感待验） |
| 许可 | 宽松许可 | core/react 均 MIT；依赖链全 MIT；DLL 内第三方（libwebp/lcms2/ghostty/stb/wuffs）随包附 LICENSE，无 GPL | **通过** |

**总判定：4/5 通过；唯一硬伤 = Node 22 不可运行（需 Bun ≥1.3 或 Node ≥26）。**

---

## 7. 复跑命令

```bash
cd spike/tui-renderer-spike/opentui
npm i                      # 安装依赖（含 devDep bun）
npx bun bench.mjs          # headless 性能基准（输出 JSON）
npx bun capabilities.mjs   # 能力探针（CJK 宽度 + API 存在性）
npx bun demo.tsx           # 交互 demo（真机运行；ctrl-c 退出）
npx bun hello.tsx          # 最小 hello-world
```
