// 钩子分区（A09，Z-89 的 `hooks`）：只读展示 config.hooks（生命周期事件上的 shell 命令）
// + 空态指引。数据通道：既有 settings:getConfig（渲染端零 Node）。
//
// 红线⑩（不摆假数据）：无 config.hooks 或零条目即空态，不造示例条目。
// 编辑面（新增/编辑/删除 hook）登记为后续：config.json 手改 + 重启 serve 生效，
// 与 mcp/skills 两分区同口径（只读优先）。
import type { SettingsConfigShape, SettingsHooksShape } from '../../../shared/settings.js';
import { SettingsSectionBlock } from '../shell/index.js';

/** 事件 → 触发时机说明（只读展示用；与 core hooks/runner.ts 的触发点一一对应） */
const EVENT_HINT: Record<string, string> = {
  sessionStart: '会话开始（内核创建会话日志时）',
  sessionEnd: '会话结束（内核关闭会话前）',
  turnEnd: '一个用户 turn 结束（runTurn 返回后）',
  preTool: '工具调用执行前（可拦截或改写输入）',
  postTool: '工具结果落盘后（输出可回注工具结果）',
};

/** 单条 hook 的展示串：matcher（如有）→ 命令；作为只读行 */
export function describeHookEntry(entry: SettingsHooksShape['entries'][number]): string {
  const matcher = entry.matcher !== undefined && entry.matcher.length > 0 ? `匹配 ${entry.matcher} · ` : '';
  return `${matcher}${entry.command}`;
}

export function HooksSection({ cfg }: { cfg: SettingsConfigShape }): React.ReactNode {
  const hooks = cfg.hooks;
  const entries = hooks?.entries ?? [];
  return (
    <>
      <SettingsSectionBlock title="钩子" desc="在 agent 生命周期事件上运行 shell 命令（config.json hooks）">
        {hooks === undefined ? (
          <div className="settings-desc" data-hooks-empty>
            未配置钩子。在 ~/.harness2/config.json 的 hooks 段声明后（事件 + 命令）重启 serve 生效。
          </div>
        ) : (
          <>
            <div className="settings-table" data-hooks-summary>
              <div className="settings-table-row">
                <span className="row-key">启用</span>
                <span className="row-val">{hooks.enabled ? '是' : '否（hooks.enabled=false）'}</span>
              </div>
              <div className="settings-table-row">
                <span className="row-key">默认超时</span>
                <span className="row-val">{hooks.timeoutMs} ms</span>
              </div>
              <div className="settings-table-row">
                <span className="row-key">输出上限</span>
                <span className="row-val">{hooks.maxOutputBytes} 字节（超出截断）</span>
              </div>
            </div>
            <div className="settings-table" data-hooks-list>
              {entries.length === 0 && <div className="settings-desc">未配置钩子条目</div>}
              {entries.map((entry, index) => (
                <div
                  key={`${entry.event}-${index}`}
                  className="settings-table-row"
                  data-hook-row={`${entry.event}-${index}`}
                >
                  <span className="row-key">{entry.event}</span>
                  <span className="row-val">{EVENT_HINT[entry.event] ?? '（未知事件）'}</span>
                  <span className="row-val mono">{describeHookEntry(entry)}</span>
                  <span className="row-val">
                    {entry.enabled === false ? '停用' : '启用'}
                    {entry.timeoutMs !== undefined ? ` · ${entry.timeoutMs}ms` : ''}
                    {entry.async === true ? ' · 异步' : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="settings-note">
          钩子命令来自 config.json（与权限规则同级信任），在 preTool/postTool/turnEnd 等事件上执行； 执行结果以
          hook/invocation 扩展事件落盘（仅本地，无遥测）。失败默认 fail-open（不阻断工具执行）。
        </p>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="编辑" desc="当前为只读展示（编辑面见后续版本）">
        <p className="settings-note">
          新增/修改/删除钩子请在 ~/.harness2/config.json 的 hooks 段编辑：entries 每条声明 event
          （sessionStart/sessionEnd/turnEnd/preTool/postTool）、command（shell 命令），可选 matcher （glob，仅
          preTool/postTool）与 timeoutMs。保存后重启 serve 生效；GUI 编辑登记为后续版本。
        </p>
      </SettingsSectionBlock>
    </>
  );
}
