// Who answers for a Commitment, as the words say it (object-model design 6.8, R-10 / V17). A Commitment has ONE responsible person.
// "小王和小李一起做报价" names two people in one breath: the system never turns that into one person, and never into two copies of the
// same obligation. It keeps the typed words, marks the Commitment as waiting for the user's choice ("joint"), and the user picks one
// of the two legal forms (one Commitment each, or one responsible person plus helpers). "Any one of them is enough" has no legal
// form in this batch: it is refused with a sentence, never quietly turned into "both must do it".
// Pure functions, no store. The detection is deliberately narrow: a person whose own name contains "和" ("刘和平") must stay one
// person, so a split needs parts of at least two characters, and the ledger lets any name the user already has win over a split.

export type ResponsibleWording = { kind: "joint"; names: string[] } | { kind: "either" };

/** What is stored in `commitments.ambiguity_json` while the user has not chosen. */
export type JointAmbiguity = { kind: "joint"; names: string[] };

export const MAX_JOINT_NAMES = 10;

/** The sentence design 6.8 prescribes when the user asked for "any one of them is enough". */
export const EITHER_RESPONSIBLE_MESSAGE =
  "请指定一位负责人，其他人可协助，或明确各自需要交付的部分。（“任一人完成即可”暂不支持，不会改成两个人都必须完成。）";

const EITHER =
  /任一|任意一|任何一|其中一|谁都行|谁都可以|谁先.{0,4}(完成|做完|做好|交)|\beither\b|\bany ?one of\b|\bone of (them|the two|you)\b|\bwhoever\b/i;
const GROUP_ONLY =
  /^(他们|她们|我们|你们|他俩|她俩|咱们|两人|两个人|二人|俩人|双方|大家)(俩|两个|两位|一起|共同)?$/;
const TRAILING_MARKER = /(一起|共同|一块|一同|两人|俩|都)(来?做|负责|完成|搞定)?$/;
const SEPARATORS = /\s*(?:和|与|跟|及|、|,|，|;|；|\/|&|\+|\band\b)\s*/i;

const squash = (text: string): string => text.normalize("NFKC").replace(/\s+/g, " ").trim();

/** True when the words ask for "any one of them is enough". */
export function asksForEither(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === "string" && EITHER.test(squash(text)));
}

/**
 * Reads the words typed for "who is responsible". `{kind:"joint"}` when they name several people or a group; `null` when they name
 * one. The names come back in the order typed, without the trailing "一起".
 */
export function readResponsibleWording(raw: string | null | undefined): ResponsibleWording | null {
  const text = squash(typeof raw === "string" ? raw : "");
  if (text.length === 0) {
    return null;
  }
  if (EITHER.test(text)) {
    return { kind: "either" };
  }
  if (GROUP_ONLY.test(text)) {
    return { kind: "joint", names: [] };
  }
  const body = text.replace(TRAILING_MARKER, "").trim();
  const parts = body
    .split(SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some((part) => [...part].length < 2)) {
    return null;
  }
  const names: string[] = [];
  for (const part of parts) {
    if (!names.includes(part)) {
      names.push(part);
    }
  }
  return names.length < 2 ? null : { kind: "joint", names: names.slice(0, MAX_JOINT_NAMES) };
}

export function parseAmbiguity(json: unknown): JointAmbiguity | undefined {
  if (typeof json !== "string" || json.length === 0) {
    return undefined;
  }
  try {
    const value = JSON.parse(json) as { kind?: unknown; names?: unknown };
    if (value.kind !== "joint" || !Array.isArray(value.names)) {
      return undefined;
    }
    return {
      kind: "joint",
      names: value.names
        .filter((n): n is string => typeof n === "string")
        .slice(0, MAX_JOINT_NAMES),
    };
  } catch {
    return undefined;
  }
}
