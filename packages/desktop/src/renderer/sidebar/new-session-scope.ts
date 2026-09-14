// 新会话作用域优先级（依据 refs-deepseek-harness.md D-21）：
//   工作区选择优先级：显式指定 → 当前会话所属 → 最近活跃 → 空白。
//   一个工作区都没有时清空选择，进入空白新会话（不伪造工作区）。
// 纯函数：装配层只提供数据（当前会话 cwd、工作区列表与最近活跃序），
// 判定顺序由本模块唯一决定，避免各调用点各解释一遍优先级。

/** 新会话落点：带工作区，或空白新会话 */
export type NewSessionScope =
  | {
      kind: 'workspace';
      workspaceId: string;
      /** 命中该工作区所依据的优先级档位（显式指定 > 当前会话 > 最近活跃） */
      source: 'explicit' | 'current-session' | 'recent';
    }
  | { kind: 'blank'; source: 'none' };

/** D-21 判定输入 */
export interface NewSessionScopeInput {
  /** 作用域操作明确指定的工作区（最高优先级） */
  explicitWorkspaceId?: string | null | undefined;
  /** 当前会话所属工作区（次高优先级） */
  currentSessionWorkspaceId?: string | null | undefined;
  /** 最近活跃工作区 id，最近者在前（第三优先级取首项） */
  recentWorkspaceIds?: readonly string[] | undefined;
  /**
   * 已知工作区集合。给了就校验前两档与最近活跃序（不认识的工作区 id 不采用，
   * 继续往下走）；不给则不校验（装配层自担数据正确性）。
   */
  knownWorkspaceIds?: readonly string[] | undefined;
}

/** 去空白后非空才算给值 */
function clean(id: string | null | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 按 D-21 顺序解析新会话作用域。
 * @param input - 显式指定 / 当前会话所属 / 最近活跃 / 已知集合。
 * @returns 命中的工作区与档位；四档全落空则是 `{ kind: 'blank' }`。
 */
export function resolveNewSessionScope(input: NewSessionScopeInput): NewSessionScope {
  const known = input.knownWorkspaceIds;
  const accepts = (id: string | undefined): id is string =>
    id !== undefined && (known === undefined || known.includes(id));

  const explicit = clean(input.explicitWorkspaceId);
  if (accepts(explicit)) return { kind: 'workspace', workspaceId: explicit, source: 'explicit' };

  const current = clean(input.currentSessionWorkspaceId);
  if (accepts(current)) return { kind: 'workspace', workspaceId: current, source: 'current-session' };

  for (const candidate of input.recentWorkspaceIds ?? []) {
    const recent = clean(candidate);
    if (accepts(recent)) return { kind: 'workspace', workspaceId: recent, source: 'recent' };
  }

  return { kind: 'blank', source: 'none' };
}
