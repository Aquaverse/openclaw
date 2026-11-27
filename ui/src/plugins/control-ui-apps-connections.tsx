import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import "../components/modal-dialog.tsx";
import { ChannelIcon } from "../components/solid/channel-icon.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { SettingsPage, SettingsPageHeader } from "../components/solid/settings-ui.tsx";
import { GitHubConnections } from "../features/github-connections/github-connections.tsx";
import { channelSnapshotEntryIsActive } from "../lib/channels/index.ts";
import { currentConfigObject } from "../lib/config/config-state-model.ts";
import { formatCompactMs } from "../lib/format.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../lib/reactive/domain-capabilities.ts";
import { createGitHubIdentityView } from "../lib/reactive/domain-github-identity.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { ChannelsPage } from "../pages/channels/channels-page.tsx";
import {
  ChannelConnectionOverlays,
  resolveChannelLabel,
  resolveChannelOrder,
} from "../pages/channels/view.tsx";
import type { ChannelsProps } from "../pages/channels/view.types.ts";
import { configuredEmailAccounts, EmailAccounts } from "../pages/profile/email-accounts.tsx";
import "./control-ui-apps-connections.css";

export type AppsConnectionsCopy = {
  myConnections: string;
  capabilities: string;
  companyCatalog: string;
  mail: string;
  mailDescription: string;
  slack: string;
  slackDescription: string;
  github: string;
  githubDescription: string;
  whatsapp: string;
  whatsappDescription: string;
  telegram: string;
  telegramDescription: string;
  moreChannels: string;
  moreChannelsDescription: string;
  connected: string;
  notConnected: string;
  connect: string;
  add: string;
  manage: string;
  view: string;
  select: string;
  multipleAccounts: string;
  selectChannel: string;
  lastSynced: string;
  providedByAskPepio: string;
  disconnect: string;
  saveToSent: string;
};

export type AppsConnectionsProps = {
  title: string;
  subtitle: string;
  copy: AppsConnectionsCopy;
  presented: boolean;
};

const emptyCopy: AppsConnectionsCopy = {
  myConnections: "",
  capabilities: "",
  companyCatalog: "",
  mail: "",
  mailDescription: "",
  slack: "",
  slackDescription: "",
  github: "",
  githubDescription: "",
  whatsapp: "",
  whatsappDescription: "",
  telegram: "",
  telegramDescription: "",
  moreChannels: "",
  moreChannelsDescription: "",
  connected: "",
  notConnected: "",
  connect: "",
  add: "",
  manage: "",
  view: "",
  select: "",
  multipleAccounts: "",
  selectChannel: "",
  lastSynced: "",
  providedByAskPepio: "",
  disconnect: "",
  saveToSent: "",
};

type ConnectionDialog = "email-add" | "email-manage" | "github" | null;

const FEATURED_CHANNELS = new Set(["slack", "whatsapp", "telegram"]);

function ConnectionRow(props: {
  title: string;
  description?: string;
  icon: JSX.Element;
  status: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div class="apps-connections__row">
      <span class="apps-connections__row-icon">{props.icon}</span>
      <span class="apps-connections__row-copy">
        <span class="apps-connections__row-title">{props.title}</span>
        <Show when={props.description} keyed>
          {(description) => <span class="apps-connections__row-description">{description}</span>}
        </Show>
      </span>
      <span class="apps-connections__row-control">
        <span class="apps-connections__row-status">{props.status}</span>
        <button type="button" class="btn btn--sm" onClick={() => props.onAction()}>
          {props.action}
        </button>
      </span>
    </div>
  );
}

function ConnectedCard(props: {
  title: string;
  description?: string;
  icon: JSX.Element;
  status: string;
  meta: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <article class="apps-connections__card">
      <div class="apps-connections__card-heading">
        <span class="apps-connections__row-icon">{props.icon}</span>
        <span class="apps-connections__row-copy">
          <span class="apps-connections__row-title">{props.title}</span>
          <Show when={props.description} keyed>
            {(description) => <span class="apps-connections__row-description">{description}</span>}
          </Show>
        </span>
        <span class="apps-connections__card-status">{props.status}</span>
      </div>
      <p class="apps-connections__card-meta">{props.meta}</p>
      <button type="button" class="apps-connections__card-action" onClick={() => props.onAction()}>
        {props.action}
      </button>
    </article>
  );
}

function syncPersonalGitHub(
  identity: ReturnType<typeof createGitHubIdentityView>,
  snapshot: ApplicationGatewaySnapshot,
  clientRevision: number,
) {
  const connected = snapshot.phase === "connected";
  const profileId = connected ? (snapshot.selfUser?.id ?? null) : null;
  const canRead =
    connected &&
    Boolean(snapshot.hello?.auth) &&
    hasOperatorReadAccess(snapshot.hello?.auth ?? null);
  identity.sync({
    client: snapshot.client,
    connected,
    permissionsReady: connected && Boolean(snapshot.hello),
    target: profileId ? { kind: "personal", profileId } : null,
    statusReadable: canRead,
    configurable: false,
    authorizable: canRead,
    clientRevision,
  });
  identity.ensureVerified();
}

