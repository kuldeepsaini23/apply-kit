// Pure helpers: pull emails and phone numbers out of text, learn a company's email pattern.

const NOISE = /(^|\.)(example\.(com|org)|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com|domain\.com|email\.com|users\.noreply\.github\.com)$/;
const ROLE = /^(careers?|jobs?|hr|talent|recruit(ing|ment|er|ers)?|hiring|people|hello|contact|info|team|support|admin|hey|office)$/;

export function extractEmails(text: string, domain?: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase().replace(/\.+$/, "");
    const host = e.split("@")[1];
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(host) || NOISE.test(host)) continue;
    if (domain && host !== domain && !host.endsWith("." + domain)) continue;
    out.add(e);
  }
  return [...out];
}

export const isRoleInbox = (email: string) => ROLE.test(email.split("@")[0].toLowerCase());

export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  // Digits possibly split by single spaces or dashes; must not touch other digits.
  for (const m of text.matchAll(/(?<![\d\w])(\+?\d[\d -]{7,16}\d)(?![\d\w])/g)) {
    const raw = m[1];
    if (/-\d{1,2}-/.test(raw) || /\d{2}-\d{2}-\d{4}/.test(raw)) continue; // dates
    const d = raw.replace(/\D/g, "");
    if (raw.startsWith("+")) {
      if (d.startsWith("91")) { if (/^91[6-9]\d{9}$/.test(d)) out.add("+" + d); }
      else if (d.length >= 9 && d.length <= 14) out.add("+" + d);
      continue;
    }
    const local = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
    if (/^[6-9]\d{9}$/.test(local)) out.add("+91" + local);
  }
  return [...out];
}

export const normName = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

export type Pattern = "first.last" | "firstlast" | "first" | "flast" | "f.last" | "first_last" | "last.first" | "firstl" | "last";
const PATTERNS: Pattern[] = ["first.last", "firstlast", "flast", "f.last", "first_last", "last.first", "firstl", "first", "last"];

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "sir", "phd", "md", "jr", "sr", "ii", "iii"]);

function local(pattern: Pattern, name: string): string {
  const parts = normName(name).split(" ").filter((p) => p && !TITLES.has(p));
  if (!parts.length) return "";
  const f = parts[0], l = parts.length > 1 ? parts[parts.length - 1] : "";
  if (pattern === "first") return f;
  if (!l) return "";
  switch (pattern) {
    case "first.last": return `${f}.${l}`;
    case "firstlast": return f + l;
    case "flast": return f[0] + l;
    case "f.last": return `${f[0]}.${l}`;
    case "first_last": return `${f}_${l}`;
    case "last.first": return `${l}.${f}`;
    case "firstl": return f + l[0];
    case "last": return l;
  }
}

export function applyPattern(pattern: Pattern, name: string, domain: string): string {
  const l = local(pattern, name);
  return l ? `${l}@${domain}` : "";
}

export function inferPattern(pairs: { name: string; email: string }[], domain: string): { pattern: Pattern; matches: number } | null {
  const counts = new Map<Pattern, number>();
  for (const { name, email } of pairs) {
    const e = email.toLowerCase();
    if (!e.endsWith("@" + domain) || isRoleInbox(e)) continue;
    const lp = e.split("@")[0];
    // First matching pattern wins, so "first" only counts when nothing more specific fits.
    const hit = PATTERNS.find((p) => local(p, name) === lp);
    if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
  }
  let best: { pattern: Pattern; matches: number } | null = null;
  for (const [pattern, matches] of counts) if (!best || matches > best.matches) best = { pattern, matches };
  return best;
}
