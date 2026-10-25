// The whole extension UI: a side panel that stays open while you fill, follows the active tab,
// and rescans when the page changes. Apply (form fields + answers), Job (score, DMs), People (Find HR).
import { runFill, aiFill, readPage, guidePage, showField, attachTo, api, serverUp, loadProfile } from "./lib.js";

const $ = (id) => document.getElementById(id);
let P = globalThis.APPLY_PROFILE || { answers: {} };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const bullets = (arr) => arr.map((x) => "• " + x).join("\n");
let tab, info = {}, fields = [], done = new Set(), up = false, scanId = 0, showDone = false;

// ---------- tabs, currency, server ----------
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
function openTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["apply", "job", "people"]) $("tab-" + t).hidden = t !== name;
}

async function setCurrency(cur, rescan) {
  await chrome.storage.local.set({ currency: cur });
  $("inr").classList.toggle("on", cur === "INR");
  $("usd").classList.toggle("on", cur === "USD");
  if (rescan) scan();
}
$("inr").onclick = () => setCurrency("INR", true);
$("usd").onclick = () => setCurrency("USD", true);

async function checkServer() {
  up = await serverUp();
  $("srv").classList.toggle("on", up);
  $("srvtext").textContent = up ? "Claude" : "Claude off";
  $("srvhelp").hidden = up;
  for (const id of ["aifill", "claude", "aiscorebtn", "dmbtn", "findhr"]) $(id).disabled = !up;
}

// ---------- reading the page ----------
// Answers you edited or Claude wrote survive a rescan, keyed by page + question (field ids change on reload).
const key = () => "guide:" + (tab?.url || "").split("?")[0];
async function saved() { return (await chrome.storage.local.get(key()))[key()] || {}; }
async function save(q, text) { const s = await saved(); s[q] = text; await chrome.storage.local.set({ [key()]: s }); }

async function scan() {
  const id = ++scanId;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("dmout").hidden = true; $("aiscore").textContent = ""; $("fillmsg").textContent = ""; $("hr").innerHTML = "";
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return blank("Open a job or application page.");
  try {
    const [page, list] = await Promise.all([readPage(tab.id), guidePage(tab.id)]);
    if (id !== scanId) return; // a newer scan started (tab switched)
    info = page;
    fields = list;
  } catch (e) { if (id === scanId) blank("Can't read this page."); return; }
  const s = await saved();
  for (const f of fields) if (s[f.question] != null) { f.answer = s[f.question]; f.source ||= "edited"; }
  done = new Set(fields.filter((f) => f.current).map((f) => f.id));
  $("co").textContent = info.company || "–";
  $("ro").textContent = info.role || "";
  $("company").value = info.company || "";
  $("role").value = info.role || "";
  renderScore(info.score);
  const ashby = /ashbyhq\.com/.test(tab.url);
  $("ashby").hidden = !(ashby && fields.length);
  $("autofill").hidden = ashby || !fields.length;
  $("formtools").hidden = !fields.length;
  render();
  // A job description with no form: Job tab is the useful one.
  if (!fields.length && info.score?.chars >= 400 && !$("tab-apply").hidden) openTab("job");
}

function blank(msg) {
  info = {}; fields = []; done = new Set();
  $("co").textContent = "–"; $("ro").textContent = msg; $("fitbox").hidden = true;
  $("ashby").hidden = $("autofill").hidden = $("formtools").hidden = true;
  render();
}

// ---------- Apply tab: the field list ----------
function chip(f) {
  const c = [];
  if (f.sensitive) c.push('<span class="badge bad">answer yourself</span>');
  else if (f.source === "claude") c.push('<span class="badge ai">Claude</span>');
  else if (f.source === "edited") c.push('<span class="badge ok">your edit</span>');
  else if (f.kind !== "file") c.push('<span class="badge">no answer</span>');
  if (f.check) c.push('<span class="badge warn">double-check</span>');
  if (f.maxLength) c.push(`<span class="badge">max ${f.maxLength}</span>`);
  return c.join("");
}

