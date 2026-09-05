#!/usr/bin/env node
// harness2 CLI 入口。阶段 1 提供 traj 命令（Task 4 挂接）。
import { Command } from 'commander';

const program = new Command();

program.name('harness2').description('跨端 AI agent harness').version('0.1.0');

program.parseAsync(process.argv);
