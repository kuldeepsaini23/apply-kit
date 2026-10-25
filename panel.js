import { guidePage, showField, attachTo, readPage, api } from "./lib.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let tab, fields = [], done = new Set(), url = "";

// Answers you edited or Claude wrote survive a rescan, keyed by page + question (field ids change on reload).
const key = () => "guide:" + url.split("?")[0];
async function saved() { return (await chrome.storage.local.get(key()))[key()] || {}; }
async function save(q, text) { const s = await saved(); s[q] = text; await chrome.storage.local.set({ [key()]: s }); }

async function scan() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) { $("list").innerHTML = '<div class="empty">Open an application form, then press Rescan.</div>'; return; }
  url = tab.url;
  $("list").innerHTML = '<div class="empty">Reading the form…</div>';
  try { fields = await guidePage(tab.id); }
  catch (e) { $("list").innerHTML = `<div class="empty">Can't read this page: ${esc(e.message)}</div>`; return; }
  const s = await saved();
  for (const f of fields) if (s[f.question] != null) { f.answer = s[f.question]; f.source ||= "edited"; }
  done = new Set(fields.filter((f) => f.current).map((f) => f.id));
  render();
}

function chip(f) {
  const c = [];
  if (f.sensitive) c.push('<span class="badge bad">you answer</span>');
  else if (f.source === "claude") c.push('<span class="badge" style="color:#a855f7">Claude</span>');
  else if (f.source) c.push(`<span class="badge ok">${f.source === "edited" ? "saved" : "profile"}</span>`);
  else c.push('<span class="badge">blank</span>');
  if (f.check) c.push('<span class="badge warn">check</span>');
  if (f.current) c.push(`<span class="badge">on form: ${esc(f.current.slice(0, 40))}</span>`);
  if (f.maxLength) c.push(`<span class="badge">max ${f.maxLength}</span>`);
  return c.join("");
}

function row(f) {
  const opts = f.options ? `<div class="opts">Options: ${f.options.map((o) => (o === f.answer ? `<b>${esc(o)}</b>` : esc(o))).join(" · ")}</div>` : "";
  const body = f.kind === "file"
    ? `<div class="acts"><button class="btn sm brand" data-act="attach">Attach resume</button><button class="btn sm" data-act="show">Show</button></div><div class="muted xs" style="margin-top:4px">If the form ignores it, drag your resume PDF onto the field.</div>`
    : `<textarea class="input" data-act="edit" placeholder="${f.sensitive ? "Answer this yourself" : "No answer yet"}">${esc(f.answer)}</textarea>
       <div class="acts"><button class="btn sm brand grow" data-act="copy">Copy${f.options ? " choice" : ""}</button><button class="btn sm" data-act="show">Show</button><button class="btn sm ghost" data-act="done">${done.has(f.id) ? "Undo" : "Done"}</button></div>`;
  return `<div class="f${done.has(f.id) ? " done" : ""}" id="r-${f.id}" data-id="${f.id}" ${$("hideDone").checked && done.has(f.id) ? "hidden" : ""}>
    <div class="q">${esc(f.question)}${f.required ? ' <span class="req">*</span>' : ""}</div>
    <div class="meta">${chip(f)}</div>${opts}${body}</div>`;
}

function render() {
  if (!fields.length) { $("list").innerHTML = '<div class="empty">No form fields found on this page.</div>'; return; }
  $("list").innerHTML = fields.map(row).join("");
  const n = fields.filter((f) => done.has(f.id)).length;
  $("count").textContent = `${n} of ${fields.length} done · ${fields.filter((f) => !f.answer && !f.sensitive && f.kind !== "file").length} blank`;
  $("prog").style.width = (100 * n) / fields.length + "%";
}

function mark(id, on = true) {
  on ? done.add(id) : done.delete(id);
  render();
}

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.tagName === "TEXTAREA") return;
  const f = fields.find((x) => x.id === btn.closest(".f").dataset.id);
  const act = btn.dataset.act;
  if (act === "show") return showField(tab.id, f.id);
  if (act === "done") return mark(f.id, !done.has(f.id));
  if (act === "attach") {
    const ok = await attachTo(tab.id, f.id).catch(() => false);
    btn.textContent = ok ? "Attached, check it shows" : "Couldn't attach";
    if (ok) setTimeout(() => mark(f.id), 1200);
    return;
  }
  if (act === "copy") {
    if (!f.answer) return;
    await navigator.clipboard.writeText(f.answer);
    await showField(tab.id, f.id);
    btn.textContent = "Copied, now paste";
    setTimeout(() => mark(f.id), 900);
  }
});

$("list").addEventListener("input", (e) => {
  if (e.target.dataset.act !== "edit") return;
  const f = fields.find((x) => x.id === e.target.closest(".f").dataset.id);
  f.answer = e.target.value;
  f.source = f.source === "claude" ? "claude" : "edited";
  save(f.question, f.answer);
});

$("claude").onclick = async () => {
  const blank = fields.filter((f) => !f.answer && !f.sensitive && f.kind !== "file" && f.kind !== "checkbox");
  if (!blank.length) { $("claude").textContent = "No blanks left"; return; }
  $("claude").disabled = true;
  $("claude").textContent = `Claude is answering ${blank.length}…`;
  try {
    const page = await readPage(tab.id);
    const questions = blank.map((f) => ({ id: f.id, kind: f.options ? "pick one" : f.kind, maxLength: f.maxLength, question: f.question + (f.options ? ` (options: ${f.options.join(" / ")})` : "") }));
    const { answers } = await api("/api/answer", { company: page.company, role: page.role, url: page.url, jd: page.jd, questions });
    let n = 0;
    for (const a of answers || []) {
      const f = fields.find((x) => x.id === a.id);
      if (!f || !a.answer) continue;
      f.answer = f.options ? f.options.find((o) => o.toLowerCase() === a.answer.toLowerCase()) || a.answer : a.answer;
      f.source = "claude";
      save(f.question, f.answer);
      n++;
    }
    $("claude").textContent = `Claude answered ${n} of ${blank.length}. Read before pasting.`;
    render();
  } catch (e) {
    $("claude").textContent = /fetch/i.test(e.message) ? "Server is off: start start-server.cmd" : "Claude failed: " + e.message;
  }
  $("claude").disabled = false;
};

$("next").onclick = () => {
  const f = fields.find((x) => !done.has(x.id));
  if (!f) return;
  showField(tab.id, f.id);
  focusRow(f.id);
};

function focusRow(id) {
  document.querySelectorAll(".f.on").forEach((n) => n.classList.remove("on"));
  const r = $("r-" + id);
  if (r) { r.classList.add("on"); r.scrollIntoView({ block: "start", behavior: "smooth" }); }
}

// The page tells us which field you clicked into.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "ak-focus" && sender.tab?.id === tab?.id) focusRow(msg.id);
});

// Rescan when you switch tabs or the page navigates (Ashby's form is a separate step from the job page).
chrome.tabs.onActivated.addListener(scan);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tab?.id && info.status === "complete") scan(); });

$("scan").onclick = scan;
$("hideDone").onchange = render;
scan();
