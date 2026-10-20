// 桩行为单测：C 静默 / B throw / Root 挂载 9 服务空态形状（V3 后半）
import { describe, expect, it } from "vitest";
import { ProxyChannel, Event } from "@zcode/rpc";
import {
  ICredentialService,
  IFileService,
  IOAuthService,
  ISettingService,
  ISystemService,
  IZCodeAgentService,
} from "@zcode/services";
import { createHarness2Services } from "../src/createHarness2Services.js";
import {
  broadcastServiceStub,
  codingPlanSubscriptionServiceStub,
  credentialServiceStub,
  modelSelectionServiceStub,
  oauthServiceStub,
  projectServiceStub,
  providerSettingsServiceStub,
  settingServiceStub,
  sourceServerManagementServiceStub,
  taskGroupServiceStub,
  windowControllerServiceStub,
  zcodeAgentServiceStub,
} from "../src/root-mount-stubs.js";

describe("C 类静默空实现（调用返回空值不炸）", () => {
  it("oauth 读路径：getProviders→[]、restoreCachedSessionState→authenticated 本地身份（无登录门，编排者 2026-10-20 指示）", async () => {
    await expect(oauthServiceStub.getProviders()).resolves.toEqual([]);
    await expect(oauthServiceStub.getActiveProvider()).resolves.toBeNull();
    await expect(oauthServiceStub.restoreCachedSessionState()).resolves.toEqual({
      status: "authenticated",
      userInfo: { id: "harness2-local", username: "harness2", displayName: "harness2" },
    });
  });

  it("oauth 登录动作显式 throw（不假成功）", async () => {
    await expect(oauthServiceStub.startOAuth("zai")).rejects.toThrow(/ZS1: not implemented/);
  });

  it("coding-plan 读路径 fail-closed：动态工作流 disabled/default", async () => {
    await expect(codingPlanSubscriptionServiceStub.getDynamicWorkflowClientConfig()).resolves.toEqual(
      { mode: "disabled", enabled: false, source: "default", offeredMode: "disabled" },
    );
    await expect(codingPlanSubscriptionServiceStub.getStaticProducts()).resolves.toEqual({});
    await expect(codingPlanSubscriptionServiceStub.getStartPlanPreview()).resolves.toBeNull();
  });

  it("coding-plan 支付动作 throw", async () => {
    await expect(codingPlanSubscriptionServiceStub.payStripe({} as never)).rejects.toThrow(
      /ZS1: not implemented/,
    );
  });

  it("source-server-management.getSnapshot 返回空 snapshot（boot log 空态实证触达）", async () => {
    const snapshot = await sourceServerManagementServiceStub.getSnapshot();
    expect(snapshot).toEqual({
      generation: 0,
      profiles: [],
      servers: [],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    });
  });

  it("C 类默认（未显式实现的方法）返回 null 不炸：usage-stats 抽查", async () => {
    const { services } = createHarness2Services();
    // usageStatsServiceStub 未显式实现任何方法 → C 默认 async () => null
    const usage = services.getOptional(
      (await import("@zcode/services")).IUsageStatsService,
    );
    await expect(
      usage!.getAppUsageSnapshot({} as never),
    ).resolves.toBeNull();
  });
});

describe("B 类显式 throw（v4 竖切 ZS2/ZS3）", () => {
  it("zcode-agent：syncAppRuntimePreferences 空态 void，v4 竖切方法 throw", async () => {
    await expect(
      zcodeAgentServiceStub.syncAppRuntimePreferences({} as never),
    ).resolves.toBeUndefined();
    await expect(zcodeAgentServiceStub.helloConversationV4()).rejects.toThrow(
      /ZS1: not implemented/,
    );
    await expect(
      zcodeAgentServiceStub.subscribeConversationV4({} as never),
    ).rejects.toThrow(/ZS1: not implemented/);
  });

  it("file：空态方法（ensureConversationWorkspace）返回隔离数据根路径，其余 throw（workspace 文件索引归 ZS2/ZS3）", async () => {
    const { services } = createHarness2Services();
    const file = services.getOptional(IFileService)!;
    const workspace = await file.ensureConversationWorkspace();
    expect(workspace.workspacePurpose).toBe("conversation");
    expect(workspace.path).toContain(".zcode");
    await expect(file.readdir({} as never)).rejects.toThrow(/ZS1: not implemented/);
  });

  it("window-controller：空态方法空形状，变更动作 throw", async () => {
    await expect(windowControllerServiceStub.listTaskList({} as never)).resolves.toEqual({
      items: [],
      total: 0,
      hasMore: false,
    });
    const ack = await windowControllerServiceStub.subscribeControllerV4({} as never);
    expect(ack.ack.mode).toBe("snapshot");
    expect(ack.ack.logEpoch).toBe("zs1-stub");
    await expect(
      windowControllerServiceStub.mutateTask({} as never),
    ).rejects.toThrow(/ZS1: not implemented/);
  });

  it("project/task-groups：空态读空形状", async () => {
    await expect(projectServiceStub.readTree()).resolves.toEqual({ projects: [], tasks: [] });
    await expect(projectServiceStub.readProjects()).resolves.toEqual([]);
    await expect(taskGroupServiceStub.read()).resolves.toEqual({
      groups: [],
      members: [],
      order: [],
    });
  });

  it("broadcast：send no-op、tryClaim true、claim 动作 throw、onMessage 永不触发", async () => {
    await expect(broadcastServiceStub.send({ channel: "x", payload: null })).resolves.toBeUndefined();
    await expect(broadcastServiceStub.tryClaim("k")).resolves.toBe(true);
    await expect(broadcastServiceStub.acquireClaim("k")).rejects.toThrow();
    const disposable = broadcastServiceStub.onMessage(() => {
      throw new Error("ZS1 stub event must never fire");
    });
    expect(typeof disposable.dispose).toBe("function");
    disposable.dispose();
  });
});

