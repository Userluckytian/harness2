// 工具注册表：注册即返回 disposer（D4「注册即可逆」思想）；
// 重名注册与非法名称抛错，杜绝静默覆盖。
import { TOOL_NAME_PATTERN, type ToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** 注册工具并返回 disposer（调用后工具被移除，可重复注册同名） */
  register(def: ToolDefinition): () => void {
    if (!TOOL_NAME_PATTERN.test(def.name)) {
      throw new Error(`invalid tool name "${def.name}": must match ${TOOL_NAME_PATTERN}`);
    }
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
    return () => {
      // 只移除自己注册的那个实例（期间被 disposer 后又重注册的场景不误伤）
      if (this.tools.get(def.name) === def) this.tools.delete(def.name);
    };
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 注册顺序快照（供循环遍历与 ChatRequest.tools 投影） */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }
}
