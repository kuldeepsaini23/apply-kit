// Apply Kit local server: the extension and the dashboard call this; it calls Claude Code (`claude -p`)
// on your subscription. Binds to 127.0.0.1 only and rejects requests from other websites.
// Run: bun E:\Work\job-hunt\extension\server\server.ts   (or start.cmd)
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Index, asContext } from "./rag";
import { findContacts, slug, type FindInput, type Research } from "./contacts";
import { Ledger } from "./contacts/ledger";

const PORT = 4777;
const DIR = import.meta.dir;
// Your prepared applications (markdown "packs"). Override with APPLYKIT_PACKS.
const PACKS = process.env.APPLYKIT_PACKS || (existsSync(join(DIR, "..", "..", "applications")) ? join(DIR, "..", "..", "applications") : join(DIR, "..", "packs"));
const DATA = join(DIR, "data");
const APPS = join(DATA, "applications.json");
const MODEL = process.env.APPLYKIT_MODEL || "sonnet";
// Your profile + rules for Claude. context.md is private (gitignored); the example is the template.
const CONTEXT = existsSync(join(DIR, "context.md")) ? join(DIR, "context.md") : join(DIR, "context.example.md");
// Dashboard settings (name, email, deadline). config.json is private; see config.example.json.
const CONFIG_FILE = existsSync(join(DIR, "config.json")) ? join(DIR, "config.json") : join(DIR, "config.example.json");

if (!existsSync(DATA)) mkdirSync(DATA);

// ---------- Claude ----------
// web: let Claude use WebSearch/WebFetch (people research). Otherwise no tools at all.
async function claude(prompt: string, { web = false } = {}): Promise<string> {
  const tools = web ? ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch", "WebFetch"] : ["--tools", ""];
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, ...tools, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
     "--system-prompt-file", CONTEXT, "--output-format", "json"],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", cwd: DATA },
  );
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  let parsed: any;
  try { parsed = JSON.parse(out); } catch { throw new Error("claude failed: " + (err || out).slice(0, 300)); }
  if (parsed.is_error) throw new Error("claude error: " + String(parsed.result).slice(0, 300));
  return String(parsed.result ?? "");
}

function json<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const m = (fenced || text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in reply: " + text.slice(0, 200));
  try { return JSON.parse(m[0]); }
  catch (e: any) { throw new Error(`bad JSON (${e.message}): ${text.slice(0, 400)}`); }
}

// ---------- Packs (your prepared applications) ----------
type Pack = { file: string; num: number; company: string; role: string; link: string; apply: string; score: number | null; body: string };

