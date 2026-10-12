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

  // —— Z8-1 任务工具栏（Z-07 #5 / Z-08） ——
  /** 分段控件无障碍名（视图模式） */
  viewModeLabel: string;
  /** 分段控件：分组 */
  viewModeGrouped: string;
  /** 分段控件：项目（默认） */
  viewModeProject: string;
  /** 全部收起（有分组展开时） */
  collapseAll: string;
  /** 全部展开（分组全收起时） */
  expandAll: string;
  /** 筛选和排序按钮文案 */
  filterSort: string;
  /** 排序分组标题 */
  sortBy: string;
  /** 排序：更新时间 */
  sortByUpdated: string;
  /** 排序：名称 */
  sortByName: string;
  /** 筛选分组标题 */
  filter: string;
  /** 筛选：全部 */
  filterAll: string;
  /** 筛选：运行中 */
  filterRunning: string;
  /** 筛选：未读 */
  filterUnread: string;
  /** 归档视图开关 */
  archiveView: string;
  /** 归档视图下无归档会话 */
  noArchived: string;
  /** 分组模式下的「会话」区标题（复用会话文案的等价项） */
  conversations: string;
  /** 项目区标题 */
  projects: string;
  /** 无 cwd 的会话所在分组的标题 */
  noProject: string;
  /** Pinned 区标题 */
  pinned: string;
  /** Pinned 区「显示全部」（折叠溢出时） */
  pinnedShowAll: (hidden: number) => string;
  /** 取消置顶（Pinned 行上的按钮） */
  unpin: string;
  /** 置顶标记的无障碍名（leading 槽） */
  pinnedMarkLabel: string;
  /** 未读标记的无障碍名（leading 槽） */
  unreadLabel: string;
  /** 运行中标记的无障碍名（leading 槽） */
  runningLabel: string;
  /** 行元信息：消息条数 */
  messageCount: (count: number) => string;
  /** —— 右键菜单（Z-10 可兑现子集；无通道的项不渲染） —— */
  menuPin: string;
  menuUnpin: string;
  menuRename: string;
  menuArchive: string;
  menuUnarchive: string;
  menuOpenInSplit: string;
  /** 分屏已满 4 格时禁用项的 title（不摆点了不动的假项） */
  menuSplitLimit: string;
  menuTrajectory: string;
  /** 重命名对话框 */
  renameTitle: string;
  renamePlaceholder: string;
  renameConfirm: string;
  renameCancel: string;
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
  viewModeLabel: '视图模式',
  viewModeGrouped: '分组',
  viewModeProject: '项目',
  collapseAll: '收起全部',
  expandAll: '展开全部',
  filterSort: '筛选和排序',
  sortBy: '排序',
  sortByUpdated: '更新时间',
  sortByName: '名称',
  filter: '筛选',
  filterAll: '全部',
  filterRunning: '运行中',
  filterUnread: '未读',
  archiveView: '归档',
  noArchived: '暂无归档会话',
  conversations: '会话',
  projects: '项目',
  noProject: '无项目',
  pinned: '置顶',
  pinnedShowAll: (hidden) => `显示全部（另 ${hidden}）`,
  unpin: '取消置顶',
  pinnedMarkLabel: '已置顶',
  unreadLabel: '未读',
  runningLabel: '运行中',
  messageCount: (count) => `${count} 条`,
  menuPin: '置顶',
  menuUnpin: '取消置顶',
  menuRename: '重命名',
  menuArchive: '归档',
  menuUnarchive: '取消归档',
  menuOpenInSplit: '在分屏打开',
  menuSplitLimit: '分屏已达上限（4 格）',
  menuTrajectory: '查看 Model Trajectory',
  renameTitle: '重命名会话',
  renamePlaceholder: '输入新名称',
  renameConfirm: '保存',
  renameCancel: '取消',
};
