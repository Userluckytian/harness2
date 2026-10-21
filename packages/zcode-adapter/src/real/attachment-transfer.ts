import { Event } from '@zcode/rpc';
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
} from '@zcode/services';

/**
 * 本地附件暂存服务（ZS3-T3）：
 * - stage 零拷贝：直接返回 localPath 作为 ref，不复制字节、不发 RPC；
 * - adopt/cancel/cleanup 为 no-op（本地没有跨机暂存事务）；
 * - 进度事件永不触发（本地路径瞬时可用）。
 *
 * 远端（SSH/WSL/Docker）传输归 ZS4/后续；这里给显式桩而不是默认 B 类 throw，
 * 避免本地附件选择路径一调用就炸。
 */
export function createLocalPromptAttachmentTransferService(): IPromptAttachmentTransferService {
  return {
    async stage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult> {
      return {
        operationId: params.operationId,
        ref: params.localPath,
        bytes: params.sizeBytes ?? 0,
        staged: true,
      };
    },
    async adopt(): Promise<void> {},
    async cancel(): Promise<void> {},
    async cleanup(): Promise<void> {},
    onDynamicProgress() {
      return Event.None;
    },
  };
}
