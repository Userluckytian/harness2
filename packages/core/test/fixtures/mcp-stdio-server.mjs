// MCP stdio 测试夹具（阶段 8）：最小 MCP server（echo 工具），经 StdioServerTransport 通信。
// 由 packages/core/test/mcp.test.ts 以 process.execPath spawn；bare import 从本目录向上
// 解析到 packages/core/node_modules/@modelcontextprotocol/sdk，零外部依赖。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stdio-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显输入',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `stdio-echo:${req.params.arguments?.msg ?? ''}` }],
}));
await server.connect(new StdioServerTransport());
