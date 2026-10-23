# ZS6 Release 草案（V9 人类材料，2026-10-23）

> 状态：**草案就绪，发布动作全部人类执行**（AGENTS 红线：`git tag`/GitHub Release/分发=人类亲手）。本文件=可直接粘贴的文案 + 待决清单。
> 基线：harness2 main `eaa8e85`（T5 后）；ZS 程序=ZCode 壳（scratch `247b4c0e`=锚点 `3c5b2276`+P1–P11）+ harness2 内心（adapter+core）。

## 1. Tag 建议（三选一，人类定）

| 方案 | tag | 理由 |
| --- | --- | --- |
| A（推荐） | `harness2-desktop/3.16.2-win1` | 产品名/壳版本(win 首发)/渠道透明；后续 mac/portable 迭代不互踩 |
| B | `v3.16.2` | 跟随壳版本语义；但与旧 Z 程序 tag 序列（v1.0.x）断档易混 |
| C | `zs1-r1` | 程序内部序数语义；对外不友好 |

打 tag 前建议顺手打归档 tag `pre-zs-retirement`（指向同一提交，T4 退役案的可复原锚点，人类一并执行）。

## 2. GitHub Release 草案文案（粘贴即用）

```markdown
# Harness2 Desktop 3.16.2 (win x64)

ZCode 壳 + harness2 内心 —— 本地优先的编码代理桌面端。Apache-2.0。

## 下载（win x64）
| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `Harness2 Desktop-3.16.2-win32-x64.exe`（安装器） | 170.5 MB | `8C15C7A20B901C68536D1253263409A30463FCAD6721248C6E447552658C7FE8` |
| `Harness2 Desktop-3.16.2-win32-x64-portable.exe`（免安装） | 170.2 MB | `A85E6B831714F7FACC865DE93B7F146ACB1DF86A2D3982250E753CAA9FFD0A80` |

> ⚠️ 未签名构建（本机打包通道无证书；SmartScreen 会警告「未知发布者」，属预期）。签名/图标/正式品牌名=后续运营面。

## 亮点
- 真实对话/工具流/审批（deny 可见「执行失败」）/侧栏会话管理与删除/附件与多模态
- provider 设置：添加供应商 + 「获取模型」勾选导入（ZS4.5）
- 观测性：崩溃本地归因报告（零遥测）/ 资源管理器实时 host 行 / boot-timing 日志（ZS5）
- 数据全在本地 `~/.harness2`（core 会话 JSONL），无登录、无云端账号

## 已知限制
- 仅 Windows x64；macOS/Linux 未打包
- 无自动更新（不接 updater 链）
- 品牌=工作名「Harness2 Desktop」，正式名与 logo 待定
- 首次运行任务栏/EXE 图标沿用构建通道现图（未换 logo）
```

## 3. 装机验收清单（人类跑，全过=V9 关闭）

1. NSIS 安装→开始菜单/桌面出现「Harness2 Desktop」；添加删除程序列表名一致；卸载干净。
2. 首启直达空态（无登录门）；「新建会话」→真 key 对话（`~/.harness2` 配好）：流式回复+工具卡正常。
3. 设置→模型服务商：已有 provider 正常；「获取模型」→勾选→保存=**只进勾选项**（ZS4.5g 回归点）。
4. 侧栏：历史会话列出/重命名/删除（删后重启不再现）。
5. 审批流触发一次并拒绝=「执行失败」行出现。
6. Help→「关于 Harness2 Desktop」窗内容正确；任务栏悬停标题=Harness2 Desktop；托盘（若开）=打开 Harness2 Desktop。
7. 假入口复核=对照 `zs6-hide-audit.md` 处置后列（无 usage/remoteDevices 分区、无 Z.ai/Start Plan、Help 无运营外链）。
8. 崩溃报告抽查（可选）：`~/.harness2/crash/` 有结构、无密钥明文。
9. portable 版同 1–3 步简验。

## 4. 待人类供给面（发版可并行）

- 正式产品名（替「Harness2 Desktop」工作名）与 logo 源文件（icon.ico + installer 图）→ 替换 `packages/desktop/build/` 重打（zs6-pack.ps1 一键）。
- 签名证书通道（若上架/分发需要）。
- **T4 退役案拍板**（`zs6-retirement-proposal.md`，推荐案 B：删 desktop/ui-shared/web 保 cli/gateway）。
