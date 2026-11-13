// A plugin's cron-backed turn records the inference account of its agent at creation, so the run is not refused as unrecorded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronInferenceBinding } from "../cron/inference-binding.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { clearPluginHostRuntimeState } from "./host-hook-runtime.js";
import { schedulePluginSessionTurn } from "./host-hook-scheduled-turns.js";

const captureMock = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../cron/inference-binding.runtime.js", () => ({
  captureCronInferenceBinding: captureMock.capture,
}));

const BINDING = {
  provider: "openai",
  profileId: "openai:api-key",
} as unknown as CronInferenceBinding;
const CONFIG = {} as OpenClawConfig;
const SESSION_KEY = "agent:main:nexus-check-sc_1-1";

function makeCron() {
  const add = vi.fn(async () => ({ id: "job-1" }));
  const cron = { add, remove: vi.fn(async () => ({ ok: true, removed: true })) };
  return { cron: cron as unknown as CronServiceContract, add };
}

function schedule(cron: CronServiceContract, readConfig?: () => OpenClawConfig | undefined) {
  return schedulePluginSessionTurn({
    pluginId: "workflow-plugin",
    origin: "bundled",
    cron,
    ...(readConfig ? { readConfig } : {}),
    schedule: { sessionKey: SESSION_KEY, message: "check", delayMs: 1_000, deleteAfterRun: true },
  });
}

describe("plugin scheduled turn inference account", () => {
  beforeEach(() => {
    captureMock.capture.mockReset();
  });
  afterEach(() => {
    clearPluginHostRuntimeState();
  });

  it("records the account of the session's agent and passes it to cron.add", async () => {
    captureMock.capture.mockResolvedValue(BINDING);
    const { cron, add } = makeCron();

    await expect(schedule(cron, () => CONFIG)).resolves.toMatchObject({ id: "job-1" });

    expect(captureMock.capture).toHaveBeenCalledTimes(1);
    expect(captureMock.capture.mock.calls[0]?.[0]).toMatchObject({ cfg: CONFIG, agentId: "main" });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[1]).toEqual({ inferenceBinding: BINDING });
  });

  it("adds the job without options when the route needs no recorded account", async () => {
    captureMock.capture.mockResolvedValue(undefined);
    const { cron, add } = makeCron();

    await schedule(cron, () => CONFIG);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]).toHaveLength(1);
  });

  it("keeps scheduling, unbound, when capturing the account fails", async () => {
    captureMock.capture.mockRejectedValue(new Error("no stored account"));
    const { cron, add } = makeCron();

    await expect(schedule(cron, () => CONFIG)).resolves.toMatchObject({ id: "job-1" });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]).toHaveLength(1);
  });

  it("records nothing without a published config", async () => {
    const { cron, add } = makeCron();

    await schedule(cron);

    expect(captureMock.capture).not.toHaveBeenCalled();
    expect(add.mock.calls[0]).toHaveLength(1);
  });

  it("keeps scheduling when the config is not ready to read", async () => {
    const { cron, add } = makeCron();

    await expect(
      schedule(cron, () => {
        throw new Error("Runtime config is not prepared.");
      }),
    ).resolves.toMatchObject({ id: "job-1" });

    expect(captureMock.capture).not.toHaveBeenCalled();
    expect(add.mock.calls[0]).toHaveLength(1);
  });

  it("releases the retained authorization after the job is added", async () => {
    const dispose = vi.fn();
    captureMock.capture.mockImplementation(
      async (params: { retainAuthorization?: (authority: unknown) => void }) => {
        params.retainAuthorization?.({ dispose, assertCurrent: vi.fn() });
        return BINDING;
      },
    );
    const { cron } = makeCron();

    await schedule(cron, () => CONFIG);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses to bind a personal model account", async () => {
    captureMock.capture.mockImplementation(
      async (params: {
        authorizeProfile?: (profileId: string, inherited: boolean) => Promise<unknown>;
      }) => {
        await params.authorizeProfile?.(
          "personal:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
          false,
        );
        return BINDING;
      },
    );
    const { cron, add } = makeCron();

    await schedule(cron, () => CONFIG);

    // The capture threw, so the job is added unbound instead of borrowing a personal account.
    expect(add.mock.calls[0]).toHaveLength(1);
  });
});
