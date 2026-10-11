// 侧栏文案（默认中文；装配层可覆盖任意子集）。
// 与上游一样不走 i18n 运行时：文案是纯数据入参，缺省即可用。

export interface SidebarLabels {
  /** 新会话按钮文字（展开态） */
  newSession: string;
  /** 新会话按钮无障碍名（展开/轨道共用） */
  newSessionLabel: string;
  /** 命令中心入口文字（Z-07 分区 2） */
  commandCenter: string;
  /** 命令中心入口无障碍名（按钮无可见文字时用） */
  commandCenterLabel: string;
  /** 命令中心快捷键提示（与现有 Ctrl+K 唤出链路一致，不臆造） */
  commandCenterHint: string;
  /** 收缩侧栏按钮 */
  collapse: string;
  /** 打开（展开）侧栏按钮 */
  expand: string;
  /** 品牌行本地构建标签（无版本元数据时的回落文案） */
  brandLocalBuild: string;
  /** 区域席位标题 */
  sessions: string;
  /** 侧栏根节点无障碍名 */
  sidebar: string;
  /** 轨道态区域图标的无障碍名 */
  sessionsRail: string;
  /** 搜索框占位/无障碍名 */
  searchPlaceholder: string;
  /** 一条会话都没有 */
  noSessions: string;
  /** 有查询但无匹配 */
  noMatch: string;
  /** 主列表为空但存在归档会话 */
  allArchived: string;
  /** 归档区开关文案（带条数） */
  archived: (count: number) => string;
}

export const DEFAULT_SIDEBAR_LABELS: SidebarLabels = {
  newSession: '新会话',
  newSessionLabel: '新建会话',
  commandCenter: '命令中心',
  commandCenterLabel: '打开命令中心',
  commandCenterHint: 'Ctrl+K',
  collapse: '收起侧边栏',
  expand: '打开侧边栏',
  brandLocalBuild: '本地构建',
  sessions: '会话',
  sidebar: '侧栏',
  sessionsRail: '展开侧边栏以浏览会话',
  searchPlaceholder: '搜索会话…',
  noSessions: '暂无会话',
  noMatch: '无匹配会话',
  allArchived: '会话都在归档区',
  archived: (count) => `已归档（${count}）`,
};
