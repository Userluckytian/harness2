import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { TOOL_NAME_PATTERN, type ToolDefinition } from '../src/tools/types.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  execute: async (args) => ({ output: JSON.stringify(args) }),
};

describe('ToolRegistry', () => {
  it('register 返回 disposer：dispose 后 get/list 不再包含，且可重新注册同名', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(echoTool);
    expect(reg.get('echo')).toBe(echoTool);
    expect(reg.list()).toEqual([echoTool]);
    expect(reg.size).toBe(1);

    dispose();
    expect(reg.get('echo')).toBeUndefined();
    expect(reg.list()).toEqual([]);
    expect(reg.size).toBe(0);

    const dispose2 = reg.register(echoTool); // dispose 后允许重注册
    expect(reg.get('echo')).toBe(echoTool);
    dispose2();
  });

  it('重名注册抛错（不静默覆盖）；disposer 不误伤后来者', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/);
    expect(reg.get('echo')).toBe(echoTool);
    dispose();
    expect(reg.get('echo')).toBeUndefined();
  });

  it('非法工具名抛错；TOOL_NAME_PATTERN 约束 ^[a-z0-9_]+$', () => {
    const reg = new ToolRegistry();
    for (const bad of ['Echo', 'with-dash', 'with space', '', '中文']) {
      expect(() => reg.register({ ...echoTool, name: bad })).toThrow(/invalid tool name/);
    }
    for (const good of ['read', 'edit_file', 'g9']) {
      expect(TOOL_NAME_PATTERN.test(good)).toBe(true);
      expect(() => reg.register({ ...echoTool, name: good })).not.toThrow();
    }
  });
});
