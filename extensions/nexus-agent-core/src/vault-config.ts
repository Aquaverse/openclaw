// The vault's configuration, resolved from the plugin config (Vault design 5.4). It lives beside the plugin entry rather
// than inside it: the entry is already over the line cap, and this block is a self-contained translation of user settings
// into the service's own shape, with every default written down in one place.
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  VAULT_DEFAULT_MAX_FILE_BYTES,
  VAULT_DEFAULT_OWNER_QUOTA_BYTES,
  VAULT_DEFAULT_RESERVATION_TTL_MS,
  VAULT_DEFAULT_TRASH_RETENTION_MS,
} from "./store/vault-types.js";
import type { TaskModuleConfig } from "./task-module.js";
import { VAULT_EXTRACT_DEFAULTS } from "./vault/vault-extract.js";
import { defaultForbiddenLocations } from "./vault/vault-import.js";
import type { VaultConfig } from "./vault/vault-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 * 1024 * 1024;

const expandHome = (entry: string, home: string): string =>
  entry === "~" ? home : entry.startsWith("~/") ? path.join(home, entry.slice(2)) : entry;

/** Everything the vault service reads from the plugin config, with the design defaults (Vault design 5.4). */
export function resolveVaultConfig(config: TaskModuleConfig, stateDir: string): VaultConfig {
  const home = os.homedir();
  const maxFileBytes = config.vaultMaxFileBytes ?? VAULT_DEFAULT_MAX_FILE_BYTES;
  const roots = (
    config.vaultImportRoots ?? [path.join(home, "Downloads"), path.join(home, "Documents")]
  ).map((entry) => path.resolve(expandHome(entry, home)));
  return {
    limits: {
      maxFileBytes,
      ownerQuotaBytes: config.vaultOwnerQuotaBytes ?? VAULT_DEFAULT_OWNER_QUOTA_BYTES,
    },
    // Nothing is discarded from the inbox on a timer: a file the user has not sorted yet is still their file. Setting
    // `vaultInboxRetentionDays` brings the timer back for anyone who wants it.
    inboxRetentionMs:
      config.vaultInboxRetentionDays !== undefined && config.vaultInboxRetentionDays > 0
        ? config.vaultInboxRetentionDays * DAY_MS
        : null,
    trashRetentionMs:
      config.vaultTrashRetentionDays !== undefined
        ? config.vaultTrashRetentionDays * DAY_MS
        : VAULT_DEFAULT_TRASH_RETENTION_MS,
    reservationTtlMs: VAULT_DEFAULT_RESERVATION_TTL_MS,
    minFreeBytes: config.vaultMinFreeBytes ?? GB,
    reservationRetentionMs: (config.vaultReservationRetentionDays ?? 7) * DAY_MS,
    tombstoneRetentionMs: (config.vaultTombstoneRetentionDays ?? 7) * DAY_MS,
    receiptHashRetentionMs: (config.vaultPurgeReceiptHashRetentionDays ?? 90) * DAY_MS,
    reclaimGraceMs: 60_000,
    extract: {
      ...VAULT_EXTRACT_DEFAULTS,
      enabled: config.vaultExtractEnabled !== false,
      maxBytes: config.vaultExtractMaxBytes ?? VAULT_EXTRACT_DEFAULTS.maxBytes,
      maxChars: config.vaultExtractMaxChars ?? VAULT_EXTRACT_DEFAULTS.maxChars,
    },
    // The state directory and credential / system folders are never importable, even from inside a configured root.
    import: {
      roots,
      forbidden: [stateDir, ...defaultForbiddenLocations(home)],
      maxBytes: maxFileBytes,
    },
    // Chat attachments are staged by the host under <state>/media; that directory is the only place this intake reads from.
    chatMediaRoot: config.vaultChatMediaRoot ?? path.join(resolveStateDir(), "media"),
  };
}
