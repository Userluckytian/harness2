/**
 * a-class-stubs —— A 类 5 频道显式桩（skills / subagents / commands / hooks / memory）
 *
 * ZS1 独立审查 P1-1 修复：这 5 个 A 类频道原走工厂默认（未显式列出的方法一律
 * `async () => null`），写路径静默 resolve null——假成功，违背登记的设计决策
 * （stub-factory.ts 头注「A 类读路径空态形状、写路径 throw——假成功比 throw 危险」）。
 * 本文件逐一对照 refs 接口定义（Z:services/src/{skills,subagents,commands,hooks,memory}）
 * 补显式桩：
 * - 读方法返回空态形状（可构造形状的读方法全部显式 impl）；
 * - 写方法（18 个，逐一核对 refs 接口）进 throws 列表（async throw = RPC rejected promise）。
 *
 * 空态实证（boot log zs1-t1-boot2 / t3-boot1 / t3-boot2）：5 频道方法零触达——
 * 形状是接口契约对齐的预置空态，非实证触达面。
 *
 * 口径登记：
 * - `capability.userScopeAvailable: false`：harness2 ZS1 无用户级目录写能力（写路径全
 *   throw），false 如实且 fail-closed——设置页导入/用户级入口禁用（红线⑩不留可点必炸）；
 *   `userScopeReason` 省略（类型仅 "desktop_only" 一值，语义不符不硬填）。
 * - 目录定位类读方法（getPrimaryUserAgentsDirectory / getPrimaryUserCommandsDirectory /
 *   getUserMemoryDirectory / readProjectMemoryFile）无空态形状可构造，且 refs UI src
 *   无消费方（全库检索仅服务实现与测试引用）——保持 A 类默认 null，ZS2 映射时定路径口径。
 * - `loadHooks.hooksEnabled: false` 与 ZCode 实现口径一致（hooks.some(h => h.enabled)，
 *   空表即 false）；workspaceHookSnapshot/trustStoreCorrupt 可选，无 workspace hook 即省略。
 */
import type {
  IHooksService,
  IMemoryService,
  ISkillsService,
  ISubagentsService,
  ICommandsService,
  ProjectMemoryWorkspaceSummary,
} from "@zcode/services";
import type {
  AgentsListResult,
  CommandsListResult,
  Hook,
  Memory,
  SkillsListResult,
  SkillsPromptContext,
} from "@zcode/shared";
import { createStubService } from "./stub-factory.js";

const skillsServiceImpl: Pick<ISkillsService, "list" | "buildPromptContext"> = {
  async list(): Promise<SkillsListResult> {
    return {
      skills: [],
      capability: { userScopeAvailable: false },
      diagnostics: [],
    };
  },
  async buildPromptContext(params: { prompt: string }): Promise<SkillsPromptContext> {
    return { prompt: params.prompt, activatedSkillNames: [] }; // 无 skills → 无激活
  },
};
/** A: 映射 core skills/ ZS2+；list 空态、buildPromptContext 无激活；启停/复制/移除/删除写路径 throw */
export const skillsServiceStub: ISkillsService = createStubService<ISkillsService>({
  channelName: "skills",
  classification: "A",
  impl: skillsServiceImpl,
  throws: ["setEnabled", "copyToCommon", "removeFromCommon", "deleteSkill"],
});

const subagentsServiceImpl: Pick<ISubagentsService, "list"> = {
  async list(): Promise<AgentsListResult> {
    return {
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: false },
      diagnostics: [],
    };
  },
};
/** A: 映射 core agent/subagent.ts（执行引擎有、定义文件 CRUD 缺口→ZS4）；list 空态；CRUD/启停/模型覆盖写路径 throw */
export const subagentsServiceStub: ISubagentsService = createStubService<ISubagentsService>({
  channelName: "subagents",
  classification: "A",
  impl: subagentsServiceImpl,
  throws: [
    "createAgent",
    "updateAgent",
    "deleteAgent",
    "setEnabled",
    "setBuiltInModelOverride",
    "setPluginAgentModelOverride",
  ],
});

const commandsServiceImpl: Pick<ICommandsService, "list"> = {
  async list(): Promise<CommandsListResult> {
    return {
      commands: [],
      userCommands: [],
      pluginCommands: [],
      capability: { userScopeAvailable: false },
    };
  },
};
/** A: 映射 core commands/ ZS2+（builtin 胶水）；list 空态；命令文件写/启停路径 throw */
export const commandsServiceStub: ICommandsService = createStubService<ICommandsService>({
  channelName: "commands",
  classification: "A",
  impl: commandsServiceImpl,
  throws: ["writeCommandFile", "updateCommandFile", "deleteCommandFile", "setCommandEnabled"],
});

const hooksServiceImpl: Pick<IHooksService, "loadHooks"> = {
  async loadHooks(): Promise<{ hooks: Hook[]; hooksEnabled: boolean }> {
    return { hooks: [], hooksEnabled: false };
  },
};
/** A: 映射 core hooks/ ZS2+；loadHooks 空态；saveHooks 与信任授予（写 trust store）throw */
export const hooksServiceStub: IHooksService = createStubService<IHooksService>({
  channelName: "hooks",
  classification: "A",
  impl: hooksServiceImpl,
  throws: ["saveHooks", "grantWorkspaceHookTrust"],
});

const memoryServiceImpl: Pick<IMemoryService, "loadMemory" | "listProjectMemories"> = {
  async loadMemory(): Promise<{ memory: Memory | null }> {
    return { memory: null }; // 无 memory 文件
  },
  async listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    return []; // 无 Project Memory
  },
};
/** A: 映射 core memory/ ZS2+；loadMemory null、listProjectMemories 空；saveMemory/clearMemory throw */
export const memoryServiceStub: IMemoryService = createStubService<IMemoryService>({
  channelName: "memory",
  classification: "A",
  impl: memoryServiceImpl,
  throws: ["saveMemory", "clearMemory"],
});