describe("Root 挂载 9 服务空态形状（V3 关键判据）", () => {
  it("setting.get → 空态 AppSettings + providerFamilyDomain（登录门判据要求非空）；update throw（不假成功）", async () => {
    const settings = await settingServiceStub.get();
    expect(settings.recentProjects).toEqual([]);
    expect(typeof settings.locale).toBe("string");
    expect(settings.providerFamilyDomain).toBeTruthy();
    await expect(settingServiceStub.update({} as never)).rejects.toThrow(/ZS1: not implemented/);
  });

  it("credential.load → null（未登录）", async () => {
    await expect(credentialServiceStub.load("oauth:zai")).resolves.toBeNull();
  });

  it("provider-settings.getView/refresh → 空 view", async () => {
    const empty = {
      revision: 0,
      providerTemplates: [],
      providerOrder: [],
      providers: [],
    };
    await expect(providerSettingsServiceStub.getView()).resolves.toEqual(empty);
    await expect(providerSettingsServiceStub.refresh("test")).resolves.toEqual(empty);
  });

  it("model-selection.getView → 无 provider（UI 落 WelcomeScreen）", async () => {
    await expect(modelSelectionServiceStub.getView()).resolves.toEqual({
      revision: 0,
      providers: [],
    });
  });

  it("事件全部为永不触发的 Event（onDidChangeSession/onDidChange/onMessage）", () => {
    const disposable1 = oauthServiceStub.onDidChangeSession(() => {
      throw new Error("never");
    });
    const disposable2 = providerSettingsServiceStub.onDidChange(() => {
      throw new Error("never");
    });
    const disposable3 = modelSelectionServiceStub.onDidChange(() => {
      throw new Error("never");
    });
    for (const d of [disposable1, disposable2, disposable3]) {
      expect(typeof d.dispose).toBe("function");
      d.dispose();
    }
  });
});

describe("与 @zcode/rpc ProxyChannel 的兼容性（服务端暴露路径集成测）", () => {
  it("fromService(stub)：call 走方法、listen 走事件、动态事件返回 Event", async () => {
    const { services } = createHarness2Services();
    const channel = ProxyChannel.fromService(services.getOptional(ISettingService)!);
    const settings = (await channel.call("host", "get", [])) as { recentProjects: string[] };
    expect(settings.recentProjects).toEqual([]);
    await expect(channel.call("host", "update", [{}])).rejects.toThrow(/ZS1: not implemented/);

    const oauthChannel = ProxyChannel.fromService(services.getOptional(IOAuthService)!);
    const sessionEvent = oauthChannel.listen("host", "onDidChangeSession");
    expect(typeof sessionEvent).toBe("function");
    const d = sessionEvent(() => {
      throw new Error("never");
    });
    d.dispose();

    // onDynamic* 动态事件：listen 调用工厂返回 Event.None
    const agentChannel = ProxyChannel.fromService(services.getOptional(IZCodeAgentService)!);
    const dynamicEvent = agentChannel.listen("host", "onDynamicSessionEvent", "ws-1");
    expect(typeof dynamicEvent).toBe("function");
  });

  it("Event.None 语义与 @zcode/rpc 基准一致", () => {
    const d = Event.None(() => {
      throw new Error("never");
    });
    expect(d).toBeDefined();
    d.dispose();
  });

  it("B 类默认方法经 ProxyChannel call 也 throw（ISystemService 抽查）", async () => {
    const { services } = createHarness2Services();
    const channel = ProxyChannel.fromService(services.getOptional(ISystemService)!);
    await expect(channel.call("host", "getDeviceInfo", [])).rejects.toThrow(/ZS1: not implemented/);
  });

  it("A 类默认读路径经 ProxyChannel call 返回 null（ICredentialService.save throw / load null）", async () => {
    const { services } = createHarness2Services();
    const channel = ProxyChannel.fromService(services.getOptional(ICredentialService)!);
    await expect(channel.call("host", "load", ["k"])).resolves.toBeNull();
    await expect(channel.call("host", "save", ["k", "v"])).rejects.toThrow(/ZS1: not implemented/);
  });
});