function row(f) {
  const isDone = done.has(f.id);
  const opts = f.options ? `<div class="opts">Pick ${f.answer ? `<b>${esc(f.answer)}</b> from` : "one of"}: ${f.options.map(esc).join(" · ")}</div>` : "";
  let body;
  if (isDone) body = f.current ? `<div class="muted xs">On the form: ${esc(f.current.slice(0, 120))}</div>` : "";
  else if (f.kind === "file") body = `<div class="acts"><button class="btn sm brand grow" data-act="attach">Attach resume</button><button class="btn sm" data-act="done">Done</button></div><div class="muted xs" style="margin-top:4px">If it doesn't show on the form, drag your resume PDF onto the field.</div>`;
  else body = `<textarea class="input" data-act="edit" placeholder="${f.sensitive ? "Answer this yourself" : "Type an answer, or ask Claude"}">${esc(f.answer)}</textarea>
    <div class="acts"><button class="btn sm brand grow" data-act="copy" ${f.answer ? "" : "disabled"}>${f.options ? "Copy choice" : "Copy"}</button><button class="btn sm" data-act="done">Done</button></div>`;
  return `<div class="f${isDone ? " done" : ""}" id="r-${f.id}" data-id="${f.id}">
    <div class="q" data-act="show" title="Show on the page">${esc(f.question)}${f.required ? ' <span class="req">*</span>' : ""}</div>
    ${isDone ? "" : (chip(f) ? `<div class="meta">${chip(f)}</div>` : '<div style="height:6px"></div>') + opts}${body}${isDone ? '<div class="acts"><button class="btn sm ghost" data-act="undo">Undo</button></div>' : ""}</div>`;
}

function render() {
  const todo = fields.filter((f) => !done.has(f.id));
  const finished = fields.filter((f) => done.has(f.id));
  $("list").innerHTML = !fields.length
    ? '<div class="empty">No form on this page.<br>Open the application form and its questions show up here with your answers.</div>'
    : todo.length ? todo.map(row).join("") : '<div class="empty">Every field is done. Check the form once, then submit it yourself.</div>';
  $("donefold").hidden = !finished.length;
  $("donefold").textContent = `${showDone ? "▾" : "▸"} ${finished.length} done`;
  $("donelist").hidden = !showDone || !finished.length;
  $("donelist").innerHTML = showDone ? finished.map(row).join("") : "";
  $("t-apply").textContent = fields.length ? `${finished.length}/${fields.length}` : "";
  $("count").textContent = `${finished.length} of ${fields.length} done`;
  $("prog").style.width = fields.length ? (100 * finished.length) / fields.length + "%" : "0%";
  const blanks = todo.filter((f) => !f.answer && !f.sensitive && f.kind !== "file" && f.kind !== "checkbox").length;
  $("claude").innerHTML = `<svg class="i"><use href="#i-spark"/></svg>${blanks ? `Claude: answer ${blanks} blank${blanks > 1 ? "s" : ""}` : "No blanks left"}`;
  $("claude").disabled = !up || !blanks;
}
$("donefold").onclick = () => { showDone = !showDone; render(); };

const setDone = (id, on) => { on ? done.add(id) : done.delete(id); render(); };

for (const box of [$("list"), $("donelist")]) {
  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.tagName === "TEXTAREA") return;
    const f = fields.find((x) => x.id === btn.closest(".f").dataset.id);
    const act = btn.dataset.act;
    if (act === "show") return showField(tab.id, f.id);
    if (act === "done") return setDone(f.id, true);
    if (act === "undo") return setDone(f.id, false);
    if (act === "attach") {
      const ok = await attachTo(tab.id, f.id).catch(() => false);
      btn.textContent = ok ? "Attached: check the form" : "Couldn't attach: drag it in";
      if (ok) setTimeout(() => setDone(f.id, true), 1500);
      return;
    }
    if (act === "copy" && f.answer) {
      await navigator.clipboard.writeText(f.answer);
      await showField(tab.id, f.id);
      btn.textContent = "Copied: paste into the blue field";
      setTimeout(() => setDone(f.id, true), 1200);
    }
  });
  box.addEventListener("input", (e) => {
    if (e.target.dataset.act !== "edit") return;
    const card = e.target.closest(".f");
    const f = fields.find((x) => x.id === card.dataset.id);
    f.answer = e.target.value;
    if (f.source !== "claude") f.source = "edited";
    card.querySelector('[data-act="copy"]').disabled = !f.answer;
    save(f.question, f.answer);
  });
}

