#!/usr/bin/env node
// harness2 CLI 入口（B3-1 拆分后）：命令注册 + 各子命令模块（commands/）。
// traj（阶段 1）、config check（阶段 3）、chat REPL（阶段 4）、serve（阶段 5）、browser/cron（阶段 7）、plugin/mcp（阶段 8）、gateway（阶段 9）。
import { Command } from 'commander';
import { CORE_VERSION, installCrashReporter } from '@harness2/core';
import { registerTrajCommands } from './commands/traj.js';
import { registerExportReplayCommands } from './commands/export-replay.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerChatCommand } from './commands/chat.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerSkillCommand } from './commands/skill.js';
import { registerServeCommand } from './commands/serve.js';
import { registerBrowserCommand } from './commands/browser.js';
import { registerCronCommand } from './commands/cron.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerGatewayCommand } from './commands/gateway.js';

// 顶层崩溃报告（阶段 11 Task 4）：uncaughtException → ~/.harness2/crash/<ISO>.log（redact
// 后）+ 控制台路径与手动反馈指引；无遥测，零网络发送。
installCrashReporter();

const program = new Command();

program.name('harness2').description('跨端 AI agent harness').version(CORE_VERSION);

// —— 命令注册：各子命令模块把命令挂到 program（注册顺序与拆分前一致）——
registerTrajCommands(program);
registerExportReplayCommands(program);
registerConfigCommand(program);
registerDoctorCommand(program);
registerChatCommand(program);
registerMemoryCommand(program);
registerSkillCommand(program);
registerServeCommand(program);
registerBrowserCommand(program);
registerCronCommand(program);
registerPluginCommand(program);
registerMcpCommand(program);
registerGatewayCommand(program);

void program.parseAsync(process.argv);
