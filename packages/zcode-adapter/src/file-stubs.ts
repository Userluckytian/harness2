/**
 * file-stubs —— IFileService 的空态形状桩（B 类频道的空态触达方法）
 *
 * B 类主体（workspace 文件索引/列式分块/搜索）归 ZS2/ZS3；但空态启动路径实证触达
 * `ensureConversationWorkspace`（Root.tsx:1176-1214 启动兜底：无恢复 tab 时必须
 * 落到默认会话工作区，失败会显示 workspace 错误横幅而非主壳空工作区）——
 * 按计划风险表预案「A 类误标的改桩返回空态形状（登记）」处理：
 * 返回 ZCODE_DATA_BASE_DIR 隔离数据根下的会话工作区路径（不写真实数据；
 * 目录由启动步骤预建，见计划执行记录）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IFileService } from '@zcode/services';
import { createStubService } from './stub-factory.js';

/** {dataBaseDir}/.zcode/workspace/default —— 与 ZCode getConversationWorkspaceDir 同规则 */
export function resolveZs1ConversationWorkspaceDir(): string {
  const baseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(baseDir, '.zcode', 'workspace', 'default');
}

const fileServiceImpl: Pick<
  IFileService,
  'ensureConversationWorkspace' | 'createDefaultWorkspace' | 'createScratchWorkspace' | 'resolvePath'
> = {
  async ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: 'conversation';
  }> {
    const path = resolveZs1ConversationWorkspaceDir();
    const created = !existsSync(path);
    if (created) {
      mkdirSync(path, { recursive: true });
    }
    return { path, created, workspacePurpose: 'conversation' };
  },
  async createDefaultWorkspace(): Promise<{ path: string }> {
    return { path: resolveZs1ConversationWorkspaceDir() };
  },
  async createScratchWorkspace(params: { name: string }): Promise<{ path: string }> {
    return { path: join(resolveZs1ConversationWorkspaceDir(), '..', 'scratch', params.name) };
  },
  async resolvePath(params: { path: string }): Promise<string> {
    return params.path;
  },
};

/** B: workspace 文件索引 ZS2/ZS3；ensureConversationWorkspace 等空态方法返回空态形状 */
export const fileServiceStub: IFileService = createStubService<IFileService>({
  channelName: 'file',
  classification: 'B',
  impl: fileServiceImpl,
});
