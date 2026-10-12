// P0「自动化」主区视图的**定时任务模板**（纯数据，壳无关）。
//
// 四张卡片的标题 / 描述 / 调度展示 **逐字对齐 ZCode 官方实测**（2026-10-11 真浏览器 :5173），
// 不改写不新增模板；红色线⑩：模板文案照抄实测，不编造别的模板。
//
// 每张卡携带两个调度口径：
//   - `schedule`：写入 cron 的**调度表达式**（core `parseSchedule` 可解析的形态）；
//   - `scheduleLabel`：卡片上展示的一行**人话**（逐字实测；与 core `describeSchedule` 的输出并非
//     逐字一致 —— 实测展示为「每工作日 09:00」，而 describeSchedule 回显「每周一、二、三、四、五 09:00」，
//     故此处独立保留实测展示串，不做两口径互推）。
// 创建动作 = 以 `instruction`（模板描述即指令）+ `schedule` 调注入的 onCreateFromTemplate 回调，
// 由壳决定真通道（桌面 IPC cron:add）或占位（web 无通道 → 卡片 disabled）。

/** 定时任务模板（卡片标题 + 指令正文 + 调度表达式 + 展示用调度行） */
export interface AutomationTemplate {
  /** 稳定 id（测试与 key 用；不作为任务内容） */
  readonly id: string;
  /** 卡片标题（逐字实测） */
  readonly title: string;
  /** 指令正文（逐字实测；创建任务时作为 instruction） */
  readonly instruction: string;
  /** 写入 cron 的调度表达式（core parseSchedule 可解析） */
  readonly schedule: string;
  /** 卡片展示的一行调度（逐字实测） */
  readonly scheduleLabel: string;
}

/** 四张模板卡（顺序即实测顺序；文案逐字照抄，勿改勿增） */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'morning-digest',
    title: '晨会动态',
    instruction:
      '汇总上一个工作日以来的提交、模块变化、CI 状态和待跟进事项，最终生成不超过 6 条的晨会口述摘要。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。',
    schedule: 'weekly 1,2,3,4,5 09:00',
    scheduleLabel: '每工作日 09:00',
  },
  {
    id: 'risk-scan',
    title: '风险扫描',
    instruction:
      '检查最近 24 小时的代码变更，识别运行错误、数据丢失、权限绕过、资源泄漏及跨端兼容等高置信风险，并附代码和 commit/diff 证据。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。',
    schedule: 'daily 10:00',
    scheduleLabel: '每天 10:00',
  },
  {
    id: 'release-brief',
    title: '发布简报',
    instruction:
      '整理本周合并的 PR 和 commit，按功能、修复、体验及工程改进分类，同时生成团队版和面向用户的精简发布说明。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。',
    schedule: 'weekly 5 16:00',
    scheduleLabel: '每周五 16:00',
  },
  {
    id: 'docs-sync',
    title: '文档同步检查',
    instruction:
      '对照最近 7 天的代码、配置、接口与文档变更，识别已改变公开行为但文档尚未同步的高置信差异，并附文件路径和 commit/diff 证据，给出应更新的文档位置与要点。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。',
    schedule: 'weekly 3 15:00',
    scheduleLabel: '每周三 15:00',
  },
] as const;