$("claude").onclick = async () => {
  const blanks = fields.filter((f) => !done.has(f.id) && !f.answer && !f.sensitive && f.kind !== "file" && f.kind !== "checkbox");
  if (!blanks.length) return;
  $("claude").disabled = true;
  $("claude").textContent = `Claude is writing ${blanks.length} answer${blanks.length > 1 ? "s" : ""}…`;
  try {
    const questions = blanks.map((f) => ({ id: f.id, kind: f.options ? "pick one" : f.kind, maxLength: f.maxLength, question: f.question + (f.options ? ` (options: ${f.options.join(" / ")})` : "") }));
    const { answers } = await api("/api/answer", { company: info.company, role: info.role, url: info.url, jd: info.jd, questions });
    let n = 0;
    for (const a of answers || []) {
      const f = fields.find((x) => x.id === a.id);
      if (!f || !a.answer) continue;
      f.answer = f.options ? f.options.find((o) => o.toLowerCase() === a.answer.toLowerCase()) || a.answer : a.answer;
      f.source = "claude";
      save(f.question, f.answer);
      n++;
    }
    $("fillmsg").textContent = `Claude answered ${n} of ${blanks.length}. Read each one before you paste it.`;
  } catch (e) { $("fillmsg").textContent = "Claude failed: " + e.message; }
  render();
};

$("next").onclick = () => {
  const f = fields.find((x) => !done.has(x.id));
  if (f) { showField(tab.id, f.id); focusRow(f.id); }
};

function focusRow(id) {
  document.querySelectorAll(".f.on").forEach((n) => n.classList.remove("on"));
  const r = $("r-" + id);
  if (r) { r.classList.add("on"); r.scrollIntoView({ block: "start", behavior: "smooth" }); }
}

// Auto-fill for forms that accept it (Greenhouse, Lever, most others).
$("fill").onclick = async () => {
  $("fillmsg").textContent = "Filling…";
  try {
    const r = await runFill(tab.id);
    $("fillmsg").textContent = `Filled ${r.filled.length} field(s).` + (r.check.length ? ` ${r.check.length} need a look (amber on the page).` : "") + " Nothing was submitted.";
  } catch (e) { $("fillmsg").textContent = "Couldn't fill this page: " + e.message; }
  rescanFields();
};
$("aifill").onclick = async () => {
  $("fillmsg").textContent = "Filling, then Claude answers the rest (10–30s)…";
  try {
    const r = await aiFill(tab.id);
    const lines = [`Filled ${r.filled.length} from your profile. Claude answered ${r.ai} of ${r.asked} (purple on the page).`];
    if (r.blank?.length) lines.push("Left for you:", bullets(r.blank.slice(0, 6)));
    lines.push("Read every answer, then submit yourself.");
    $("fillmsg").textContent = lines.join("\n");
  } catch (e) { $("fillmsg").textContent = "Claude fill failed: " + e.message; }
  rescanFields();
};
async function rescanFields() {
  const prev = new Map(fields.map((f) => [f.question, f]));
  fields = await guidePage(tab.id).catch(() => fields);
  for (const f of fields) { const p = prev.get(f.question); if (p && p.source === "claude") { f.answer = p.answer; f.source = "claude"; } }
  done = new Set(fields.filter((f) => f.current).map((f) => f.id));
  render();
}

