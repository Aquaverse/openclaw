// Counterpart layer types (object-model design 7, 9, slice W3a): the person record a caller sees and the inputs that create and
// change it. A Counterpart answers WHO; an endpoint answers through which account; a Commitment answers what they promised.
// Names and addresses are never keys. Contact methods are reference data: storing one authorizes nothing.
import type { CommitmentRecord } from "../commitment/types.js";

export const COUNTERPART_KINDS = ["person", "organization", "team"] as const;
export type CounterpartKind = (typeof COUNTERPART_KINDS)[number];
export const COUNTERPART_RELATIONS = [
  "direct_report",
  "colleague",
  "client",
  "supplier",
  "other",
] as const;
export type CounterpartRelation = (typeof COUNTERPART_RELATIONS)[number];
/** The ways to reach someone that the console can record by hand (the endpoint table allows more; adapters write those). */
export const CONTACT_TYPES = ["email", "phone", "im", "other"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
export type CounterpartActor = "user" | "agent";

export const COUNTERPART_LIMITS = {
  name: 80,
  aliases: 8,
  contacts: 10,
  contactValue: 200,
  contactLabel: 40,
  reason: 500,
  basis: 500,
  scopeLabel: 80,
  ref: 200,
} as const;

export type ContactSpec = { type: ContactType; value: string; label?: string };
export type ContactRecord = {
  id: string;
  type: ContactType | string;
  /** What the person sees as the kind ("微信", "email"). */
  label: string;
  value: string;
  createdAt: number;
};

export type RelationSpec = {
  relation: CounterpartRelation;
  scopeLabel?: string | null;
  basisText?: string;
};

export type CounterpartRecord = {
  ownerId: string;
  id: string;
  kind: CounterpartKind;
  displayName: string;
  /** stated: only said (by the Agent or the user in passing); confirmed: the user made or confirmed the record. */
  confirmation: "stated" | "confirmed" | "proposed";
  origin: "user" | "agent" | "review_batch" | "system";
  lifecycle: "live" | "inactive" | "merged" | "deleted";
  inactiveReason: string | null;
  inactiveAt: number | null;
  /** Set when this record was merged into another one: the record that kept the identity. */
  mergedInto: string | null;
  isSelf: boolean;
  aliases: string[];
  relation: { relation: CounterpartRelation; scopeLabel: string | null } | null;
  contacts: ContactRecord[];
  revision: number;
  createdAt: number;
  updatedAt: number;
};

/** What the list shows per person: the counts that tell the user whom to look at first. */
export type CounterpartSummary = CounterpartRecord & {
  /** Open or waiting Commitments this person is responsible for, each counted once however many Works cite it. */
  unresolved: number;
  overdue: number;
  /** Of the unresolved ones, those whose acceptance is not yet recorded as accepted. */
  needsConfirmation: number;
  earliestDueAt: number | null;
};

export type NameMatch = {
  match: "one" | "many" | "none";
  candidates: Array<{
    id: string;
    displayName: string;
    kind: CounterpartKind;
    confirmation: string;
    relation: CounterpartRelation | null;
  }>;
  /** Looser hints for "none"; never auto-used. */
  similar: Array<{ id: string; displayName: string }>;
};

export type CounterpartImpact = {
  contacts: number;
  openCommitments: number;
  resolvedCommitments: number;
  participantLinks: number;
  works: Array<{ workId: string; title: string }>;
};

/** What merging one person into another reaches (design 7.5). `relations` is set only when the two disagree. */
export type MergeImpact = {
  contacts: number;
  /** Contacts the two already share (same kind and value): they become one. */
  sharedContacts: number;
  aliases: number;
  openCommitments: number;
  resolvedCommitments: number;
  participantLinks: number;
  works: Array<{ workId: string; title: string }>;
  relations: {
    source: CounterpartRecord["relation"];
    target: CounterpartRecord["relation"];
  } | null;
};

/** What splitting one record into two reaches (design 4.3.4, 7.5): what moves to the new person and what stays. */
export type SplitImpact = {
  movedContacts: number;
  keptContacts: number;
  movedAliases: number;
  keptAliases: number;
  /** Open commitments that move start a new responsibility version for the new person (communication and acceptance reset). */
  movedOpenCommitments: number;
  /** Resolved or cancelled commitments that move keep their result: only the person they point at changes. */
  movedResolvedCommitments: number;
  keptOpenCommitments: number;
  keptResolvedCommitments: number;
  /** Participant links are not moved: they stay with the record that was split. */
  participantLinksStaying: number;
  works: Array<{ workId: string; title: string }>;
};

/** What moving one contact method to another person (or to nobody) reaches (design 7.6 b). */
export type ContactMoveImpact = {
  contact: ContactRecord;
  /** The person it moves to; null when it belongs to nobody. */
  to: { id: string; displayName: string } | null;
  /** The new person already holds the same contact: the two become one. */
  duplicate: boolean;
  /** Evidence read through this contact that "from the start" would set aside and judge again. */
  attributions: number;
  /** Commitments those attributions belong to, and how many of them were already verified complete. */
  attributedCommitments: number;
  verifiedCommitments: number;
};

/** What clearing a deleted person reaches (the name stays; the contacts, other names and relations go for good). */
export type PurgeImpact = {
  /** Contact methods (endpoints) that are deleted with the person. */
  contacts: number;
  /** The attachments of contact methods to the person that are deleted (history of earlier attachments included). */
  links: number;
  /** Contact methods that another person also holds: only the attachment of this person goes, the contact stays. */
  sharedContacts: number;
  /** Other names (aliases, names typed in Commitments, earlier display names). */
  aliases: number;
  relations: number;
  /** What stays: the Commitments that still point at the person (their name stays) and the participant records. */
  commitmentsKept: number;
  participantLinksKept: number;
};

/** One line of the purge receipts: ids, a hash and counts, never a name or a contact. */
export type CounterpartPurgeReceipt = {
  id: string;
  counterpartId: string;
  nameHash: string;
  contactCount: number;
  linkCount: number;
  aliasCount: number;
  relationCount: number;
  requestedBy: string;
  executedAt: number;
};

export const NOT_PERSON_DESTINATIONS = ["organization", "team", "self", "dismiss"] as const;
export type NotPersonDestination = (typeof NOT_PERSON_DESTINATIONS)[number];

/** What "this is not a person" reaches for one typed name. */
export type NotPersonImpact = {
  total: number;
  open: number;
  works: Array<{ workId: string; title: string }>;
};

/** A typed name the user said points at nobody; it no longer waits in "to confirm" until it is restored. */
export type DismissedName = { id: string; raw: string; createdAt: number };

/** A group of Commitments whose responsible person is only a typed name (design 9: "待确认人员"). */
export type PendingPersonGroup = {
  key: string;
  raw: string;
  total: number;
  open: number;
  overdue: number;
  earliestDueAt: number | null;
  commitmentIds: string[];
  suggestions: NameMatch["candidates"];
  /** Some commitment here has words that named several people: it needs "who answers" chosen, not a person to point at. */
  joint?: boolean;
};

export type PersonView = {
  counterpart: CounterpartRecord;
  responsible: CommitmentRecord[];
  history: CommitmentRecord[];
  related: Array<{
    workId: string;
    title: string;
    lifecycle: string;
    updatedAt: number;
    via: string;
  }>;
  /** Commitments he helps with (not answers for), with his roles in each: participant, approver or recipient. */
  assisting?: Array<{ commitment: CommitmentRecord; roles: string[] }>;
  counts: { unresolved: number; overdue: number; needsConfirmation: number };
};
