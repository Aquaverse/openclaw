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
  counts: { unresolved: number; overdue: number; needsConfirmation: number };
};
