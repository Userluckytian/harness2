// 桌面 Teams 视图的本地数据形状（A11）。
//
// 与 core `@harness2/core` 的 TeamState 结构兼容（字段名对齐），但**刻意不复用其类型**：
// 渲染进程零 Node、编译目标是浏览器包，core 是 ESM-only 的 node 包；视图只消费这几列只读事实，
// 自持一份窄形状即可（core 的 TeamState 可结构化赋给本形状）。状态词保留为 string，
// 渲染时按值着色，未知值不造词（红线⑩：不摆假条目）。

export interface TeamsViewMember {
  readonly name: string;
  /** idle | running | done | failed | stopped */
  readonly status: string;
  readonly rounds: number;
  readonly writeMode: 'readonly' | 'write';
  readonly model?: string;
  readonly childSessionId?: string;
  readonly outputPreview?: string;
  readonly error?: string;
}

export interface TeamsViewTask {
  readonly taskId: string;
  readonly title: string;
  /** todo | claimed | done | failed | blocked */
  readonly status: string;
  readonly owner?: string;
  readonly dependsOn: readonly string[];
}

export interface TeamsViewMessage {
  readonly messageId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'board' | 'direct';
  readonly text: string;
}

export interface TeamsViewTeam {
  readonly teamId: string;
  readonly name: string;
  readonly description: string;
  /** running | stopped | failed */
  readonly status: string;
  readonly members: readonly TeamsViewMember[];
  readonly tasks: readonly TeamsViewTask[];
  readonly messages: readonly TeamsViewMessage[];
}
