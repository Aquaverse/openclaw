import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { ChannelCapability } from "../../lib/channels/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { editChannelField } from "./channel-config-draft.ts";
import { resolveChannelLabel } from "./view.tsx";
import type { ChannelsProps } from "./view.types.ts";

export async function disconnectChannel(params: {
  channelId: string;
  props: ChannelsProps;
  channels: Pick<
    ChannelCapability,
    "discardConfigEdits" | "editConfig" | "logoutWhatsApp" | "restoreConfigField"
  >;
  runtimeConfig: Parameters<typeof editChannelField>[1];
  save: (channelId: string) => Promise<boolean>;
  onSaved: () => void;
}) {
  const channel = resolveChannelLabel(params.props, params.channelId);
  const disconnectLabel =
    params.props.connectionActionCopy?.disconnect.replace(/…$/u, "") ?? t("common.remove");
  const confirmed = await showConfirmDialog({
    title: `${disconnectLabel} ${channel}?`,
    message: `${t("common.remove")} ${channel}`,
    confirmLabel: disconnectLabel,
    cancelLabel: t("common.cancel"),
  });
  if (!confirmed) {
    return;
  }
  if (params.channelId === "whatsapp") {
    await params.channels.logoutWhatsApp();
  }
  params.channels.discardConfigEdits(params.channelId);
  editChannelField(params.channels, params.runtimeConfig, params.channelId, {
    path: ["channels", params.channelId],
    value: undefined,
  });
  if (await params.save(params.channelId)) {
    params.onSaved();
  }
}

export function createChannelDisconnect(params: {
  getProps: () => ChannelsProps;
  channels: Pick<
    ChannelCapability,
    "discardConfigEdits" | "editConfig" | "logoutWhatsApp" | "restoreConfigField"
  >;
  getRuntimeConfig: () => Parameters<typeof editChannelField>[1];
  save: (channelId: string) => Promise<boolean>;
  onSaved: () => void;
  present: (pending: Promise<void>) => void;
}) {
  return (channelId: string) =>
    params.present(
      disconnectChannel({
        channelId,
        props: params.getProps(),
        channels: params.channels,
        runtimeConfig: params.getRuntimeConfig(),
        save: params.save,
        onSaved: params.onSaved,
      }),
    );
}
