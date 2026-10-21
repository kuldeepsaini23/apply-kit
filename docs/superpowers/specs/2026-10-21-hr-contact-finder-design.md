# HR contact finder — design

Date: 2026-10-21. Status: approved 2026-10-21 (free sources first; paid keys optional).

## Why

Cold applications through job portals get about a 1–3% reply rate. Reaching a person (HR, recruiter, hiring manager, founder) directly gets far more replies. Apply Kit already finds jobs (board scanner) and does slow, free people research with Claude, but it can't get phone numbers or verified emails, and it only runs when you open a company by hand.

Two stages on one engine:
- **Stage 1 (now, for the owner):** more replies before the job deadline.
- **Stage 2 (later, a product for other job seekers):** the same engine plus accounts, each user's own keys or credits, and limits. Stage 1 code must carry over, so contact sources are pluggable and every lookup is cached.

## What the user sees

**Contact order:** phone, then email, then LinkedIn, then anything else (X, careers inbox). Each person shows their best contact first, with the others below.

**App (dashboard):**
- A new **Jobs** tab lists jobs from the board scanner (company, role, location, fit score, posted date). The server runs the scanner on demand and once a day.
- Each job has **Find HR**. Results open in the same panel as today's People view: people, their contacts, where each contact came from, a ready-to-send message per person.
- **Auto mode** (off by default, a toggle): for new jobs the scanner kept (it already filters by title, seniority and location; it has no numeric score), newest first, find people in the background, up to a daily cap (default 10 companies/day, since each Claude research uses about a minute of the user's Claude plan). Free sources only; paid reveals and verifier calls stay within the limits the user sets.

**Extension:**
- On a job page (LinkedIn Jobs, Naukri, Wellfound, Instahyre, Ashby, Greenhouse, Lever, any careers page), the popup gets **Find HR**. It reads the company, role and job text from the page and shows the same people list inside the popup.
- Buttons per contact: copy, call (`tel:`), WhatsApp (`wa.me`), email (Gmail compose prefilled with the drafted message), open LinkedIn. Every send is done by the user; Apply Kit never sends.
- **Mark sent** logs it in the outreach log (exists), so reply rate per channel is measured.

## Contact sources

Free sources are the default and must work with no keys at all. Paid sources are optional plug-ins. Each source is a module with the same shape: `find(company, domain, roleHints) → people[] / emails[]` and optional `reveal(person, what) → contact`. A keyed source is on only when its key is set in `server/config.json` (gitignored).

**Free (Stage 1 core)**
| Source | Gives |
|---|---|
| Claude web research (exists, extended) | names, titles, LinkedIn/X URLs seen in sources, email pattern, plus phone/WhatsApp numbers and emails that recruiters published in public hiring posts (with the post URL as source) |
| Company website | `mailto:` addresses and phone numbers on contact, careers, about, team pages |
| GitHub | public commit author emails from the company's GitHub org (free API) → real addresses at the domain → pattern |
| Job page | careers@/recruiter emails and numbers printed on the job post |
| Pattern + MX | infer the pattern from real addresses at the domain, apply it to names; MX lookup confirms the domain takes mail |
| Free verifier tiers (keys, free signup) | verify guessed emails using several services' free monthly allowances (e.g. Hunter 50/month), rotating to whichever has allowance left |

The direct mail-server check (SMTP RCPT) is not possible from the owner's network: outbound port 25 is blocked (tested 2026-10-21). Don't build it.

**Paid, optional (later)**
| Source | Gives |
|---|---|
| Apollo (key) | people by title (search is free), emails (~1 credit), mobiles (~5–8 credits, async) |
| Hunter paid | more email finding/verification |

Phone numbers: free only where people published them (hiring posts, company site, job page). Otherwise a **Find on Apollo** link opens Apollo for a manual reveal with the user's own free credits.

## Merging and ranking

- People from all sources are merged by LinkedIn URL, else by normalised name.
- Each contact keeps its source and status: email `verified | likely | guessed`, phone `found`.
- People ranked: recruiter/talent/HR for this location, then hiring manager or engineering lead, then founder/CTO for companies under ~100 people.
- Cached per company in `server/data/people/<company>.json` with a fetch date; a paid reveal is never repeated for the same person.
- A credit ledger (`server/data/credits.json`) counts paid reveals per source per day and month and stops at the user's limits.

## Goals

- From any job (scanner or browser), see the right people and their best contact within about a minute.
- Never spend paid credits beyond the user's limits; never pay twice for the same contact.
- Message drafted per person and channel, using the existing outreach draft (`/api/outreach/draft`), plus a short call or WhatsApp script for phones.

## Non-goals (Stage 1)

- Sending email, WhatsApp or SMS automatically, or sequences/follow-up automation.
- Accounts, billing, multi-user anything (Stage 2).
- New Python scanner features beyond running it from the server.

## Anti-goals

- Scraping LinkedIn or Apollo's web UI, or anything against a provider's terms. Official APIs and public pages only.
- Guessed contacts shown as if they were verified.
- Personal data leaving the user's machine except to the providers they configured; nothing personal committed to the public repo.

## Constraints

- Existing stack: Bun server (`server/server.ts`, 127.0.0.1 only), plain HTML dashboard, MV3 extension, Python scanner.
- Keys only in `config.json`; never logged or returned by any endpoint.
- The repo is public: specs, code and examples must hold no personal data.

## Left to the builder

- Exact Apollo and Hunter endpoints, request shapes and credit costs (check current docs).
- Company-domain detection per job site.
- The UI details inside the existing dashboard and popup styles.
