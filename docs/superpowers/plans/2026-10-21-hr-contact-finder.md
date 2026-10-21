# HR Contact Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For any job (from the board scanner or the page open in Chrome), find the people who hire there and their best contact (phone > email > LinkedIn > other) from free sources, with each contact's source and confidence.

**Architecture:** A new `server/contacts/` module: pure extraction/pattern/merge functions, small source adapters (company site, GitHub, Claude research, Hunter verifier) that take an injected `fetch`, and one orchestrator `findContacts` that caches per company. `/api/people` switches to it. The dashboard gets a Jobs tab and richer contact rows; the popup gets a Find HR card.

**Tech Stack:** Bun 1.3 (server, `bun test`), plain HTML/JS dashboard, Chrome MV3 extension, existing Python scanner.

**Spec:** `docs/superpowers/specs/2026-10-21-hr-contact-finder-design.md`

## Global Constraints

- Free sources must work with no keys. Keys (`hunter_api_key`, `github_token`, later `apollo_api_key`) live only in `server/config.json`; never logged, never returned by any endpoint (`GET /api/config` must strip them).
- Never send anything. Contacts open as `tel:`, `https://wa.me/<digits>`, Gmail compose, or LinkedIn links the user clicks.
- No scraping of LinkedIn or Apollo web UI. Only company websites, the GitHub API, the job page, Claude WebSearch/WebFetch, and verifier APIs.
- Do not build an SMTP RCPT check (port 25 is blocked on the owner's network).
- Every contact carries `source` (URL or source name) and, for emails, `status: "verified" | "published" | "likely" | "guessed"`. Guessed contacts are never shown as verified.
- The repo is public: no personal data in code, tests, fixtures or examples. Fixtures use `acme.com`-style fake data.
- Auto mode is off by default; cap default 10 companies/day.
- Copy in the UI: no emojis, no em/en dashes as punctuation (existing house style).

## Review Focus

1. **Company with no website or a domain we guessed wrong** (e.g. scanner slug `level-ai`): expect people from Claude research only, no crash, no emails invented for the wrong domain. Test in Task 4.
2. **Generic inboxes** (`careers@`, `hr@`, `jobs@`, `talent@`): shown as a team inbox contact, never used to infer the personal pattern. Test in Task 1.
3. **Indian phone formats** (`+91 98765 43210`, `098765-43210`, `9876543210`) normalise to `+919876543210`; dates, prices and order numbers are not phones. Test in Task 1.
4. **Hunter key missing or monthly allowance used up**: guessed emails stay `guessed`, ledger never exceeds the configured limit. Test in Task 2.
5. **A source fails or times out** (site 403, GitHub rate limit, Claude error): the others still return; the failure is listed in `errors` on the result. Test in Task 4.

---

### Task 1: Pure extraction and pattern helpers

**Files:**
- Create: `server/contacts/extract.ts`
- Test: `server/contacts/extract.test.ts`

**Interfaces:**
- Produces:
  - `extractEmails(text: string, domain?: string): string[]` — lowercase, deduped; when `domain` is given keep only that domain and its subdomains; drop image-like matches (`@2x.png`) and `example.com`/`sentry.io`/`wixpress.com`-style noise.
  - `isRoleInbox(email: string): boolean` — local part in `careers|jobs|hr|talent|recruit(ing|ment)?|hiring|people|hello|contact|info|team|support|admin|hey`.
  - `extractPhones(text: string): string[]` — Indian mobiles (`[6-9]\d{9}` after optional `+91`/`91`/`0`, spaces/dashes allowed) normalised to `+91XXXXXXXXXX`; also `+<country><8-12 digits>` international kept as `+digits`. Reject digit runs inside longer numbers.
  - `type Pattern = "first.last" | "firstlast" | "first" | "flast" | "f.last" | "first_last" | "last.first" | "firstl" | "last"`
  - `inferPattern(pairs: { name: string; email: string }[], domain: string): { pattern: Pattern; matches: number } | null` — ignore role inboxes and other domains; pick the pattern with most matches; null if none.
  - `applyPattern(pattern: Pattern, name: string, domain: string): string` — ASCII-fold, lowercase, first = first token, last = last token; single-token names only work for `first`.
  - `normName(name: string): string` — lowercase, ASCII-folded, single spaces (used for merging).

- [ ] **Step 1: Write the failing tests** (`bun:test`)

```ts
test("emails filtered to domain, noise dropped", () => {
  expect(extractEmails("Mail priya.s@acme.com or a@other.com, logo@2x.png, x@sentry.io", "acme.com")).toEqual(["priya.s@acme.com"]);
});
test("role inboxes", () => {
  expect(isRoleInbox("careers@acme.com")).toBe(true);
  expect(isRoleInbox("priya.sharma@acme.com")).toBe(false);
});
test("indian phones normalise; non-phones ignored", () => {
  expect(extractPhones("WhatsApp +91 98765 43210 or 098765-43211, call 9876543212")).toEqual(["+919876543210", "+919876543211", "+919876543212"]);
  expect(extractPhones("Order 2026101298765 costs ₹12,999 on 21-10-2026")).toEqual([]);
});
test("pattern inferred from named pairs, role inbox ignored", () => {
  const pairs = [{ name: "Priya Sharma", email: "priya.sharma@acme.com" }, { name: "Rahul Verma", email: "rahul.verma@acme.com" }, { name: "Acme", email: "careers@acme.com" }];
  expect(inferPattern(pairs, "acme.com")).toEqual({ pattern: "first.last", matches: 2 });
});
test("apply pattern", () => {
  expect(applyPattern("flast", "Ankit Kumar Jain", "acme.com")).toBe("ajain@acme.com");
  expect(applyPattern("first.last", "José Núñez", "acme.com")).toBe("jose.nunez@acme.com");
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && bun test contacts/extract.test.ts` → FAIL (module not found)
- [ ] **Step 3: Implement the functions in `server/contacts/extract.ts`**
- [ ] **Step 4: Run to verify it passes** — same command → all pass. Add `"test": "bun test"` to `server/package.json` scripts.
- [ ] **Step 5: Commit** — `git add server/contacts server/package.json && git commit -m "feat(contacts): email, phone and pattern helpers"`

---

### Task 2: Sources: company site, GitHub, verifier with credit ledger

**Files:**
- Create: `server/contacts/sources.ts`, `server/contacts/ledger.ts`
- Test: `server/contacts/sources.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces:
  - `type Fetch = (url: string, init?: RequestInit) => Promise<Response>`
  - `siteContacts(domain: string, f: Fetch): Promise<{ emails: string[]; phones: string[]; pages: string[] }>` — GET `https://<domain>` plus `/careers`, `/contact`, `/contact-us`, `/about`, `/team`, `/jobs` (6 s timeout each via `AbortSignal.timeout(6000)`, 404s skipped, max 400 KB per page); emails filtered to the domain; `pages` = URLs that produced something.
  - `githubEmails(company: string, domain: string, f: Fetch, token?: string): Promise<{ name: string; email: string }[]>` — `GET https://api.github.com/search/users?q=<company>+type:org` (first org whose `blog`/name matches the company or domain via `GET /orgs/<login>`), then `GET /orgs/<login>/repos?sort=pushed&per_page=5` and `GET /repos/<o>/<r>/commits?per_page=50` for each; return author name+email pairs at `domain` (skip `noreply`). Auth header only if token. Total cap 12 requests.
  - `hasMx(domain: string): Promise<boolean>` — `node:dns/promises` `resolveMx`, false on error.
  - `class Ledger { constructor(file: string, limits: Record<string, { day?: number; month?: number }>); canSpend(source: string): boolean; spend(source: string): void; usage(): Record<string, { day: number; month: number }> }` — persisted JSON keyed by source with day `YYYY-MM-DD` and month `YYYY-MM` counters.
  - `hunterVerify(email: string, key: string, f: Fetch, ledger: Ledger): Promise<"verified" | "likely" | "invalid" | null>` — `GET https://api.hunter.io/v2/email-verifier?email=…&api_key=…`; `data.status` `valid`→verified, `accept_all`/`webmail`→likely, `invalid`→invalid, else null; returns null without a call when `!ledger.canSpend("hunter")`; spends one unit per call made. Default limit `{ month: 50 }`.

- [ ] **Step 1: Write failing tests** with a fake `Fetch` built from a URL→body map:
  - `siteContacts` on fake pages returns `{ emails: ["careers@acme.com","priya.sharma@acme.com"], phones: ["+919876543210"] }` and ignores a 404 `/team`.
  - `githubEmails` returns `[{ name: "Priya Sharma", email: "priya.sharma@acme.com" }]` and drops `x@users.noreply.github.com` and `y@gmail.com`.
  - `Ledger` with `{ hunter: { month: 2 } }`: after two `spend`, `canSpend` is false; a new Ledger on the same file reads the same usage.
  - `hunterVerify` maps `valid`→`"verified"`, `accept_all`→`"likely"`; with an exhausted ledger it returns `null` and the fake fetch records zero calls.
- [ ] **Step 2: Run** `cd server && bun test contacts/sources.test.ts` → FAIL
- [ ] **Step 3: Implement** `sources.ts` and `ledger.ts`.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** — `feat(contacts): company site, GitHub and Hunter sources with a credit ledger`

---

### Task 3: Merge and rank people

**Files:**
- Create: `server/contacts/merge.ts`
- Test: `server/contacts/merge.test.ts`

**Interfaces:**
- Produces:
  - `type Contact = { kind: "phone" | "email" | "linkedin" | "x" | "inbox"; value: string; status?: "verified" | "published" | "likely" | "guessed"; source: string }`
  - `type Person = { name: string; title: string; type: "recruiter" | "hiring_manager" | "founder" | "engineer" | "other"; why?: string; contacts: Contact[] }`
  - `mergePeople(lists: Person[][]): Person[]` — same person if equal LinkedIn URL (normalised: lowercase, no query, no trailing slash) or equal `normName`; union contacts, dedupe by `kind+value`, keep the strongest email status (`verified > published > likely > guessed`); keep the longest non-empty title.
  - `rankContacts(c: Contact[]): Contact[]` — order phone, email (by status strength), linkedin, x, inbox.
  - `rankPeople(p: Person[]): Person[]` — recruiter, hiring_manager, founder, engineer, other; ties: more contacts first.

- [ ] **Step 1: Write failing tests:** two lists with "Priya Sharma" (one with LinkedIn + guessed email, one with the same email `verified`) merge into one person with that email `verified`; `rankContacts` puts a phone before a verified email before LinkedIn; `rankPeople` puts a recruiter before a founder.
- [ ] **Step 2: Run** `bun test contacts/merge.test.ts` → FAIL
- [ ] **Step 3: Implement** `merge.ts`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** — `feat(contacts): merge people across sources and rank contacts`

---

### Task 4: `findContacts` orchestrator and `/api/people`

**Files:**
- Create: `server/contacts/index.ts`
- Modify: `server/server.ts` (`POST /api/people` at lines 212–232, `GET /api/config` at line 177, the Claude research prompt), `server/config.example.json`
- Test: `server/contacts/index.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `type FindInput = { company: string; role?: string; url?: string; jd?: string; domain?: string; refresh?: boolean }`
  - `type FindDeps = { fetch: Fetch; research: (i: FindInput) => Promise<Research>; ledger: Ledger; cacheDir: string; hunterKey?: string; githubToken?: string; mx?: (d: string) => Promise<boolean>; today: () => string }`
  - `type Research = { domain: string; email_pattern: string; people: { name: string; title: string; type: string; linkedin: string; x: string; email: string; phone: string; source: string; why: string }[]; notes: string }` (Claude's JSON; `email`/`phone` only when a source it opened printed them).
  - `type FindResult = { company: string; domain: string; pattern: { pattern: Pattern; matches: number; from: "github" | "site" | "research" } | null; people: Person[]; inboxes: Contact[]; sources: string[]; errors: string[]; fetchedAt: string; apolloSearch: string }`
  - `findContacts(i: FindInput, d: FindDeps): Promise<FindResult>`
- Flow: cache hit (`<cacheDir>/<slug>.v2.json`) unless `refresh` → research (Claude) gives domain + people → in parallel `siteContacts`, `githubEmails`, `hasMx`, and `extractEmails/extractPhones` on `jd` → `inferPattern` from GitHub pairs, else from site named emails, else the research pattern → each person without an email gets `applyPattern` (status `guessed`, only if `hasMx`) → published emails/phones from research/site/jd are `published` with their source URL → up to 3 top-ranked guessed emails go to `hunterVerify` if a key is set → `mergePeople`, `rankPeople`, `rankContacts` → role inboxes into `inboxes` → `apolloSearch` = `https://app.apollo.io/#/people?qOrganizationName=<company>` link → write cache. Each source wrapped in try/catch pushing `"<source>: <message>"` to `errors`.
- `server.ts`: the research prompt (existing text at lines 218–227) additionally asks for phone/WhatsApp numbers and emails that recruiters published in public hiring posts or pages, with the exact URL, and never guessed ones. `/api/people` returns `{ ...findContacts(...), connections: connectionsAt(company) }`. `GET /api/config` returns the config without any key ending in `_key` or `_token`. Ledger file `data/credits.json`, limits from config `limits` (default `{ hunter: { month: 50 } }`).
- `config.example.json` gains `"hunter_api_key": ""`, `"github_token": ""`, `"limits": { "hunter": { "month": 50 } }`, `"auto": { "enabled": false, "perDay": 10 }`.

- [ ] **Step 1: Write failing tests** with fake deps:
  - research returns Priya (recruiter, LinkedIn, no email) and a post with `+91 98765 43210`; GitHub yields two `first.last` pairs → result person Priya has contacts `[phone published, email priya.sharma@acme.com guessed, linkedin]` in that order, `pattern.from === "github"`.
  - with `hunterKey` and fake Hunter `valid` → that email becomes `verified`.
  - second call returns the cache and makes zero fetches; `refresh: true` refetches.
  - **Review Focus 1:** research returns no domain and `hasMx` false → no guessed emails at all, people still returned.
  - **Review Focus 5:** site fetch throws → result still has people and `errors` contains `"site: …"`.
  - **Review Focus 2:** site has `careers@acme.com` → it appears in `inboxes`, not used for the pattern.
- [ ] **Step 2: Run** `bun test contacts/index.test.ts` → FAIL
- [ ] **Step 3: Implement** `index.ts`, then wire `server.ts` and the example config.
- [ ] **Step 4: Run** `bun test` (all) → PASS; then `bun server/server.ts` and `curl -s -X POST localhost:4777/api/people -H content-type:application/json -d '{"company":"Composio","refresh":true}'` → JSON with `people`, `sources`, `errors`; `curl -s localhost:4777/api/config` shows no `_key`/`_token` fields.
- [ ] **Step 5: Commit** — `feat(contacts): findContacts orchestrator behind /api/people`

---

### Task 5: Dashboard: contact rows, Jobs tab, auto mode

**Files:**
- Modify: `server/dashboard.html` (`renderPeople` around lines 544–585, tabs at lines 135–138, new `<section data-panel="jobs">`), `server/server.ts` (new routes + auto runner)

**Interfaces:**
- Consumes: `/api/people` → `FindResult & { connections }`.
- Produces routes:
  - `GET /api/jobs` → `{ jobs: Job[]; scannedAt: string | null }` from `data/jobs.json`; `Job` = scanner fields `{ ats, company, title, location, posted, url, apply }` plus `people?: number` (count from cache if present).
  - `POST /api/jobs/scan` → runs `python tools/scan-boards.py server/data/jobs.json` (Bun.spawn, cwd repo root, 5 min timeout), returns `{ count }`.
  - `GET /api/auto` / `POST /api/auto` `{ enabled?: boolean; perDay?: number }` → `{ enabled, perDay, doneToday, running }`, persisted in `data/auto.json`.
  - Auto runner: `setInterval` every 10 min; if enabled and `doneToday < perDay`, take the newest job whose company has no cache file and run `findContacts` for it (one at a time).
- UI:
  - Contact row per person: name, title, type badge; then contacts in ranked order as chips: phone → `tel:` and `https://wa.me/<digits>` buttons; email → Gmail compose (existing compose link) with a status badge (`verified` green, `published` green, `likely` amber, `guessed` grey with tooltip "pattern guess, not checked"); LinkedIn/X → open; each chip shows its source on hover. Existing Draft/Mark sent buttons stay.
  - Phone chips get a "Draft" that calls `/api/outreach/draft` with `channel: "whatsapp"`; add that channel to the existing prompt in `server.ts` (line 262): "WhatsApp message (under 60 words, polite, says who I am, the exact role, and asks if I can share my resume; no links except one)".
  - Below people: team inboxes, "Find on Apollo" link (`apolloSearch`), `errors` in muted text.
  - Jobs tab: Scan now button, last scanned time, table (company, title, location, posted, People count or "Find HR" button), auto toggle + per-day number + "done today".

- [ ] **Step 1: Implement the routes and auto runner** in `server.ts`.
- [ ] **Step 2: Verify routes** — `curl -s -X POST localhost:4777/api/jobs/scan` → `{"count":N}` with N > 0; `curl -s localhost:4777/api/jobs` lists them; `POST /api/auto {"enabled":true,"perDay":1}` then wait for one cycle (temporarily call the runner once at startup when enabled) → one new `data/people/*.v2.json`.
- [ ] **Step 3: Implement the dashboard UI.**
- [ ] **Step 4: Verify in the browser** — open `http://localhost:4777`, Jobs tab shows scanned jobs; Find HR on one job shows people with ranked chips and badges; a guessed email shows the grey badge; `tel:`/`wa.me` hrefs are `+91…` digits. Screenshot it.
- [ ] **Step 5: Commit** — `feat(dashboard): Jobs tab, auto contact finding, ranked contact chips`

---

### Task 6: Extension: Find HR in the popup

**Files:**
- Modify: `fill.js` (`pageInfo`, lines 363–374), `popup.html` (new card after the score card), `popup.js`

**Interfaces:**
- Consumes: `api("/api/people", { company, role, url, jd })` from `lib.js`.
- `pageInfo` company detection additions (return `domain` too when a company website link is on the page):
  - LinkedIn Jobs: `.job-details-jobs-unified-top-card__company-name a` text, fallback `a[href*="/company/"]` text.
  - Naukri: `.jd-header-comp-name a` / `[class*="comp-name"]`.
  - Instahyre: `.company-name`; Wellfound: `a[href^="/company/"]` text.
  - Otherwise existing logic.
- Popup card "Find HR": button; shows spinner text "Finding people (instant if cached, ~1 min otherwise)"; renders up to 5 people with the same chip rules as the dashboard (no badges beyond status text), each chip a link; "Open all in dashboard" link.

- [ ] **Step 1: Implement** the `pageInfo` additions and the popup card.
- [ ] **Step 2: Verify manually** — reload the unpacked extension; on a LinkedIn job page and a Greenhouse job page the popup's company field is right and Find HR lists people with working links. Screenshot both.
- [ ] **Step 3: Update `README.md`** — "Find HR" feature bullet, the free sources, optional keys (`hunter_api_key`, `github_token`), Jobs tab and auto mode, and the never-sends rule.
- [ ] **Step 4: Personal-data scan before commit** — run the owner's private-string scan on `git diff --cached` → no output.
- [ ] **Step 5: Commit** — `feat(extension): Find HR in the popup` (no push without the owner's OK).
