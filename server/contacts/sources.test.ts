import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger";
import { githubEmails, hunterVerify, siteContacts } from "./sources";
import { fakeFetch } from "./testing";

test("siteContacts collects domain emails and phones, skips 404 pages", async () => {
  const { f } = fakeFetch({
    "https://acme.com": "<a href='mailto:careers@acme.com'>Jobs</a> partner@other.com",
    "https://acme.com/contact": "Reach Priya at priya.sharma@acme.com or +91 98765 43210",
  });
  const r = await siteContacts("acme.com", f);
  expect(r.emails.sort()).toEqual(["careers@acme.com", "priya.sharma@acme.com"]);
  expect(r.phones).toEqual(["+919876543210"]);
  expect(r.pages.sort()).toEqual(["https://acme.com", "https://acme.com/contact"]);
});

test("githubEmails returns named commit authors at the domain only", async () => {
  const { f } = fakeFetch({
    "https://api.github.com/search/users": { items: [{ login: "acme-hq" }] },
    "https://api.github.com/orgs/acme-hq": { login: "acme-hq", name: "Acme", blog: "https://acme.com" },
    "https://api.github.com/orgs/acme-hq/repos": [{ name: "app" }],
    "https://api.github.com/repos/acme-hq/app/commits": [
      { commit: { author: { name: "Priya Sharma", email: "priya.sharma@acme.com" } } },
      { commit: { author: { name: "Bot", email: "x@users.noreply.github.com" } } },
      { commit: { author: { name: "Ravi", email: "y@gmail.com" } } },
      { commit: { author: { name: "Priya Sharma", email: "priya.sharma@acme.com" } } },
    ],
  });
  expect(await githubEmails("Acme", "acme.com", f)).toEqual([{ name: "Priya Sharma", email: "priya.sharma@acme.com" }]);
});

test("githubEmails parses a commit list larger than the page size cap", async () => {
  const filler = Array.from({ length: 3000 }, (_, i) => ({ commit: { author: { name: "Bot", email: `bot${i}@users.noreply.github.com` }, message: "x".repeat(200) } }));
  const { f } = fakeFetch({
    "https://api.github.com/search/users": { items: [{ login: "acme" }] },
    "https://api.github.com/orgs/acme": { login: "acme", blog: "acme.com" },
    "https://api.github.com/orgs/acme/repos": [{ name: "app" }],
    "https://api.github.com/repos/acme/app/commits": [...filler, { commit: { author: { name: "Priya Sharma", email: "priya.sharma@acme.com" } } }],
  });
  expect(await githubEmails("Acme", "acme.com", f)).toEqual([{ name: "Priya Sharma", email: "priya.sharma@acme.com" }]);
});

test("githubEmails skips an org whose site is another domain", async () => {
  const { f } = fakeFetch({
    "https://api.github.com/search/users": { items: [{ login: "acme-games" }] },
    "https://api.github.com/orgs/acme-games": { login: "acme-games", name: "Acme Games", blog: "https://acmegames.io" },
  });
  expect(await githubEmails("Acme", "acme.com", f)).toEqual([]);
});

const ledgerFile = () => join(mkdtempSync(join(tmpdir(), "ak-")), "credits.json");

test("ledger stops at the monthly limit and persists", () => {
  const file = ledgerFile();
  const l = new Ledger(file, { hunter: { month: 2 } });
  l.spend("hunter");
  l.spend("hunter");
  expect(l.canSpend("hunter")).toBe(false);
  expect(new Ledger(file, { hunter: { month: 2 } }).usage().hunter.month).toBe(2);
});

test("hunterVerify maps statuses and spends one unit per call", async () => {
  const l = new Ledger(ledgerFile(), { hunter: { month: 5 } });
  const ok = fakeFetch({ "https://api.hunter.io/v2/email-verifier": { data: { status: "valid" } } });
  expect(await hunterVerify("a@acme.com", "k", ok.f, l)).toBe("verified");
  const catchAll = fakeFetch({ "https://api.hunter.io/v2/email-verifier": { data: { status: "accept_all" } } });
  expect(await hunterVerify("b@acme.com", "k", catchAll.f, l)).toBe("likely");
  expect(l.usage().hunter.month).toBe(2);
});

test("hunterVerify makes no call once the allowance is used up", async () => {
  const l = new Ledger(ledgerFile(), { hunter: { month: 0 } });
  const { f, calls } = fakeFetch({ "https://api.hunter.io/v2/email-verifier": { data: { status: "valid" } } });
  expect(await hunterVerify("a@acme.com", "k", f, l)).toBeNull();
  expect(calls.length).toBe(0);
});
