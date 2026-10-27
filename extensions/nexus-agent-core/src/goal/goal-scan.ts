// Sensitive-value scan for goal text (Goals design 8.3): ID, card and account numbers must not be saved in a goal. The scan
// looks at SHAPE and checksum only, so an amount ("1,000,000"), a date or a phone-sized number does not trip it. It answers
// which kind it saw, never the matched text, so the answer is safe to show to the model and to log.
export type SensitiveValueKind = "card_number" | "national_id" | "ssn" | "iban";

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** PRC resident ID: 17 digits plus a check character (ISO 7064 mod 11-2). */
function chinaIdValid(id: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (id.charCodeAt(i) - 48) * (weights[i] as number);
  }
  return checks[sum % 11] === id[17]?.toUpperCase();
}

function ibanValid(raw: string): boolean {
  const iban = raw.toUpperCase();
  if (iban.length < 15 || iban.length > 34) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/** The first sensitive value found in `text`, or undefined. */
export function scanSensitiveValue(text: string): SensitiveValueKind | undefined {
  const flat = text.normalize("NFKC");
  for (const match of flat.matchAll(/(?<![\d-])(\d{17}[\dXx])(?![\d])/gu)) {
    if (chinaIdValid(match[1] as string)) {
      return "national_id";
    }
  }
  if (/(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/u.test(flat)) {
    return "ssn";
  }
  for (const match of flat.matchAll(
    /(?<![A-Za-z0-9])([A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,4})?)(?![A-Za-z0-9])/gu,
  )) {
    if (ibanValid((match[1] as string).replace(/ /gu, ""))) {
      return "iban";
    }
  }
  // Card numbers: 13-19 digits, optionally grouped by single spaces or hyphens, that pass the Luhn check.
  for (const match of flat.matchAll(/(?<![\d])(\d(?:[ -]?\d){12,18})(?![\d])/gu)) {
    const digits = (match[1] as string).replace(/[ -]/gu, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return "card_number";
    }
  }
  return undefined;
}
