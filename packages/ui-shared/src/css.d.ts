// CSS 副作用导入的模块声明（必须在全局声明文件：本文件无 top-level import/export）。
// 共享包内组件（如 renderer/trajectory/trajectory-panel.tsx 导入 ./trajectory.css）需要它；
// 非 TS 的 .css 由 scripts/dist-type.mjs 复制进 dist（tsc 不搬非 TS 文件）。
declare module '*.css';
