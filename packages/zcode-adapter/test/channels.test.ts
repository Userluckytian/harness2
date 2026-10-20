// 频道注册枚举单测：57 频道全覆盖（V3 前半）
import { describe, expect, it } from "vitest";
import { ServiceChannels } from "@zcode/shared";
import {
  IFileService,
  IOAuthService,
  ISettingService,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import {
  assertRegistryMatchesServiceChannels,
  CHANNEL_REGISTRY,
  createHarness2Services,
} from "../src/index.js";

describe("channel registry", () => {
  it("注册表与 @zcode/shared ServiceChannels 全集对账（56 + gen-ui = 57，无缺无多）", () => {
    const { missing, unknown } = assertRegistryMatchesServiceChannels();
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
    expect(CHANNEL_REGISTRY).toHaveLength(57);
    expect(Object.keys(ServiceChannels)).toHaveLength(56);
  });

  it("分类只含 A/B/C 且逐频道有备注", () => {
    for (const entry of CHANNEL_REGISTRY) {
      expect(["A", "B", "C"]).toContain(entry.classification);
      expect(entry.note.length).toBeGreaterThan(0);
      expect(entry.channel.length).toBeGreaterThan(0);
    }
  });

  it("createHarness2Services 注册全部 57 个频道（descriptor 可取回桩实例）", () => {
    const { services, registeredChannels } = createHarness2Services();
    expect(registeredChannels).toHaveLength(57);
    expect(new Set(registeredChannels).size).toBe(57);
    // 抽查：必填服务（setting/oauth/file/zcode-agent）均可取回
    expect(services.getOptional(ISettingService)).toBeDefined();
    expect(services.getOptional(IOAuthService)).toBeDefined();
    expect(services.getOptional(IFileService)).toBeDefined();
    expect(services.getOptional(IZCodeAgentService)).toBeDefined();
    // ServiceCollection 原生类型（真实 @zcode/services 实例，非仿制）
    expect(services).toBeInstanceOf(ServiceCollection);
  });

  it("每次调用返回全新 ServiceCollection（幂等装配；显式桩为共享单例——无状态设计）", () => {
    const a = createHarness2Services();
    const b = createHarness2Services();
    expect(a.services).not.toBe(b.services);
    expect(a.registeredChannels).not.toBe(b.registeredChannels);
    // 显式桩共享同一实例（无状态单例）；默认桩每次现场生成
    expect(a.services.getOptional(ISettingService)).toBe(b.services.getOptional(ISettingService));
  });
});