function loadPacks(): Pack[] {
  if (!existsSync(PACKS)) return [];
  return readdirSync(PACKS).filter((f) => /^\d+-.*\.md$/.test(f)).map((file) => {
    const body = readFileSync(join(PACKS, file), "utf8");
    const title = body.match(/^# #?(\d+)\s+([^:\n]+):\s*(.+)$/m);
    const linkRow = body.match(/^\| Link \|(.+)\|$/m)?.[1] || "";
    const urls = linkRow.match(/https?:\/\/[^\s·|)]+/g) || body.match(/https?:\/\/(?!gist|linkedin|github)[^\s)`>|]+/g) || [];
    const applyUrl = linkRow.match(/apply:\s*(https?:\/\/[^\s·|)]+)/)?.[1];
    const score = body.match(/Fit score:\s*(\d+)/)?.[1];
    return {
      file, num: +(title?.[1] || file.split("-")[0]), company: (title?.[2] || file.replace(/^\d+-|\.md$/g, "")).trim(),
      role: (title?.[3] || "").trim(), link: urls[0] || "", apply: applyUrl || urls[0] || "", score: score ? +score : null, body,
    };
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function packFor(url = "", company = ""): Pack | undefined {
  const packs = loadPacks();
  const u = url.split("?")[0];
  return packs.find((p) => u && p.link && (u.startsWith(p.link) || p.link.startsWith(u.replace(/\/application$/, ""))))
    || packs.find((p) => company && p.company.toLowerCase().split(/\s+/)[0] === company.toLowerCase().split(/\s+/)[0]);
}

// ---------- RAG over your own notes ----------
// "docs" in config.json (files or folders of .md). Indexed in the background at startup, cached in data/.
let rag: Index | null = null;
const ragDocs = (): string[] => (existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")).docs ?? [] : []);
const ragReady = (async () => {
  const docs = ragDocs();
  if (!docs.length) return;
  const t = Date.now();
  rag = await Index.build(docs, join(DATA, "rag-index.json"));
  console.log(`RAG: ${rag.chunks.length} chunks indexed in ${Date.now() - t}ms`);
})().catch((e) => console.error("RAG index failed:", e.message));

async function retrieved(query: string, k = 8) {
  await ragReady;
  if (!rag || !query.trim()) return "";
  const hits = await rag.search(query.slice(0, 2000), k, "hybrid");
  return `\n# RELEVANT FACTS FROM MY NOTES (retrieved; background only: use them when they fit, never contradict the HARD RULES, never mention incidents framed as mistakes)\n${asContext(hits)}`;
}

async function jobBlock(b: any, extraQuery = "") {
  const pack = packFor(b.url, b.company);
  const facts = await retrieved([extraQuery, b.role, b.company, String(b.jd || "").slice(0, 1500)].filter(Boolean).join("\n"));
  return [
    `Company: ${b.company || "?"}`, `Role: ${b.role || "?"}`, `URL: ${b.url || "?"}`,
    pack ? `\n# MY PREPARED NOTES FOR THIS COMPANY (use these first)\n${pack.body.slice(0, 6000)}` : "",
    facts,
    `\n# JOB PAGE TEXT\n${String(b.jd || "").slice(0, 14000)}`,
  ].join("\n");
}

// ---------- Applications log ----------
const STATUSES = ["Applied", "Replied", "Interview", "Offer", "Rejected", "Ghosted"];
const today = () => new Date().toISOString().slice(0, 10);
const readApps = (): any[] => {
  const apps: any[] = existsSync(APPS) ? JSON.parse(readFileSync(APPS, "utf8")) : [];
  let changed = false;
  for (const a of apps) {
    if (!a.id) { a.id = crypto.randomUUID().slice(0, 8); changed = true; }
    if (!a.history) { a.history = [{ status: a.status || "Applied", date: a.date }]; changed = true; }
  }
  if (changed) writeFileSync(APPS, JSON.stringify(apps, null, 2));
  return apps;
};
const writeApps = (a: any[]) => writeFileSync(APPS, JSON.stringify(a, null, 2));

// ---------- People, connections, outreach ----------
const PEOPLE = join(DATA, "people");
const CONNS = join(DATA, "connections.json");
const OUTREACH = join(DATA, "outreach.json");
if (!existsSync(PEOPLE)) mkdirSync(PEOPLE);
const readJson = (f: string, d: any) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);

// Company name → comparable key: "Composio, Inc." / "composio.dev" / "Composio (YC W24)" → "composio"
const coKey = (s = "") => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/\.(com|dev|io|ai|co|in|app)\b.*/, "")
  .replace(/\b(inc|llc|ltd|pvt|private|limited|technologies|technology|labs|hq|corp|corporation|the)\b/g, "").replace(/[^a-z0-9]+/g, "").trim();

function connectionsAt(company: string) {
  const key = coKey(company);
  if (key.length < 3) return [];
  return (readJson(CONNS, []) as any[]).filter((c) => {
    const k = coKey(c.company);
    return k && (k === key || (k.length >= 4 && (k.startsWith(key) || key.startsWith(k))));
  });
}

// LinkedIn "Connections.csv" export (Settings → Data privacy → Get a copy of your data → Connections).
function parseConnectionsCsv(csv: string) {
  const lines = csv.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^"?First Name"?,/i.test(l));
  if (start < 0) throw new Error("This doesn't look like LinkedIn's Connections.csv (no 'First Name' header).");
  const row = (l: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = row(lines[start]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const [fi, la, ur, em, co, po, on] = ["first name", "last name", "url", "email address", "company", "position", "connected on"].map(col);
  return lines.slice(start + 1).filter((l) => l.trim()).map(row).map((r) => ({
    name: `${r[fi] || ""} ${r[la] || ""}`.trim(), url: r[ur] || "", email: r[em] || "", company: r[co] || "", position: r[po] || "", connectedOn: r[on] || "",
  })).filter((c) => c.name);
}

// ---------- Finding people ----------
const config = (): any => (existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {});
const ledger = new Ledger(join(DATA, "credits.json"), config().limits ?? { hunter: { month: 50 } });

async function research(b: FindInput): Promise<Research> {
  const pack = packFor(b.url, b.company);
  const prompt = `Research who I should contact about this job. Use web search; check the company site (team/about/careers pages), LinkedIn search results and public LinkedIn/X hiring posts, Crunchbase-style pages, YC company page, GitHub org, blog posts and job posts.
Company: ${b.company}
Role: ${b.role || "?"}
Job URL: ${b.url || "?"}
${pack ? "My notes on this company:\n" + pack.body.slice(0, 2500) : ""}
${b.jd ? "Job text:\n" + String(b.jd).slice(0, 4000) : ""}

Find up to 6 real people, best first: recruiters or talent partners hiring for this team, the hiring manager or engineering lead, founders/CTO (for startups under ~100 people). Also find the company's website domain and its email pattern.
Recruiters often publish a phone/WhatsApp number or an email in public hiring posts ("share your CV at ..."). Include those in phone/email ONLY if a page you opened shows them for that person, and put that page's URL in source.
RULES: only include a person if a source you actually opened names them at this company now. Never guess LinkedIn or X URLs, phones or emails; leave them "" if you didn't see them. Don't include anyone who has left.
Return ONLY JSON: {"domain":"","email_pattern":"first.last|firstlast|flast|f.last|first_last|last.first|firstl|first|last or empty","people":[{"name":"","title":"","type":"founder|hiring_manager|engineer|recruiter","linkedin":"","x":"","email":"","phone":"","why":"one line: why contact them","source":"url"}],"notes":"one line: best way in (e.g. founder reads DMs on X, careers@ inbox, etc.)"}`;
  return json(await claude(prompt, { web: true }));
}

function findPeople(b: any) {
  const c = config();
  return findContacts(
    { company: b.company, role: b.role, url: b.url, jd: b.jd, domain: b.domain, refresh: !!b.refresh },
    { fetch: (u, init) => fetch(u, init), research, legacy: (co) => readJson(join(PEOPLE, slug(co) + ".json"), null), ledger, cacheDir: PEOPLE, hunterKey: c.hunter_api_key || undefined, githubToken: c.github_token || undefined, today },
  );
}

// ---------- Jobs feed + auto mode ----------
// tools/scan-boards.py writes data/jobs.json; auto mode finds people for the newest jobs, a few a day.
const JOBS = join(DATA, "jobs.json");
const AUTO = join(DATA, "auto.json");
const peopleCached = (company: string) => existsSync(join(PEOPLE, slug(company) + ".v2.json"));

function readAuto() {
  const a = { enabled: false, perDay: 10, ...(config().auto ?? {}), doneToday: 0, day: today(), ...readJson(AUTO, {}) };
  if (a.day !== today()) { a.day = today(); a.doneToday = 0; }
  return a;
}

let autoRunning = false;
async function autoStep() {
  const a = readAuto();
  if (!a.enabled || autoRunning || a.doneToday >= a.perDay) return;
  const next = (readJson(JOBS, []) as any[]).filter((j) => !peopleCached(j.company)).sort((x, y) => String(y.posted).localeCompare(String(x.posted)))[0];
  if (!next) return;
  autoRunning = true;
  try {
    await findPeople({ company: next.company, role: next.title, url: next.url });
    console.log(`auto: people found for ${next.company}`);
  } catch (e: any) {
    console.error(`auto: ${next.company}: ${e.message}`);
  } finally {
    autoRunning = false;
    writeFileSync(AUTO, JSON.stringify({ ...readAuto(), doneToday: readAuto().doneToday + 1 }, null, 1));
  }
}
setInterval(autoStep, 10 * 60 * 1000);
setTimeout(autoStep, 30 * 1000);

// ---------- HTTP ----------
function allowed(req: Request) {
  const o = req.headers.get("origin");
  return !o || o.startsWith("chrome-extension://") || o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`;
}
const cors = (req: Request) => ({
  "access-control-allow-origin": req.headers.get("origin") || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
});
const send = (req: Request, body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(req) } });

const routes: Record<string, (b: any) => Promise<any> | any> = {
  "GET /api/health": () => ({ ok: true, model: MODEL }),
  // Keys and tokens never leave the server.
  "GET /api/config": () => Object.fromEntries(Object.entries(config()).filter(([k]) => !/_(key|token)$/.test(k))),
  // Debug/inspect retrieval: {q, k?, mode?: "bm25" | "vector" | "hybrid"}
  "POST /api/rag/search": async (b) => {
    await ragReady;
    if (!rag) return { error: 'no docs configured (config.json "docs")' };
    return (await rag.search(String(b.q || ""), Number(b.k) || 6, b.mode || "hybrid")).map(({ vec, tokens, ...h }) => h);
  },
  "GET /api/packs": () => loadPacks().map(({ body, ...p }) => p),
  "GET /api/applications": () => readApps(),

  "POST /api/applications": (b) => {
    const apps = readApps();
    const i = apps.findIndex((a) => a.url === b.url);
    if (i >= 0 && b.url) apps[i] = { ...apps[i], ...b };
    else apps.push({ id: crypto.randomUUID().slice(0, 8), date: today(), status: "Applied", channel: "Form", ...b, history: [{ status: "Applied", date: today() }] });
    writeApps(apps);
    return { ok: true, count: apps.length };
  },

  // Move an application through the funnel: {id, status?, channel?, note?}
  "POST /api/applications/update": (b) => {
    const apps = readApps();
    const a = apps.find((x) => x.id === b.id);
    if (!a) throw new Error("no such application");
    if (b.status && b.status !== a.status) {
      if (!STATUSES.includes(b.status)) throw new Error("bad status");
      a.status = b.status;
      a.history.push({ status: b.status, date: today() });
    }
    if (b.channel) a.channel = b.channel;
    if (b.note !== undefined) a.note = b.note;
    writeApps(apps);
    return a;
  },

  // Who to contact at a company and how: Claude research + company site + GitHub + optional verifier, cached per company.
  "POST /api/people": async (b) => ({ ...(await findPeople(b)), connections: connectionsAt(b.company) }),

  "GET /api/jobs": () => ({
    jobs: (readJson(JOBS, []) as any[]).map((j) => ({ ...j, people: peopleCached(j.company) ? readJson(join(PEOPLE, slug(j.company) + ".v2.json"), {}).people?.length ?? 0 : null })),
    scannedAt: existsSync(JOBS) ? statSync(JOBS).mtime.toISOString() : null,
  }),
  "POST /api/jobs/scan": async () => {
    const proc = Bun.spawn(["python", "tools/scan-boards.py", JOBS], { cwd: join(DIR, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 5 * 60 * 1000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if ((await proc.exited) !== 0) throw new Error("scan failed: " + (err || out).slice(-300));
    return { count: (readJson(JOBS, []) as any[]).length };
  },
  "GET /api/auto": () => ({ ...readAuto(), running: autoRunning }),
  "POST /api/auto": (b) => {
    const a = readAuto();
    if (typeof b.enabled === "boolean") a.enabled = b.enabled;
    if (Number(b.perDay) > 0) a.perDay = Math.min(50, Math.floor(Number(b.perDay)));
    writeFileSync(AUTO, JSON.stringify(a, null, 1));
    if (a.enabled) setTimeout(autoStep, 1000);
    return { ...a, running: autoRunning };
  },

  "GET /api/connections": () => {
    const all: any[] = readJson(CONNS, []);
    const counts: Record<string, number> = {};
    for (const c of all) if (c.company) counts[c.company] = (counts[c.company] || 0) + 1;
    return { count: all.length, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15) };
  },
  "POST /api/connections/import": (b) => {
    const list = parseConnectionsCsv(String(b.csv || ""));
    writeFileSync(CONNS, JSON.stringify(list, null, 1));
    return { count: list.length };
  },
  "POST /api/connections/match": (b) => Object.fromEntries((b.companies || []).map((c: string) => [c, connectionsAt(c).length])),
  "POST /api/connections/search": (b) => {
    const q = String(b.q || "").toLowerCase();
    return (readJson(CONNS, []) as any[]).filter((c) => `${c.name} ${c.company} ${c.position}`.toLowerCase().includes(q)).slice(0, 50);
  },

  // Draft one message to one person. relation: connection | founder | hiring_manager | engineer | recruiter
  "POST /api/outreach/draft": async (b) => {
    const p = b.person || {};
    const channel = b.channel || "email";
    const isRef = p.relation === "connection";
    const prompt = `${await jobBlock(b)}

# PERSON
Name: ${p.name}. Title: ${p.title || p.position || "?"}. Relation: ${isRef ? `my LinkedIn connection${p.connectedOn ? ` since ${p.connectedOn}` : ""}` : p.relation || "cold"}.
${p.why ? "Why them: " + p.why : ""}

Write ONE ${channel === "email" ? "email (subject + body, under 130 words)" : channel === "whatsapp" ? "WhatsApp message (under 60 words, polite, says who I am, the exact role, and asks if I can share my resume; at most one link)" : channel === "linkedin" ? "LinkedIn message (under 90 words; if we're not connected it must fit a 300-character connection note, so give that version)" : "X DM (under 60 words, casual, lowercase)"}.
${isRef
  ? "Goal: ask for a referral for this role. Be warm and low-pressure, make it easy to say no, offer to send a short blurb + resume they can forward, mention the exact role and link."
  : "Goal: get a reply about this role. Mention one specific thing about their product or work, one proof point of mine that fits this role, and one simple ask (quick chat, or who's the right person)."}
Use their first name. Follow the HUMAN WRITING rules. No emojis, no dashes, no buzzwords, no flattery. Don't say I already applied unless asked.
Return ONLY JSON: {"subject":"${channel === "email" ? "..." : ""}","body":"..."}`;
    return json(await claude(prompt));
  },

  "GET /api/outreach": () => readJson(OUTREACH, []),
  "POST /api/outreach/log": (b) => {
    const list = readJson(OUTREACH, []);
    const row = { id: crypto.randomUUID().slice(0, 8), date: today(), status: "Sent", ...b };
    list.push(row);
    writeFileSync(OUTREACH, JSON.stringify(list, null, 2));
    return row;
  },
  "POST /api/outreach/update": (b) => {
    const list = readJson(OUTREACH, []);
    const r = list.find((x: any) => x.id === b.id);
    if (!r) throw new Error("no such outreach");
    Object.assign(r, { status: b.status ?? r.status, note: b.note ?? r.note, statusDate: today() });
    writeFileSync(OUTREACH, JSON.stringify(list, null, 2));
    return r;
  },

  // Answers for open questions on a form. questions: [{id, question, kind, maxLength}]
  "POST /api/answer": async (b) => {
    const qs = (b.questions || []).slice(0, 25);
    if (!qs.length) return { answers: [] };
    const prompt = `${await jobBlock(b, qs.map((q: any) => q.question).join(" "))}

# QUESTIONS ON THE APPLICATION FORM
${qs.map((q: any) => `- id ${q.id} [${q.kind}${q.maxLength ? `, max ${q.maxLength} chars` : ""}]: ${q.question}`).join("\n")}

Write my answer to each question. Long-text questions: 60 to 150 words unless a limit is given, specific to this company and role, using real numbers from my profile that match what this job cares about. Short text fields: just the value, as short as possible. If a question can't be answered honestly from my profile, or is a yes/no I can't be sure of, use "".
Return ONLY JSON: {"answers":[{"id":"...","answer":"..."}]}`;
    return json(await claude(prompt));
  },

  "POST /api/score": async (b) => {
    const prompt = `${await jobBlock(b)}

Score my interview chance for this job with the rubric. Be honest and specific; mention dealbreakers.
Return ONLY JSON: {"score":0,"parts":{"stack":0,"exp":0,"loc":0,"domain":0,"fresh":0},"reasons":["...","...","..."],"gaps":["..."],"verdict":"apply|apply + DM|skip","lead_with":"the one proof point to lead with"}`;
    return json(await claude(prompt));
  },

  "POST /api/dm": async (b) => {
    const prompt = `${await jobBlock(b)}
${b.person ? `Person to message: ${b.person}` : "Person: the founder, hiring manager or recruiter if the page names one, else write it to the team."}

Write two outreach messages: (1) a LinkedIn/X DM: casual, lowercase, under 70 words; (2) an email under 120 words with a subject line. Mention one specific thing about them or the product, and one proof point of mine that fits. End with a simple ask. Follow the HUMAN WRITING rules. No emojis, no dashes.
Return ONLY JSON: {"to":"who","dm":"...","subject":"...","email":"..."}`;
    return json(await claude(prompt));
  },
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    if (!allowed(req)) return new Response("forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(Bun.file(join(DIR, "dashboard.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (req.method === "GET" && url.pathname === "/ui.css") {
      return new Response(Bun.file(join(DIR, "..", "ui.css")), { headers: { "content-type": "text/css; charset=utf-8" } });
    }
    if (req.method === "GET" && url.pathname === "/api/pack") {
      const p = loadPacks().find((x) => x.file === url.searchParams.get("file"));
      return p ? send(req, { body: p.body }) : send(req, { error: "no such pack" }, 404);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(req, { error: "not found" }, 404);
    try {
      const body = req.method === "POST" ? await req.json() : {};
      const t = Date.now();
      const out = await handler(body);
      if (req.method === "POST") console.log(`${url.pathname} ${Date.now() - t}ms`);
      return send(req, out);
    } catch (e: any) {
      console.error(url.pathname, e.message);
      return send(req, { error: e.message }, 500);
    }
  },
});

console.log(`Apply Kit server on http://localhost:${PORT} (model: ${MODEL}). Dashboard: http://localhost:${PORT}`);
