// Free contact sources: the company's own website, public GitHub commits, plus Hunter's verifier.
// Every source takes an injected fetch so tests never touch the network.
import { resolveMx } from "node:dns/promises";
import { extractEmails, extractPhones } from "./extract";
import type { Ledger } from "./ledger";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const PAGES = ["", "/careers", "/contact", "/contact-us", "/about", "/team", "/jobs"];
const MAX_PAGE = 400_000;

// Web pages are capped so a huge page can't stall a lookup; API JSON is read whole.
async function text(f: Fetch, url: string, init: RequestInit = {}, cap = MAX_PAGE): Promise<string | null> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  return (await r.text()).slice(0, cap);
}

export async function siteContacts(domain: string, f: Fetch) {
  const emails = new Set<string>(), phones = new Set<string>(), pages: string[] = [];
  await Promise.all(PAGES.map(async (p) => {
    const url = `https://${domain}${p}`;
    const body = await text(f, url).catch(() => null);
    if (!body) return;
    const found = extractEmails(body, domain), nums = extractPhones(body.replace(/<[^>]+>/g, " "));
    found.forEach((e) => emails.add(e));
    nums.forEach((n) => phones.add(n));
    if (found.length || nums.length) pages.push(url);
  }));
  return { emails: [...emails], phones: [...phones], pages };
}

const host = (u = "") => u.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].toLowerCase();

export async function githubEmails(company: string, domain: string, f: Fetch, token?: string): Promise<{ name: string; email: string }[]> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "apply-kit" };
  if (token) headers.authorization = `Bearer ${token}`;
  let budget = 12;
  const get = async (url: string) => {
    if (budget-- <= 0) return null;
    const body = await text(f, url, { headers }, Infinity);
    return body ? JSON.parse(body) : null;
  };
  const found = await get(`https://api.github.com/search/users?q=${encodeURIComponent(company)}+type:org&per_page=3`);
  for (const { login } of found?.items ?? []) {
    const org = await get(`https://api.github.com/orgs/${login}`);
    const site = host(org?.blog);
    if (!site || !(site === domain || site.endsWith("." + domain))) continue;
    const repos = (await get(`https://api.github.com/orgs/${login}/repos?sort=pushed&per_page=5`)) ?? [];
    const seen = new Map<string, string>();
    for (const r of repos) {
      const commits = (await get(`https://api.github.com/repos/${login}/${r.name}/commits?per_page=50`)) ?? [];
      for (const c of commits) {
        const a = c?.commit?.author;
        const e = String(a?.email || "").toLowerCase();
        if (a?.name && extractEmails(e, domain).length && !seen.has(e)) seen.set(e, a.name);
      }
    }
    return [...seen].map(([email, name]) => ({ name, email }));
  }
  return [];
}

export async function hasMx(domain: string): Promise<boolean> {
  try { return (await resolveMx(domain)).length > 0; } catch { return false; }
}

export async function hunterVerify(email: string, key: string, f: Fetch, ledger: Ledger): Promise<"verified" | "likely" | "invalid" | null> {
  if (!ledger.canSpend("hunter")) return null;
  ledger.spend("hunter");
  const body = await text(f, `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(key)}`, {}, Infinity).catch(() => null);
  const status = body ? JSON.parse(body)?.data?.status : null;
  return status === "valid" ? "verified" : status === "accept_all" || status === "webmail" ? "likely" : status === "invalid" ? "invalid" : null;
}
