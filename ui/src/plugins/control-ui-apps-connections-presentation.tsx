import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

export function ConnectionRow(props: {
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

export function ConnectedCard(props: {
  title: string;
  description?: string;
  icon: JSX.Element;
  status: string;
  meta: string;
  disconnectAction: string;
  manageAction: string;
  disconnectDisabled?: boolean;
  onDisconnect: () => void;
  onManage: () => void;
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
      <div class="apps-connections__card-actions">
        <button
          type="button"
          class="apps-connections__card-action apps-connections__card-action--danger"
          disabled={props.disconnectDisabled}
          onClick={() => props.onDisconnect()}
        >
          {props.disconnectAction}
        </button>
        <button
          type="button"
          class="apps-connections__card-action"
          onClick={() => props.onManage()}
        >
          {props.manageAction}
        </button>
      </div>
    </article>
  );
}
