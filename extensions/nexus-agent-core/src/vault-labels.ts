// The words a vault file's enums are shown with (collection, state, source). Every surface that prints one of them — the
// Library list and detail pane, the file dialog of an older console page — reads these maps, so an enum never reaches the
// screen as an English identifier inside a Chinese UI. The message keys live in i18n.ts.
import { tr, type Lang, type MsgKey } from "./i18n.js";
import type { VaultFileRecord } from "./store/vault-types.js";

export const VAULT_COLLECTION_LABEL = {
  inbox: "files.coll.inbox",
  vault: "files.coll.vault",
  deliverable: "files.coll.deliverable",
} as const satisfies Record<VaultFileRecord["collection"], MsgKey>;

export const VAULT_STATE_LABEL = {
  active: "files.st.active",
  trashed: "files.st.trashed",
  purging: "files.st.purging",
  damaged: "files.st.damaged",
} as const satisfies Record<VaultFileRecord["state"], MsgKey>;

/** Where a file came from. `chat` is a file arriving with a conversation; `sourceRef` says which one. */
export const VAULT_SOURCE_LABEL = {
  upload: "files.src.upload",
  local_import: "files.src.local_import",
  chat: "files.src.chat",
  email: "files.src.email",
  mobile: "files.src.mobile",
  task_output: "files.src.task_output",
} as const satisfies Record<VaultFileRecord["source"], MsgKey>;

/** "文档库 · 本机上传" / "Library · From a chat": the line the console shows under 来源. */
export const vaultOriginLabel = (
  lang: Lang,
  file: Pick<VaultFileRecord, "collection" | "source">,
): string =>
  `${tr(lang, VAULT_COLLECTION_LABEL[file.collection])} · ${tr(lang, VAULT_SOURCE_LABEL[file.source])}`;