function AppsConnectionsSurface(props: AppsConnectionsProps & { channels: ChannelsProps }) {
  const context = useApplication();
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const github = createGitHubIdentityView();
  const [dialog, setDialog] = createSignal<ConnectionDialog>(null);
  const [showChannelPicker, setShowChannelPicker] = createSignal(false);
  let githubClientRevision = 0;
  let githubSnapshot: ApplicationGatewaySnapshot | null = null;

  onSettled(() => {
    const apply = (snapshot: ApplicationGatewaySnapshot) => {
      if (
        !githubSnapshot ||
        githubSnapshot.client !== snapshot.client ||
        githubSnapshot.phase !== snapshot.phase ||
        githubSnapshot.selfUser?.id !== snapshot.selfUser?.id ||
        githubSnapshot.hello !== snapshot.hello
      ) {
        githubClientRevision += 1;
      }
      githubSnapshot = snapshot;
      syncPersonalGitHub(github, snapshot, githubClientRevision);
    };
    const stop = context.gateway.subscribe(apply);
    apply(context.gateway.snapshot);
    void context.runtimeConfig.ensureLoaded();
    return stop;
  });

  const config = () => currentConfigObject(runtimeConfig.read().state);
  const emailAccounts = createMemo(() => Object.entries(configuredEmailAccounts(config())));
  const channelSnapshot = () => props.channels.channels.channelsSnapshot;
  const channelOrder = createMemo(() => resolveChannelOrder(channelSnapshot()));
  const connectedChannels = createMemo(() =>
    channelOrder().filter((channel) => channelSnapshotEntryIsActive(channelSnapshot(), channel)),
  );
  const githubConnected = () => github.read().personal?.state === "connected";
  const githubLogin = () => github.read().personal?.account?.login;
  const connectedCount = () =>
    emailAccounts().length + connectedChannels().length + (githubConnected() ? 1 : 0);
  const connectionMeta = () =>
    `${props.copy.lastSynced} ${formatCompactMs(channelSnapshot()?.ts)} · ${props.copy.providedByAskPepio}`;
  const availableOtherChannels = createMemo(() =>
    channelOrder().filter(
      (channel) =>
        !FEATURED_CHANNELS.has(channel) &&
        !channelSnapshotEntryIsActive(channelSnapshot(), channel),
    ),
  );
  const channelIcon = (channel: string) => (
    <ChannelIcon
      channelId={channel}
      label={resolveChannelLabel(props.channels, channel)}
      variant="tile"
      pluginIconUrl={props.channels.presentation.pluginIconUrls[channel]}
    />
  );
  const openChannel = (channel: string) => props.channels.onStartSetup(channel);

  return (
    <div hidden={!props.presented}>
      <SettingsPage wide>
        <div class="apps-connections">
          <SettingsPageHeader title={props.title} subtitle={props.subtitle} stacked />

          <section class="apps-connections__section" aria-labelledby="apps-connections-mine">
            <div class="apps-connections__section-heading">
              <h2 id="apps-connections-mine">{props.copy.myConnections}</h2>
              <span class="apps-connections__count" aria-label={String(connectedCount())}>
                {connectedCount()}
              </span>
            </div>
            <Show when={connectedCount() > 0}>
              <div class="apps-connections__cards">
                <For each={emailAccounts()} keyed={(account) => account[0]}>
                  {(entry) => {
                    const account = createMemo(() => asOptionalRecord(entry()[1]));
                    const title = createMemo(() => {
                      const email = account()?.email;
                      return typeof email === "string" ? email : entry()[0];
                    });
                    const description = createMemo(() => {
                      const host = account()?.host;
                      return typeof host === "string" ? host : undefined;
                    });
                    return (
                      <ConnectedCard
                        title={title()}
                        description={description()}
                        icon={<Icon name="mail" />}
                        status={props.copy.connected}
                        meta={connectionMeta()}
                        action={props.copy.disconnect}
                        onAction={() => setDialog("email-manage")}
                      />
                    );
                  }}
                </For>
                <Show when={githubConnected()}>
                  <ConnectedCard
                    title={props.copy.github}
                    description={githubLogin() ? `@${githubLogin()}` : undefined}
                    icon={<Icon name="github" />}
                    status={props.copy.connected}
                    meta={connectionMeta()}
                    action={props.copy.disconnect}
                    onAction={() => setDialog("github")}
                  />
                </Show>
                <For each={connectedChannels()}>
                  {(channel) => (
                    <ConnectedCard
                      title={resolveChannelLabel(props.channels, channel)}
                      icon={channelIcon(channel)}
                      status={props.copy.connected}
                      meta={connectionMeta()}
                      action={props.copy.disconnect}
                      onAction={() => props.channels.onShowDetail(channel)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section
            class="apps-connections__section"
            aria-labelledby="apps-connections-capabilities"
          >
            <div class="apps-connections__section-heading">
              <h2 id="apps-connections-capabilities">{props.copy.capabilities}</h2>
              <span class="apps-connections__catalog-badge">{props.copy.companyCatalog}</span>
            </div>
            <div class="apps-connections__list">
              <ConnectionRow
                title={props.copy.mail}
                description={props.copy.mailDescription}
                icon={<Icon name="mail" />}
                status={props.copy.multipleAccounts}
                action={props.copy.add}
                onAction={() => setDialog("email-add")}
              />
              <Show when={!channelSnapshotEntryIsActive(channelSnapshot(), "slack")}>
                <ConnectionRow
                  title={props.copy.slack}
                  description={props.copy.slackDescription}
                  icon={channelIcon("slack")}
                  status={props.copy.notConnected}
                  action={props.copy.connect}
                  onAction={() => openChannel("slack")}
                />
              </Show>
              <Show when={!githubConnected()}>
                <ConnectionRow
                  title={props.copy.github}
                  description={props.copy.githubDescription}
                  icon={<Icon name="github" />}
                  status={props.copy.notConnected}
                  action={props.copy.connect}
                  onAction={() => setDialog("github")}
                />
              </Show>
              <Show when={!channelSnapshotEntryIsActive(channelSnapshot(), "whatsapp")}>
                <ConnectionRow
                  title={props.copy.whatsapp}
                  description={props.copy.whatsappDescription}
                  icon={channelIcon("whatsapp")}
                  status={props.copy.notConnected}
                  action={props.copy.connect}
                  onAction={() => openChannel("whatsapp")}
                />
              </Show>
              <Show when={!channelSnapshotEntryIsActive(channelSnapshot(), "telegram")}>
                <ConnectionRow
                  title={props.copy.telegram}
                  description={props.copy.telegramDescription}
                  icon={channelIcon("telegram")}
                  status={props.copy.notConnected}
                  action={props.copy.connect}
                  onAction={() => openChannel("telegram")}
                />
              </Show>
              <Show when={availableOtherChannels().length > 0}>
                <ConnectionRow
                  title={props.copy.moreChannels}
                  description={props.copy.moreChannelsDescription}
                  icon={<Icon name="plus" />}
                  status={props.copy.notConnected}
                  action={props.copy.select}
                  onAction={() => setShowChannelPicker((visible) => !visible)}
                />
              </Show>
            </div>
          </section>

          <Show when={showChannelPicker() && availableOtherChannels().length > 0}>
            <section class="apps-connections__section" aria-labelledby="apps-channel-picker">
              <div class="apps-connections__section-heading">
                <h2 id="apps-channel-picker">{props.copy.selectChannel}</h2>
              </div>
              <div class="apps-connections__list">
                <For each={availableOtherChannels()}>
                  {(channel) => (
                    <ConnectionRow
                      title={resolveChannelLabel(props.channels, channel)}
                      icon={channelIcon(channel)}
                      status={props.copy.notConnected}
                      action={props.copy.connect}
                      onAction={() => openChannel(channel)}
                    />
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </SettingsPage>

      <Show when={dialog()} keyed>
        {(currentDialog) => (
          <openclaw-modal-dialog
            label={currentDialog === "github" ? props.copy.github : props.copy.mail}
            style={{ "--openclaw-modal-width": "640px" }}
            onModal-cancel={() => setDialog(null)}
          >
            <div class="oc-dialog apps-connections__dialog">
              <div class="oc-dialog__header">
                <h2 class="oc-dialog__title">
                  {currentDialog === "github" ? props.copy.github : props.copy.mail}
                </h2>
                <button
                  type="button"
                  class="btn btn--sm oc-dialog__close"
                  aria-label="Close"
                  onClick={() => setDialog(null)}
                >
                  <Icon name="x" />
                </button>
              </div>
              <div class="oc-dialog__body apps-connections__dialog-body">
                {currentDialog === "github" ? (
                  <GitHubConnections personalOnly />
                ) : (
                  <EmailAccounts
                    initialAction={currentDialog === "email-add" ? "add" : undefined}
                    saveSentCopyLabel={props.copy.saveToSent}
                  />
                )}
              </div>
            </div>
          </openclaw-modal-dialog>
        )}
      </Show>

      <ChannelConnectionOverlays {...props.channels} />
    </div>
  );
}

function AppsConnectionsContent(props: AppsConnectionsProps) {
  return (
    <ChannelsPage
      render={(channels) => <AppsConnectionsSurface {...props} channels={channels} />}
    />
  );
}

export const AppsConnections = defineSolidBridge<AppsConnectionsProps>(
  "openclaw-plugin-apps-connections",
  AppsConnectionsContent,
  {
    properties: {
      title: { default: "", attribute: false },
      subtitle: { default: "", attribute: false },
      copy: { default: emptyCopy, attribute: false },
      presented: { default: true, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-apps-connections": SolidBridgeElement<AppsConnectionsProps>;
  }
}
