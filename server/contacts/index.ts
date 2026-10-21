// findContacts: who hires at a company and how to reach them, from free sources first.
// Order of trust for the email pattern: GitHub commit authors, then emails on the company site,
// then Claude's research. Every contact keeps where it came from.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPattern, extractEmails, extractPhones, inferPattern, isRoleInbox, type Pattern } from "./extract";
import type { Ledger } from "./ledger";
import { mergePeople, rankContacts, rankPeople, type Contact, type Person } from "./merge";
import { githubEmails, hasMx, hunterVerify, siteContacts, type Fetch } from "./sources";

export type FindInput = { company: string; role?: string; url?: string; jd?: string; domain?: string; refresh?: boolean };
export type Research = {
  domain: string;
  email_pattern: string;
  people: { name: string; title: string; type: string; linkedin: string; x: string; email: string; phone: string; source: string; why: string }[];
  notes: string;
};
export type FindDeps = {
  fetch: Fetch;
  research: (i: FindInput) => Promise<Research>;
  // Research saved by the older People feature (same shape, email_guess instead of email); reused unless refreshing.
  legacy?: (company: string) => Research | null;
  ledger: Ledger;
  cacheDir: string;
  hunterKey?: string;
  githubToken?: string;
  mx?: (domain: string) => Promise<boolean>;
  today: () => string;
};
export type FindResult = {
  company: string;
  domain: string;
  pattern: { pattern: Pattern; matches: number; from: "github" | "site" | "research" } | null;
  people: Person[];
  inboxes: Contact[];
  sources: string[];
  errors: string[];
  notes: string;
  fetchedAt: string;
  apolloSearch: string;
};

const VERIFY_TOP = 3;
const TYPES = new Set(["recruiter", "hiring_manager", "founder", "engineer"]);
const PATTERNS: Pattern[] = ["first.last", "firstlast", "flast", "f.last", "first_last", "last.first", "firstl", "first", "last"];

export const slug = (s = "") => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isWebUrl = (u = "") => /^https?:\/\/[^\s"<>]+$/i.test(u);
const cleanDomain = (d = "") => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0];

export async function findContacts(i: FindInput, d: FindDeps): Promise<FindResult> {
  const file = join(d.cacheDir, slug(i.company) + ".v2.json");
  if (!i.refresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  const errors: string[] = [], sources: string[] = [];
  const attempt = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { const v = await fn(); sources.push(name); return v; }
    catch (e: any) { errors.push(`${name}: ${e?.message || e}`); return fallback; }
  };

  const saved = i.refresh ? null : d.legacy?.(i.company) ?? null;
  const research = saved ?? await attempt<Research>("research", () => d.research(i), { domain: "", email_pattern: "", people: [], notes: "" });
  if (saved) sources.push("research (saved)");
  const domain = cleanDomain(i.domain || research.domain);

  const [site, gh, mx] = domain
    ? await Promise.all([
        attempt("site", () => siteContacts(domain, d.fetch), { emails: [], phones: [], pages: [] }),
        attempt("github", () => githubEmails(i.company, domain, d.fetch, d.githubToken), []),
        (d.mx ?? hasMx)(domain).catch(() => false),
      ])
    : [{ emails: [], phones: [], pages: [] }, [], false];

  const jd = String(i.jd || "");
  const jdEmails = domain ? extractEmails(jd, domain) : extractEmails(jd);
  const named = research.people.filter((p) => p.name?.trim());

  // Site emails that match a researched person under some pattern confirm both the person and the pattern.
  const sitePairs: { name: string; email: string }[] = [];
  for (const e of [...site.emails, ...jdEmails]) {
    if (isRoleInbox(e)) continue;
    const p = named.find((n) => PATTERNS.some((pt) => applyPattern(pt, n.name, domain) === e));
    if (p) sitePairs.push({ name: p.name, email: e });
  }

  const fromGh = domain ? inferPattern(gh, domain) : null;
  const fromSite = domain ? inferPattern(sitePairs, domain) : null;
  const fromResearch = PATTERNS.find((p) => research.email_pattern?.toLowerCase().replace(/\s/g, "").startsWith(p));
  const pattern: FindResult["pattern"] = fromGh ? { ...fromGh, from: "github" }
    : fromSite ? { ...fromSite, from: "site" }
    : fromResearch ? { pattern: fromResearch, matches: 0, from: "research" } : null;

  const people: Person[] = named.map((p) => {
    const contacts: Contact[] = [];
    for (const ph of extractPhones(p.phone || "")) contacts.push({ kind: "phone", value: ph, status: "published", source: p.source || "research" });
    for (const e of extractEmails(p.email || "")) contacts.push({ kind: "email", value: e, status: "published", source: p.source || "research" });
    const confirmed = sitePairs.find((s) => s.name === p.name);
    if (confirmed) contacts.push({ kind: "email", value: confirmed.email, status: "published", source: site.pages[0] || "site" });
    else if (pattern && mx && !contacts.some((c) => c.kind === "email")) {
      const g = applyPattern(pattern.pattern, p.name, domain);
      if (g) contacts.push({ kind: "email", value: g, status: "guessed", source: `pattern ${pattern.pattern} (${pattern.from})` });
    }
    // Links come from web pages via Claude: only plain http(s) URLs reach the UI.
    if (isWebUrl(p.linkedin)) contacts.push({ kind: "linkedin", value: p.linkedin, source: p.source || "research" });
    if (isWebUrl(p.x)) contacts.push({ kind: "x", value: p.x, source: p.source || "research" });
    return { name: p.name.trim(), title: p.title || "", type: (TYPES.has(p.type) ? p.type : "other") as Person["type"], why: p.why, contacts };
  });

  let ranked = rankPeople(mergePeople([people]));

  if (d.hunterKey) {
    const guesses = ranked.flatMap((p) => p.contacts.filter((c) => c.kind === "email" && c.status === "guessed")).slice(0, VERIFY_TOP);
    for (const c of guesses) {
      const v = await attempt("hunter", () => hunterVerify(c.value, d.hunterKey!, d.fetch, d.ledger), null);
      if (v === "verified" || v === "likely") { c.status = v; c.source = "hunter verifier"; }
      else if (v === "invalid") for (const p of ranked) p.contacts = p.contacts.filter((x) => x !== c);
    }
  }
  ranked = ranked.map((p) => ({ ...p, contacts: rankContacts(p.contacts) }));

  const inboxes: Contact[] = [
    ...[...new Set([...site.emails, ...jdEmails].filter(isRoleInbox))].map((e): Contact => ({ kind: "inbox", value: e, status: "published", source: site.pages[0] || "job page" })),
    ...[...new Set([...site.phones, ...extractPhones(jd)])].map((ph): Contact => ({ kind: "phone", value: ph, status: "published", source: site.pages[0] || "job page" })),
  ];

  const result: FindResult = {
    company: i.company, domain, pattern, people: ranked, inboxes, sources: [...new Set(sources)], errors,
    notes: research.notes || "", fetchedAt: d.today(),
    apolloSearch: `https://app.apollo.io/#/people?qOrganizationName=${encodeURIComponent(i.company)}`,
  };
  writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}
