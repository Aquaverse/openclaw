import type { JSX } from "@solidjs/web";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { ChannelsView } from "./view.tsx";
import type { ChannelsProps } from "./view.types.ts";

const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

export type ChannelsPageRender = (props: ChannelsProps) => JSX.Element;

export function ChannelsPageContent(props: {
  channels: ChannelsProps;
  render?: ChannelsPageRender;
}) {
  return (
    <openclaw-channels-page>
      {props.render ? (
        props.render(props.channels)
      ) : (
        <>
          <SettingsPageHeader
            title={t("tabs.channels")}
            subtitle={<LearnMoreLink url={CHANNELS_DOCS_URL} />}
          />
          <SettingsWorkspace>
            <ChannelsView {...props.channels} />
          </SettingsWorkspace>
        </>
      )}
    </openclaw-channels-page>
  );
}
