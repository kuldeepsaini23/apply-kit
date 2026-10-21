// Shared by the popup, the keyboard shortcuts and the dashboard bridge.
export const SERVER = "http://localhost:4777";

export async function api(path, body) {
  const res = await fetch(SERVER + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out;
}

export async function serverUp() {
  try { return (await api("/api/health")).ok; } catch { return false; }
}

async function resumeB64() {
  const buf = new Uint8Array(await (await fetch(chrome.runtime.getURL("resume.pdf"))).arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["profile.js", "fill.js"] });
}

async function inFrames(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
}

export async function runFill(tabId) {
  const { currency = "INR" } = await chrome.storage.local.get("currency");
  let b64 = null;
  try { b64 = await resumeB64(); } catch {}
  await inject(tabId);
  const res = await inFrames(tabId, (b64, cur) => globalThis.__applyKit.fill({ resumeB64: b64, currency: cur }), [b64, currency]);
  const out = { filled: [], check: [] };
  for (const r of res) if (r.result) { out.filled.push(...r.result.filled); out.check.push(...r.result.check); }
  return out;
}

export async function readPage(tabId) {
  await inject(tabId);
  const res = await inFrames(tabId, () => globalThis.__applyKit.pageInfo());
  const top = res.find((r) => r.frameId === 0)?.result || res[0]?.result || {};
  const jd = res.map((r) => r.result?.text || "").join("\n").slice(0, 30000);
  const [{ result: score }] = await chrome.scripting.executeScript({ target: { tabId }, func: (t) => globalThis.__applyKit.score(t), args: [jd] });
  return { company: top.company, role: top.role, url: top.url, domain: top.domain || "", jd, score };
}

// Fill from profile, then send the questions still empty to Claude and fill its answers.
export async function aiFill(tabId) {
  const basic = await runFill(tabId);
  const page = await readPage(tabId);
  const open = (await inFrames(tabId, () => globalThis.__applyKit.collectOpen())).flatMap((r) => r.result || []);
  if (!open.length) return { ...basic, ai: 0, asked: 0 };
  const { answers } = await api("/api/answer", { company: page.company, role: page.role, url: page.url, jd: page.jd, questions: open });
  const done = await inFrames(tabId, (a) => globalThis.__applyKit.applyAnswers(a), [answers]);
  const ai = done.reduce((n, r) => n + (r.result || 0), 0);
  const blank = answers.filter((a) => !a.answer).map((a) => open.find((q) => q.id === a.id)?.question).filter(Boolean);
  return { ...basic, ai, asked: open.length, blank };
}

export function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); setTimeout(resolve, 2500); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}
