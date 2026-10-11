// 桌面 Teams 视图数据源（A11 批次6-B，最小只读）。
//
// 立场（D-14 渲染端禁持久化 / 红线① 不落盘的不显示）：
//   - 本 store 只保存**已被 core Teams 编排层落盘并投影出来**的团队快照（来自 `team/event`
//     与 `team/message` 扩展事件），渲染端不自己造团队/任务/消息；
//   - 视图状态只在内存（模块级单例，subscribe/getSnapshot 走 useSyncExternalStore），
//     不写任何浏览器存储；
//   - **缺口登记**：桌面桥（`window.harness2` / serve WS）当前没有 Teams 数据通道，
//     故 `setTeams` 是**留缝**——真实数据接入前视图恒为空态（绝不摆假条目，红线⑩）。
//     待主进程/服务端新增 Teams 快照通道后，只在此处喂数即可，面板无需改动。
import type { TeamsViewTeam } from './types.js';

export interface TeamsViewSnapshot {
  readonly teams: readonly TeamsViewTeam[];
}

const EMPTY: TeamsViewSnapshot = Object.freeze({ teams: Object.freeze([]) as readonly TeamsViewTeam[] });

/** 内存单例 store（可被测试直接播种；真实通道接入前为留缝） */
export class TeamsViewStore {
  private snapshot: TeamsViewSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TeamsViewSnapshot => this.snapshot;

  /** 播种/覆盖团队快照（空数组 = 回到空态）。相同引用不触发订阅通知。 */
  setTeams(teams: readonly TeamsViewTeam[]): void {
    if (this.snapshot.teams === teams) return;
    this.snapshot = Object.freeze({ teams });
    for (const listener of [...this.listeners]) listener();
  }

  /** 清空（测试隔离/断线复位） */
  clear(): void {
    if (this.snapshot === EMPTY) return;
    this.snapshot = EMPTY;
    for (const listener of [...this.listeners]) listener();
  }
}

/** 应用级单例：桌面 Teams 视图的数据源 */
export const teamsViewStore = new TeamsViewStore();

/** 是否有可展示团队（壳的渲染判定谓词；空 → 不渲染槽位，不占位） */
export function teamsViewHasContent(snapshot: TeamsViewSnapshot = teamsViewStore.getSnapshot()): boolean {
  return snapshot.teams.length > 0;
}