// ---------- log ----------
async function getLog() { return (await chrome.storage.local.get("log")).log || []; }
async function refreshLog() {
  const log = await getLog();
  const last = log[log.length - 1];
  $("logcount").textContent = last ? `${log.length} logged · last: ${last.company}` : "";
}
$("log").onclick = async () => {
  const log = await getLog();
  const row = {
    date: new Date().toISOString().slice(0, 10),
    company: $("company").value.trim() || info.company || "",
    role: $("role").value.trim() || info.role || "",
    url: info.url || tab?.url || "",
    score: info.score && info.score.chars >= 400 ? info.score.total : "",
  };
  log.push(row);
  await chrome.storage.local.set({ log });
  try { await api("/api/applications", row); } catch {}
  $("log").querySelector("span").textContent = `Logged ${row.company || "this job"}`;
  setTimeout(() => ($("log").querySelector("span").textContent = "I submitted it: mark applied"), 2500);
  refreshLog();
};
$("copylog").onclick = async () => {
  const rows = (await getLog()).map((l) => `| ${l.date} | ${l.company} | ${l.role} | ${l.url} | ${l.score} | Applied | No | Follow up in 5 days |`).join("\n");
  await navigator.clipboard.writeText(rows || "(empty)");
  $("copylog").textContent = "Copied";
  setTimeout(() => ($("copylog").textContent = "Copy tracker rows"), 1000);
};
$("clear").onclick = async () => {
  if (!$("clear").dataset.armed) { $("clear").dataset.armed = "1"; $("clear").textContent = "Sure?"; return; }
  await chrome.storage.local.set({ log: [] });
  delete $("clear").dataset.armed;
  $("clear").textContent = "Clear";
  refreshLog();
};

// ---------- Job tab ----------
const color = (n) => (n >= 75 ? "var(--success-ink)" : n >= 60 ? "var(--warn-ink)" : "var(--danger)");
function renderBars(p) {
  const rows = [["Stack", p.stack, 35], ["Experience", p.exp, 20], ["Location", p.loc, 15], ["Domain", p.domain, 15], ["Freshness", p.fresh, 15]];
  $("bars").innerHTML = rows.map(([n, v, m]) => `<div class="bar"><span>${n}</span><div class="progress"><b style="width:${Math.min(100, (v / m) * 100)}%"></b></div><span class="muted">${v}/${m}</span></div>`).join("");
}
function renderScore(s) {
  if (!s || s.chars < 400) {
    $("fitbox").hidden = true; $("bars").innerHTML = ""; $("tags").innerHTML = "";
    $("scorenote").textContent = "Not enough job text here. Open the job description to score it.";
    return;
  }
  $("fitbox").hidden = false;
  $("fit").textContent = s.total;
  $("fit").style.color = color(s.total);
  renderBars(s.parts);
  $("tags").innerHTML = s.hits.map((h) => `<span class="badge ok">${h}</span>`).join("") + s.gaps.map((g) => `<span class="badge bad">${g}</span>`).join("");
  $("scorenote").textContent = s.total >= 75 ? "Strong fit. Apply and message someone." : s.total >= 60 ? "Decent. Apply if the posting is fresh." : "Long shot. Only if you really want it.";
}
const job = () => ({ company: $("company").value.trim() || info.company, role: $("role").value.trim() || info.role, url: info.url || tab?.url, jd: info.jd || "" });

$("aiscorebtn").onclick = async () => {
  $("aiscore").textContent = "Claude is reading the job (about 10s)…";
  try {
    const s = await api("/api/score", job());
    $("fitbox").hidden = false; $("fit").textContent = s.score; $("fit").style.color = color(s.score);
    if (s.parts) renderBars(s.parts);
    const lines = [(s.verdict || "").toUpperCase(), bullets(s.reasons || [])];
    if (s.gaps?.length) lines.push("Gaps: " + s.gaps.join(", "));
    if (s.lead_with) lines.push("Lead with: " + s.lead_with);
    $("aiscore").textContent = lines.join("\n");
  } catch (e) { $("aiscore").textContent = "Failed: " + e.message; }
};
$("dmbtn").onclick = async () => {
  $("aiscore").textContent = "Claude is writing (about 10s)…";
  try {
    const d = await api("/api/dm", job());
    $("dmout").hidden = false;
    $("dmout").value = [`TO: ${d.to}`, "", "DM:", d.dm, "", "EMAIL", `Subject: ${d.subject}`, "", d.email].join("\n");
    $("aiscore").textContent = "Edit and copy from the box below. Nothing is sent.";
  } catch (e) { $("aiscore").textContent = "Failed: " + e.message; }
};

