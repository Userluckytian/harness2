// 侧栏文案（默认中文；装配层可覆盖任意子集）。
// 与上游一样不走 i18n 运行时：文案是纯数据入参，缺省即可用。

export interface SidebarLabels {
  /** 新建任务按钮文字（展开态；Z-16 #1 改「新建任务」） */
  newSession: string;
  /** 新建任务按钮无障碍名（展开/轨道共用） */
  newSessionLabel: string;
  /** 搜索入口文字（Z-16 #2：原「命令中心」，行为仍开命令面板） */
  commandCenter: string;
  /** 搜索入口无障碍名（按钮无可见文字时用） */
  commandCenterLabel: string;
  /** 搜索快捷键提示（与现有 Ctrl+K 唤出链路一致，不臆造） */
  commandCenterHint: string;
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
  /** Z-16 #9：第二个 section（无项目归属的游离任务）文案（原「会话」类文案改「任务」） */
  tasks: string;
  /** Z-16 #7：空项目组占位文案 */
  noTasks: string;
  /** U2 批D（D6）：项目区 0 组（空侧栏保骨架）占位文案 */
  noProjects: string;
  /** Z-16 #6/#9：分区头「移动分区」把手（纯占位，无通道） */
  moveSection: string;
  /** 移动把手占位悬停说明（红线⑩：disabled + 说明 + data-placeholder） */
  moveSectionTodo: string;
  /** 组头「添加项目」钮（有通道 = 真动作：接目录选择） */
  addProject: string;
  /** 添加项目无通道时的悬停说明（web：disabled 占位） */
  addProjectTodo: string;
  /** 组头「移出项目」入口文案（U2 批D / D5：从组头独立钮收进「更多」⋯ 下拉末项「移除」） */
  removeProject: string;
  /** ⋯ 下拉末项「移除」（Z-49：入口=项目行「更多」下拉最后一项「移除」，XIcon） */
  menuRemoveProject: string;
  /** 移出项目无通道时的悬停说明（web：disabled 占位） */
  removeProjectTodo: string;
  /** Z-16 #9：任务区头「新建任务」钮 */
  newTaskInSection: string;
  /** 新建任务钮无通道时的悬停说明（缺省不接线时的占位） */
  newTaskInSectionTodo: string;
  /** Z-48 #2：项目组头 hover 出现的「在此项目新建会话」（显式项目独有；聚合组无此钮） */
  newSessionInProject: string;
  /** —— Z-49 确认对话框文案（口径 = ZCode confirmDialog 族） —— */
  /** 删除会话确认标题 */
  deleteSessionTitle: string;
  /** 删除会话确认描述（软删语义如实：只从列表移除，数据保留） */
  deleteSessionDescription: string;
  /** 删除会话确认按钮（destructive） */
  deleteSessionConfirm: string;
  /** 行菜单「删除」项 */
  menuDelete: string;
  /** 行菜单「删除」在会话运行中时的禁用说明（Z-49/Denia 语义：running 禁用） */
  menuDeleteRunning: string;
  /** 移除运行中的项目确认标题（Z-49：组内有 running 会话才弹） */
  removeProjectRunningTitle: string;
  /** 移除运行中的项目确认描述 */
  removeProjectRunningDescription: string;
  /** 移除运行中的项目确认按钮（destructive） */
  removeProjectRunningConfirm: string;
  /** 对话框通用取消 */
  dialogCancel: string;
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
  /** Z-07 #3：自动化（cron）入口 */
  automationEntry: string;
  /** Z-16 #3：自动化占位槽的悬停说明（web 无本地 cron 通道） */
  automationTodo: string;
  /** Z-10：行右侧「更多」按钮的可访问名（与右键同一动作集） */
  rowMore: string;
  /** U2 批D（D7）：项目表读取失败行内轻提示的文案前缀（后接具体错误） */
  projectsLoadFailed: string;
  /** 失败提示「重试」按钮文案 */
  retry: string;
  /** 失败提示「忽略/关闭」按钮可访问名 */
  dismiss: string;
  /** 诚实占位（只占位不开发）：悬停说明 */
  pluginMarketTodo: string;
  /** Z-16 #10：footer 固定账号显示名（用户拍板：无账号体系，写死固定账号，视觉如实） */
  accountName: string;
  accountTodo: string;
}

export const DEFAULT_SIDEBAR_LABELS: SidebarLabels = {
  newSession: '新建任务',
  newSessionLabel: '新建会话',
  commandCenter: '搜索',
  commandCenterLabel: '打开搜索',
  commandCenterHint: 'Ctrl+K',
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
  tasks: '任务',
  noTasks: '暂无任务',
  noProjects: '暂无项目',
  moveSection: '移动分区',
  moveSectionTodo: '暂不支持：分区拖拽移动未实现（占位把手）',
  addProject: '添加项目',
  addProjectTodo: 'web 无目录选择通道',
  removeProject: '移出项目',
  menuRemoveProject: '移除',
  removeProjectTodo: '未接线：无项目移除通道',
  newTaskInSection: '新建任务',
  newTaskInSectionTodo: '未接线：宿主未提供新建任务通道',
  // Z-48/Z-49 文案（口径 = refs-zcode-layout.md Z-48/Z-49 的 zh-CN 文案族）
  newSessionInProject: '在此项目新建会话',
  deleteSessionTitle: '删除这个会话？',
  deleteSessionDescription: '会话将从列表移除。',
  deleteSessionConfirm: '删除',
  menuDelete: '删除',
  menuDeleteRunning: '会话正在运行，先停止再删除',
  removeProjectRunningTitle: '移除运行中的项目？',
  removeProjectRunningDescription: '历史任务不会被删除。',
  removeProjectRunningConfirm: '移除并停止运行',
  dialogCancel: '取消',
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
  automationEntry: '自动化',
  automationTodo: 'web 无本地 cron 通道',
  rowMore: '更多操作',
  projectsLoadFailed: '项目列表读取失败',
  retry: '重试',
  dismiss: '忽略',
  pluginMarketTodo: '未开发：插件市场不采纳（Z 程序登记）',
  accountName: '本地用户',
  accountTodo: '本地构建 · 无账号体系',
};
