const configuredProductName = import.meta.env.VITE_OPENCLAW_PRODUCT_NAME?.trim();

export const productDisplayName = configuredProductName || "OpenClaw";
export const isBrandedProduct = productDisplayName !== "OpenClaw";

/** Rebrand user-facing copy without changing protocol, type, or storage names. */
export function brandProductText(value: string): string {
  return isBrandedProduct ? value.replaceAll("OpenClaw", productDisplayName) : value;
}