function renderAnswers() {
  $("answers").innerHTML = Object.keys(P.answers || {}).length ? "" : '<div class="muted xs">Add saved answers on the dashboard Setup page.</div>';
  for (const [label, text] of Object.entries(P.answers || {})) {
    const r = document.createElement("div");
    r.className = "ans";
    r.title = text;
    r.innerHTML = `<span>${esc(label)}</span><button class="btn sm">Copy</button>`;
    r.querySelector("button").onclick = async (e) => {
      await navigator.clipboard.writeText(text);
      e.target.textContent = "Copied";
      setTimeout(() => (e.target.textContent = "Copy"), 900);
    };
    $("answers").appendChild(r);
  }
}

// ---------- People tab ----------
// One contact as a link: phone → call + WhatsApp, email → Gmail compose, profiles → open. Never sends.
function hrLink(c) {
  const st = c.status ? ` <i>${esc(c.status)}</i>` : "";
  const a = (href, label) => `<a href="${esc(href)}" target="_blank" title="Source: ${esc(c.source)}">${label}${st}</a>`;
  if (c.kind === "phone") return a(`tel:${c.value}`, esc(c.value)) + a(`https://wa.me/${c.value.replace(/\D/g, "")}`, "WhatsApp");
  if (c.kind === "email" || c.kind === "inbox") return a(`https://mail.google.com/mail/?authuser=${encodeURIComponent(P.email || "")}&view=cm&fs=1&to=${encodeURIComponent(c.value)}`, esc(c.value));
  return a(c.value, c.kind === "linkedin" ? "LinkedIn" : "X");
}
function renderHr(r) {
  const people = (r.people || []).slice(0, 8).map((p) => `
    <div class="hrp"><b>${esc(p.name)}</b> <span class="t">· ${esc(p.title || p.type)}</span>
      <div class="hrc">${(p.contacts || []).map(hrLink).join("") || '<span class="t">no contact found</span>'}</div></div>`).join("");
  const inbox = (r.inboxes || []).length ? `<div class="hrp"><b>Company</b><div class="hrc">${r.inboxes.map(hrLink).join("")}</div></div>` : "";
  return (people || '<div class="t">No named people found.</div>') + inbox +
    `<div class="xs" style="margin-top:8px"><a href="http://localhost:4777" target="_blank">Open in dashboard</a> · <a href="${esc(r.apolloSearch || "#")}" target="_blank">Find on Apollo</a></div>`;
}
$("findhr").onclick = async () => {
  $("hr").textContent = "Finding people (instant if cached, about a minute otherwise)…";
  $("findhr").disabled = true;
  try { $("hr").innerHTML = renderHr(await api("/api/people", { ...job(), domain: info.domain || "" })); }
  catch (e) { $("hr").textContent = "Failed: " + e.message; }
  $("findhr").disabled = !up;
};

// ---------- follow the browser ----------
// The page tells us which field you clicked into.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "ak-focus" && sender.tab?.id === tab?.id) focusRow(msg.id);
});
let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(scan, 400); };
chrome.tabs.onActivated.addListener(soon);
chrome.tabs.onUpdated.addListener((id, ch) => { if (id === tab?.id && ch.status === "complete") soon(); });
$("rescan").onclick = () => { checkServer(); scan(); };

(async () => {
  const { currency = "INR" } = await chrome.storage.local.get("currency");
  await setCurrency(currency);
  await checkServer();
  P = await loadProfile();
  renderAnswers();
  refreshLog();
  scan();
  setInterval(checkServer, 30000);
})();
