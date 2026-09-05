// 内置基础工具集装配：registerBuiltinTools(registry) 一次注册全部，返回总 disposer。
import type { ToolRegistry } from '../registry.js';
import { bashTool } from './bash.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';

export { bashTool, readTool, writeTool, editTool, globTool, grepTool };

/** 内置工具清单（注册顺序即 ChatRequest.tools 顺序） */
export const builtinTools = [bashTool, readTool, writeTool, editTool, globTool, grepTool] as const;

export function registerBuiltinTools(registry: ToolRegistry): () => void {
  const disposers = builtinTools.map((tool) => registry.register(tool));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
