// Stage 2 action catalog (DESIGN section 8.7). Stage 2 only wires a set of FAKE tools, so the catalog is a fixed
// table in code: the model names a tool, the server decides capability, risk tier and what is shown to the human.
// Nothing here is model-controlled except the tool's own parameters, and those are validated and normalized.
import { canonicalJson, sha256Hex } from "../canonical.js";

export type RiskTier = "R1" | "R2" | "R3";

export type ActionFields = {
  /** The model-supplied parameters after normalization: the only thing that is ever executed. */
  params: Record<string, unknown>;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
};

export type ActionSpec = {
  toolName: string;
  capability: string;
  tier: RiskTier;
  reversible: boolean;
  /** One line for the confirmation page and the core approval card. */
  describe: (fields: ActionFields) => string;
  /** Returns normalized fields, or a human-readable reason the parameters are not acceptable. */
  parse: (raw: unknown) => ActionFields | string;
};

const TEXT_MAX = 200;
const BODY_MAX = 2_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && [...trimmed].length <= max ? trimmed : undefined;
}

const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export const FAKE_TOOL_NAMES = ["fake_vendor_message", "fake_booking", "fake_payment"] as const;

export const ACTION_CATALOG: Record<string, ActionSpec> = {
  fake_vendor_message: {
    toolName: "fake_vendor_message",
    capability: "contact_vendor",
    tier: "R1",
    reversible: false,
    parse(raw) {
      if (!isPlainObject(raw)) {
        return "params must be an object: { vendor, message }";
      }
      const vendor = text(raw.vendor, TEXT_MAX);
      const message = text(raw.message, BODY_MAX);
      if (!vendor || !message) {
        return "fake_vendor_message needs vendor (<=200 characters) and message (<=2000 characters)";
      }
      return { params: { vendor, message }, amount: null, currency: null, merchant: vendor };
    },
    describe: (fields) => `向供应商「${String(fields.params.vendor)}」发送消息`,
  },
  fake_booking: {
    toolName: "fake_booking",
    capability: "book",
    tier: "R2",
    reversible: true,
    parse(raw) {
      if (!isPlainObject(raw)) {
        return "params must be an object: { vendor, item, date? }";
      }
      const vendor = text(raw.vendor, TEXT_MAX);
      const item = text(raw.item, TEXT_MAX);
      if (!vendor || !item) {
        return "fake_booking needs vendor and item (each <=200 characters)";
      }
      const params: Record<string, unknown> = { vendor, item };
      if (raw.date !== undefined) {
        const date = text(raw.date, 40);
        if (!date || !ISO_DATE.test(date)) {
          return "date must be an ISO date, e.g. 2026-10-20";
        }
        params.date = date;
      }
      return { params, amount: null, currency: null, merchant: vendor };
    },
    describe: (fields) =>
      `向「${String(fields.params.vendor)}」预订「${String(fields.params.item)}」${
        typeof fields.params.date === "string" ? `（${fields.params.date}）` : ""
      }`,
  },
  fake_payment: {
    toolName: "fake_payment",
    capability: "pay",
    tier: "R3",
    reversible: false,
    parse(raw) {
      if (!isPlainObject(raw)) {
        return "params must be an object: { merchant, amount, currency }";
      }
      const merchant = text(raw.merchant, TEXT_MAX);
      const amount = typeof raw.amount === "number" ? String(raw.amount) : text(raw.amount, 20);
      const currency = text(raw.currency, 3)?.toUpperCase();
      if (!merchant || !amount || !AMOUNT.test(amount) || !currency || !CURRENCY.test(currency)) {
        return 'fake_payment needs merchant, amount (a decimal string such as "128.50") and currency (three letters)';
      }
      return { params: { merchant, amount, currency }, amount, currency, merchant };
    },
    describe: (fields) =>
      `向「${String(fields.merchant)}」付款 ${String(fields.amount)} ${String(fields.currency)}`,
  },
};

export function specFor(toolName: string): ActionSpec | undefined {
  return Object.hasOwn(ACTION_CATALOG, toolName) ? ACTION_CATALOG[toolName] : undefined;
}

export function tierForCapability(capability: string): RiskTier | undefined {
  return Object.values(ACTION_CATALOG).find((spec) => spec.capability === capability)?.tier;
}

/**
 * action_hash binds the tool, the capability, the normalized parameters and an explicit `occurrence`. The schema keeps
 * (task_id, action_hash) unique, so "do the same thing a second time" must be a different occurrence (DESIGN 8.6).
 */
export function actionHashFor(
  toolName: string,
  capability: string,
  paramsCanonical: string,
  occurrence = 1,
): string {
  return sha256Hex(canonicalJson({ toolName, capability, params: paramsCanonical, occurrence }));
}
