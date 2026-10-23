/**
 * Text of a primitive SQLite or JSON value. Anything else (null, undefined, an object, a Uint8Array) gives an empty
 * string instead of "[object Object]" or "null", so a stray non-text value never leaks into an id, key or message.
 */
export function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}
