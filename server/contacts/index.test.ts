import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findContacts, type FindDeps, type Research } from "./index";
import { Ledger } from "./ledger";
import { fakeFetch } from "./testing";

const priya = { name: "Priya Sharma", title: "Talent Acquisition", type: "recruiter", linkedin: "https://linkedin.com/in/priya-s", x: "", email: "", phone: "", source: "https://acme.com/team", why: "hires engineers" };

const GITHUB = {
  "https://api.github.com/search/users": { items: [{ login: "acme" }] },
  "https://api.github.com/orgs/acme": { login: "acme", blog: "acme.com" },
  "https://api.github.com/orgs/acme/repos": [{ name: "app" }],
  "https://api.github.com/repos/acme/app/commits": [
    { commit: { author: { name: "Rahul Verma", email: "rahul.verma@acme.com" } } },
    { commit: { author: { name: "Neha Gupta", email: "neha.gupta@acme.com" } } },
  ],
};

function deps(over: Partial<FindDeps> = {}, routes: Record<string, unknown> = GITHUB, research?: Partial<Research>) {
  const dir = mkdtempSync(join(tmpdir(), "ak-"));
  const ff = fakeFetch(routes);
  let researchCalls = 0;
  const d: FindDeps = {
    fetch: ff.f,
    research: async () => {
      researchCalls++;
      return { domain: "acme.com", email_pattern: "", people: [{ ...priya, phone: "+91 98765 43210", source: "https://linkedin.com/posts/hiring-123" }], notes: "", ...research };
    },
    ledger: new Ledger(join(dir, "credits.json"), { hunter: { month: 50 } }),
    cacheDir: dir,
    mx: async () => true,
    today: () => "2026-10-21",
    ...over,
  };
  return { d, calls: ff.calls, researchCalls: () => researchCalls };
}

test("phone, guessed email from the GitHub pattern, then LinkedIn", async () => {
  const { d } = deps();
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.pattern).toEqual({ pattern: "first.last", matches: 2, from: "github" });
  const p = r.people.find((x) => x.name === "Priya Sharma")!;
  expect(p.contacts.map((c) => [c.kind, c.value, c.status])).toEqual([
    ["phone", "+919876543210", "published"],
    ["email", "priya.sharma@acme.com", "guessed"],
    ["linkedin", "https://linkedin.com/in/priya-s", undefined],
  ]);
  expect(p.contacts[0].source).toBe("https://linkedin.com/posts/hiring-123");
  expect(r.apolloSearch).toContain("Acme");
});

test("Hunter upgrades a guessed email to verified", async () => {
  const { d } = deps({ hunterKey: "k" }, { ...GITHUB, "https://api.hunter.io/v2/email-verifier": { data: { status: "valid" } } });
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.people[0].contacts.find((c) => c.kind === "email")?.status).toBe("verified");
});

test("second call is served from cache; refresh fetches again", async () => {
  const { d, calls, researchCalls } = deps();
  await findContacts({ company: "Acme" }, d);
  const n = calls.length;
  await findContacts({ company: "Acme" }, d);
  expect(calls.length).toBe(n);
  expect(researchCalls()).toBe(1);
  await findContacts({ company: "Acme", refresh: true }, d);
  expect(researchCalls()).toBe(2);
});

test("unknown domain: people kept, no guessed emails", async () => {
  const { d } = deps({ mx: async () => false }, {}, { domain: "" });
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.people.length).toBe(1);
  expect(r.people[0].contacts.some((c) => c.kind === "email")).toBe(false);
});

test("a failing source is reported, the rest still return", async () => {
  const { d } = deps({}, { "https://api.github.com/search/users": new Error("rate limited") });
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.people.length).toBe(1);
  expect(r.errors.some((e) => e.startsWith("github:"))).toBe(true);
});

test("research failure still returns site contacts", async () => {
  const { d } = deps({ research: async () => { throw new Error("claude down"); } }, { "https://acme.com/careers": "Write to careers@acme.com" });
  const r = await findContacts({ company: "Acme", domain: "acme.com" }, d);
  expect(r.errors.some((e) => e.startsWith("research:"))).toBe(true);
  expect(r.inboxes.map((c) => c.value)).toEqual(["careers@acme.com"]);
});

test("old research cached before v2 is reused instead of asking Claude again", async () => {
  const old = { domain: "acme.com", email_pattern: "", people: [{ name: "Neha Gupta", title: "Recruiter", type: "recruiter", linkedin: "", x: "", email_guess: "neha.gupta@acme.com", why: "", source: "" }], notes: "old notes" };
  const { d, researchCalls } = deps({ legacy: () => old as any });
  const r = await findContacts({ company: "Acme" }, d);
  expect(researchCalls()).toBe(0);
  expect(r.people.map((p) => p.name)).toEqual(["Neha Gupta"]);
  expect(r.notes).toBe("old notes");
  await findContacts({ company: "Acme", refresh: true }, d);
  expect(researchCalls()).toBe(1);
});

test("profile links that aren't http(s) are dropped", async () => {
  const { d } = deps({}, GITHUB, { people: [{ ...priya, linkedin: "javascript:alert(1)", x: "https://x.com/priya" }] });
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.people[0].contacts.filter((c) => c.kind === "linkedin")).toEqual([]);
  expect(r.people[0].contacts.find((c) => c.kind === "x")?.value).toBe("https://x.com/priya");
});

test("role inbox goes to inboxes and never sets the pattern; a site email confirms a person", async () => {
  const { d } = deps({}, { "https://acme.com/team": "careers@acme.com priya.sharma@acme.com" });
  const r = await findContacts({ company: "Acme" }, d);
  expect(r.inboxes.map((c) => c.value)).toEqual(["careers@acme.com"]);
  expect(r.pattern?.from).toBe("site");
  expect(r.people[0].contacts.find((c) => c.kind === "email")).toMatchObject({ value: "priya.sharma@acme.com", status: "published" });
});
