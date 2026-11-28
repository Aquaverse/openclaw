import { beforeEach, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { editChannelField } from "./channel-config-draft.ts";
import { disconnectChannel } from "./channel-disconnect.ts";
import { createChannelsViewProps } from "./view.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("./channel-config-draft.ts", () => ({ editChannelField: vi.fn() }));

beforeEach(() => {
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  vi.mocked(editChannelField).mockReset();
});

it("logs WhatsApp out before clearing its saved configuration", async () => {
  const order: string[] = [];
  const channels = {
    discardConfigEdits: vi.fn(() => order.push("discard-edits")),
    editConfig: vi.fn(),
    logoutWhatsApp: vi.fn(async () => {
      order.push("logout");
    }),
    restoreConfigField: vi.fn(),
  };
  const save = vi.fn(async () => {
    order.push("save");
    return true;
  });
  const onSaved = vi.fn(() => order.push("saved"));
  vi.mocked(editChannelField).mockImplementation(() => order.push("clear-config"));

  await disconnectChannel({
    channelId: "whatsapp",
    props: createChannelsViewProps(null, null, {
      connectionActionCopy: { disconnect: "Disconnect…" },
    }),
    channels,
    runtimeConfig: createInitialConfigState(),
    save,
    onSaved,
  });

  expect(showConfirmDialog).toHaveBeenCalledOnce();
  expect(order).toEqual(["logout", "discard-edits", "clear-config", "save", "saved"]);
});

it("keeps credentials when disconnect confirmation is cancelled", async () => {
  vi.mocked(showConfirmDialog).mockResolvedValue(false);
  const channels = {
    discardConfigEdits: vi.fn(),
    editConfig: vi.fn(),
    logoutWhatsApp: vi.fn(async () => undefined),
    restoreConfigField: vi.fn(),
  };
  const save = vi.fn(async () => true);

  await disconnectChannel({
    channelId: "slack",
    props: createChannelsViewProps(null, null),
    channels,
    runtimeConfig: createInitialConfigState(),
    save,
    onSaved: vi.fn(),
  });

  expect(channels.discardConfigEdits).not.toHaveBeenCalled();
  expect(editChannelField).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
