/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChannelsPageContent } from "./channels-page-content.tsx";
import type { ChannelsProps } from "./view.types.ts";

it("keeps a custom channel surface mounted while channel snapshots refresh", async () => {
  const [channels, setChannels] = createSignal({} as ChannelsProps);
  const render = vi.fn(() => <div data-testid="custom-channels" />);
  const view = mountSolid(() => <ChannelsPageContent channels={channels()} render={render} />);

  expect(render).toHaveBeenCalledOnce();
  const surface = view.container.querySelector('[data-testid="custom-channels"]');

  setChannels({} as ChannelsProps);
  await waitForSolid(() => expect(render).toHaveBeenCalledOnce());

  expect(view.container.querySelector('[data-testid="custom-channels"]')).toBe(surface);
});
