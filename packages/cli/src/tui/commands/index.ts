// tui/commands — P3-A 命令面板（G-31 / G-50～G-53）与 shellOnly 新命令的壳层实现。
//
// ── 本目录三件套 ────────────────────────────────────────────────────────────
//   palette-model.ts        纯逻辑：条目构建（来源/模式 badge、分组）、模糊过滤、
//                           键盘 reducer（↑↓/Enter/查询；Esc 归 esc-machine，见下）
//   palette-view.ts         纯绘制：drawPalette 写 CellBuffer（锚定归接线层，复用
//                           next/overlay.ts 的 anchorOverlay / overlayStackLayout）
//   shell-command-impls.ts  catalog P3-A 批次 shellOnly 命令（session-info/export/
//                           timeline/doctor/memory/skills/plugins/mcps）的 thin 实现
//                           与路由缝 runPaletteShellCommand
//
// ── 接线缝（next-shell 接线棒消费；本棒不改 next-shell）────────────────────
//
// 1. 打开（G-31 `Ctrl+P` / `?`）：
//      const entries = buildPaletteEntries(renderModeState.mode, shellEntries);
//      const rows = filterPaletteRows('', entries);
//      paletteState = paletteOpenState(rows);
//    - shellEntries 从壳自己的命令表派生（如 next 的 NEXT_COMMANDS 里 wiring:'local'
//      的条目，映射为 {name, summary, group}）——本目录不持壳命令清单（禁止第三份）。
//    - `?` 触发条件按上游测试钉死的事实：prompt 聚焦打字时 `?` 进草稿、不开面板
//      （refs/grok-build app_view_tests.rs prompt_focused_question_mark_with_shift_
//      still_goes_to_textarea）；宿主只在空草稿（或 scrollback 聚焦）时把 `?` 作为
//      palette 触发键，Ctrl+P 恒触发。
// 2. 键盘：查询输入 → paletteSetQuery / paletteBackspace；↑↓ → paletteMove；
//    Enter → paletteEnter（effect.execute.name → 宿主 submitCommand(paletteCommandLine(name))
//    ——draft-preserving：面板不改草稿，命令走宿主既有 handleCommand 路由，G-03 模式
//    门控照常生效）。
// 3. Esc（不开特例）：宿主把 paletteCardDepth(paletteState) 并入 reduceEsc 的 cardDepth，
//    裁决 action === 'exit-card' 时 paletteState = paletteClosed()。面板本身没有 Esc 分支。
// 4. 渲染：paletteNaturalHeight(rows.length) → anchorOverlay/overlayStackLayout 得矩形 →
//    drawPalette(buf, paletteState, rows, rect) 与同帧其他层组合绘制。
// 5. 命令路由：effect.execute.name 先查 runPaletteShellCommand(id, io, rest)（本表接管），
//    未接管走壳既有分发（shell-commands 表 / ink-commands.runSharedCommand → core）。
//    ShellCommandIo 的 currentSessionDir 取 runtime.getCurrent()?.dir ?? null，root 取
//    runtime.root，print 送转录系统行。
//
// ── 已登记差异（相对上游）──────────────────────────────────────────────────
//   - 模式限定命令在面板中保留并打「仅 fullscreen/minimal」badge（上游按 screen_mode
//     隐藏）；执行仍被壳层 G-03 门控拒绝并给「运行 /fullscreen 切换本会话」指向替代。
//   - Esc 无「先清查询再关闭」两级（上游 esc_clears_query）——Esc 统一走 esc-machine
//     exit-card 直接关闭（派工要求，语义单源）。
//   - G-52（skill user-invocable 升为命令）、G-53 冲突限定形（/plugin:cmd）：harness2
//     无对应能力，未接（P7 归存）。
export {
  buildPaletteEntries,
  filterPaletteRows,
  paletteBackspace,
  paletteBadge,
  paletteCardDepth,
  paletteClosed,
  paletteCommandLine,
  paletteEnter,
  paletteMove,
  paletteOpenState,
  paletteSetQuery,
  type PaletteEffect,
  type PaletteEntry,
  type PaletteRow,
  type PaletteState,
  type ShellPaletteEntry,
} from './palette-model.js';
export {
  drawPalette,
  PALETTE_ACTIVE_FG,
  PALETTE_ACTIVE_PREFIX,
  PALETTE_HEADER_FG,
  PALETTE_TITLE,
  paletteNaturalHeight,
  type PaletteDrawOptions,
} from './palette-view.js';
export { runPaletteShellCommand, PALETTE_SHELL_COMMANDS, type ShellCommandIo } from './shell-command-impls.js';
