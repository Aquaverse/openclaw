// Content-type sniffing and the first-pass sensitivity rule (Vault design 8.2). Both are deliberately small and
// conservative: the declared media type is never trusted, and the name rule can only RAISE sensitivity.
import type { VaultSensitivity } from "../store/vault-types.js";

const startsWith = (head: Uint8Array, bytes: number[], at = 0): boolean =>
  head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte);

const ascii = (head: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...head.subarray(from, Math.min(to, head.length)));

const EXTENSION_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Is the head valid UTF-8 text (no NUL, no control bytes other than whitespace)? A cut multi-byte tail is tolerated. */
function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) {
    return true;
  }
  for (const byte of head) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12)) {
      return false;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      head.subarray(0, Math.max(0, head.length - 3)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Media type from the first bytes. The file name is consulted only to tell apart containers that share a magic number
 * (docx / xlsx / pptx are zip files) and to label plain text; it never overrides what the bytes say.
 */
export function sniffVaultMime(head: Uint8Array, name: string): string {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") {
    return "image/gif";
  }
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii(head, 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const byName = EXTENSION_TYPES[extensionOf(name)];
    return byName?.startsWith("application/vnd.openxmlformats") ? byName : "application/zip";
  }
  if (looksLikeText(head)) {
    const byName = EXTENSION_TYPES[extensionOf(name)];
    if (
      byName &&
      (byName.startsWith("text/") || byName === "application/json" || byName === "application/xml")
    ) {
      return byName;
    }
    return "text/plain";
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------- sensitivity (rule only raises)

const SENSITIVE_NAME_WORDS = [
  "passport",
  "driver license",
  "driver's license",
  "driving licence",
  "id card",
  "identity card",
  "national id",
  "social security",
  "ssn",
  "bank statement",
  "credit card",
  "debit card",
  "bank card",
  "medical record",
  "health record",
  "prescription",
  "tax return",
  "护照",
  "身份证",
  "驾驶证",
  "银行卡",
  "信用卡",
  "病历",
  "体检报告",
  "社保",
  "户口",
];

/** The first-pass rule: a sensitive-looking name raises the level to `sensitive` (by `rule`); anything else stays normal. */
export function classifyVaultName(displayName: string): VaultSensitivity {
  const lowered = displayName
    .normalize("NFC")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ");
  return SENSITIVE_NAME_WORDS.some((word) => lowered.includes(word)) ? "sensitive" : "normal";
}
