// Combine the same person found by different sources, and order people and their contacts.
import { normName } from "./extract";

export type Status = "verified" | "published" | "likely" | "guessed";
export type Contact = { kind: "phone" | "email" | "linkedin" | "x" | "inbox"; value: string; status?: Status; source: string };
export type Person = { name: string; title: string; type: "recruiter" | "hiring_manager" | "founder" | "engineer" | "other"; why?: string; contacts: Contact[] };

const STRENGTH: Record<Status, number> = { verified: 4, published: 3, likely: 2, guessed: 1 };
const KIND = { phone: 0, email: 1, linkedin: 2, x: 3, inbox: 4 };
const TYPE = { recruiter: 0, hiring_manager: 1, founder: 2, engineer: 3, other: 4 };

const normUrl = (u: string) => u.toLowerCase().split(/[?#]/)[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
const normValue = (c: Contact) => (c.kind === "email" || c.kind === "inbox" ? c.value.toLowerCase() : c.kind === "linkedin" || c.kind === "x" ? normUrl(c.value) : c.value);
const strength = (c: Contact) => (c.status ? STRENGTH[c.status] : 0);

export function mergePeople(lists: Person[][]): Person[] {
  const out: Person[] = [];
  const keysOf = (p: Person) => [
    `n:${normName(p.name)}`,
    ...p.contacts.filter((c) => c.kind === "linkedin").map((c) => `l:${normUrl(c.value)}`),
  ];
  const index = new Map<string, Person>();
  for (const p of lists.flat()) {
    const keys = keysOf(p);
    const hit = keys.map((k) => index.get(k)).find(Boolean);
    const target = hit ?? { ...p, contacts: [] };
    if (!hit) out.push(target);
    else {
      if (p.title.length > target.title.length) target.title = p.title;
      if (target.type === "other") target.type = p.type;
      target.why ||= p.why;
    }
    for (const c of p.contacts) {
      const v = normValue(c);
      const i = target.contacts.findIndex((x) => x.kind === c.kind && normValue(x) === v);
      const nc = { ...c, value: c.kind === "email" || c.kind === "inbox" ? v : c.value };
      if (i < 0) target.contacts.push(nc);
      else if (strength(nc) > strength(target.contacts[i])) target.contacts[i] = nc;
    }
    for (const k of keysOf(target)) index.set(k, target);
  }
  return out;
}

export const rankContacts = (c: Contact[]) => [...c].sort((a, b) => KIND[a.kind] - KIND[b.kind] || strength(b) - strength(a));

export const rankPeople = (p: Person[]) => [...p].sort((a, b) => TYPE[a.type] - TYPE[b.type] || b.contacts.length - a.contacts.length);
