// MCP 服务器分区（A07，Z-89 的 `mcp`）：服务器列表只读展示（config.mcpServers）+
// 文档指引。与 plugins 分区拆开对齐 ZCode 的独立 mcp 分区；同一份 config.json 数据面
// 经既有 settings:getConfig 通道读取（渲染端零 Node）。
//
// 红线⑩（不摆假状态）：serve 无 MCP 连接状态查询端点（McpManager 在 serve 进程内，
// 未暴露 status() 的 HTTP 面）——**不渲染连接状态列/状态点**，如实登记「状态查看走 CLI
// harness2 mcp list」（复用内核同一 manager 的 status 快照），后续批次补 serve 端点后再上。
import type { SettingsConfigShape } from '../../../shared/settings.js';
import { SettingsSectionBlock } from '../shell/index.js';

/** 单行展示串：stdio = command + args；http = url（与 config.json 字段一一对应，只读） */
export function describeMcpServer(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return '（非法配置项）';
  const m = entry as Record<string, unknown>;
  if ('command' in m) {
    const args = Array.isArray(m['args']) ? (m['args'] as string[]).join(' ') : '';
    return `stdio: ${String(m['command'])}${args.length > 0 ? ` ${args}` : ''}`;
  }
  if ('url' in m) return `http: ${String(m['url'])}`;
  return '（既无 command 也无 url）';
}

export function McpServersSection({ cfg }: { cfg: SettingsConfigShape }): React.ReactNode {
  const names = Object.keys(cfg.mcpServers);
  return (
    <>
      <SettingsSectionBlock
        title="MCP 服务器"
        desc="config.json mcpServers（stdio / streamable HTTP），工具以 mcp__<server>__<tool> 注入"
      >
        <div className="settings-table" data-mcp-server-list>
          {names.length === 0 && <div className="settings-desc">未配置 MCP 服务器</div>}
          {names.map((name) => (
            <div key={name} className="settings-table-row" data-mcp-server-row={name}>
              <span className="row-key">{name}</span>
              <span className="row-val mono">{describeMcpServer(cfg.mcpServers[name])}</span>
            </div>
          ))}
        </div>
        <p className="settings-note">
          服务器增删请在 ~/.harness2/config.json 的 mcpServers 字段中编辑（stdio 填 command/args，HTTP 填 url）；
          保存后重启 serve 生效。连接与重试策略：单服务器失败退避重启（上限 3 次），不拖垮其他服务器。
        </p>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="连接状态" desc="本页暂无状态数据面（不展示非真实状态）">
        <p className="settings-note">
          连接状态需 serve 进程内的 McpManager 快照，当前无查询端点——此处不显示状态，避免误导。 可在 CLI 用 harness2 mcp
          list 查看各服务器 connected/restarting/down 状态。
        </p>
      </SettingsSectionBlock>
    </>
  );
}
