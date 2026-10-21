import { runFill, readPage, aiFill, api, serverUp } from "./lib.js";

const $ = (id) => document.getElementById(id);
const P = globalThis.APPLY_PROFILE;
let tab;
let info = {};

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = old), 900);
}

async function setCurrency(cur) {
  await chrome.storage.local.set({ currency: cur });
  $("inr").classList.toggle("on", cur === "INR");
  $("usd").classList.toggle("on", cur === "USD");
}

async function refreshLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  const last = log[log.length - 1];
  $("logcount").textContent = last ? `${log.length} logged. Last: ${last.company}, ${last.role}` : "Nothing logged yet.";
  return log;
}

function renderBars(p) {
  const rows = [["Stack", p.stack, 35], ["Experience", p.exp, 20], ["Location", p.loc, 15], ["Domain", p.domain, 15], ["Freshness", p.fresh, 15]];
  $("bars").innerHTML = rows.map(([n, v, m]) => `<div class="bar"><span>${n}</span><div class="progress"><b style="width:${Math.min(100, (v / m) * 100)}%"></b></div><span class="muted">${v}/${m}</span></div>`).join("");
}

function renderScore(s) {
  if (!s || s.chars < 400) {
    $("scorenote").textContent = "Not enough job text on this page. Open the job description to score it.";
    return;
  }
  $("score").textContent = s.total;
  $("score").style.color = s.total >= 75 ? "var(--success-ink)" : s.total >= 60 ? "var(--warn-ink)" : "var(--danger)";
  renderBars(s.parts);
  $("tags").innerHTML = s.hits.map((h) => `<span class="badge ok">${h}</span>`).join("") + s.gaps.map((g) => `<span class="badge bad">${g}</span>`).join("");
  $("scorenote").textContent = s.total >= 75 ? "Strong fit. Apply and DM someone." : s.total >= 60 ? "Decent. Apply if the posting is fresh." : "Long shot. Only if you really want it.";
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// One contact as a link: phone → call + WhatsApp, email → Gmail compose, profiles → open. Never sends.
function hrLink(c) {
  const st = c.status ? ` <i>${esc(c.status)}</i>` : "";
  const a = (href, label) => `<a href="${esc(href)}" target="_blank" title="Source: ${esc(c.source)}">${label}${st}</a>`;
  if (c.kind === "phone") return a(`tel:${c.value}`, esc(c.value)) + a(`https://wa.me/${c.value.replace(/\D/g, "")}`, "WhatsApp");
  if (c.kind === "email" || c.kind === "inbox") return a(`https://mail.google.com/mail/?authuser=${encodeURIComponent(P.email || "")}&view=cm&fs=1&to=${encodeURIComponent(c.value)}`, esc(c.value));
  return a(c.value, c.kind === "linkedin" ? "LinkedIn" : "X");
}

function renderHr(r) {
  const people = (r.people || []).slice(0, 5).map((p) => `
    <div class="hrp"><b>${esc(p.name)}</b> <span class="t">· ${esc(p.title || p.type)}</span>
      <div class="hrc">${(p.contacts || []).map(hrLink).join("") || '<span class="t">no contact found</span>'}</div></div>`).join("");
  const inbox = (r.inboxes || []).length ? `<div class="hrp"><b>Company</b><div class="hrc">${r.inboxes.map(hrLink).join("")}</div></div>` : "";
  return (people || '<div class="t">No named people found.</div>') + inbox +
    `<div style="margin-top:6px"><a href="http://localhost:4777" target="_blank">Open all in dashboard</a> · <a href="${esc(r.apolloSearch || "#")}" target="_blank">Find on Apollo</a></div>`;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { currency = "INR" } = await chrome.storage.local.get("currency");
  await setCurrency(currency);
  $("inr").onclick = () => setCurrency("INR");
  $("usd").onclick = () => setCurrency("USD");

  for (const [label, text] of Object.entries(P.answers)) {
    const row = document.createElement("div");
    row.className = "ans";
    const span = document.createElement("span");
    span.textContent = label;
    const btn = document.createElement("button");
    btn.textContent = "Copy";
    btn.className = "btn sm";
    btn.onclick = () => copy(text, btn);
    row.title = text;
    row.append(span, btn);
    $("answers").appendChild(row);
  }

  $("fill").onclick = async () => {
    $("result").textContent = "Filling…";
    try {
      const r = await runFill(tab.id);
      $("result").textContent =
        `Filled ${r.filled.length} field(s).` +
        (r.check.length ? `\nCheck (amber):\n• ${r.check.slice(0, 8).join("\n• ")}` : "\nNothing flagged.") +
        "\nReview, then submit yourself.";
    } catch (e) {
      $("result").textContent = "Couldn't run on this page: " + e.message;
    }
  };

  const up = await serverUp();
  $("srv").classList.toggle("on", up);
  $("srvtext").textContent = up ? "Claude" : "Claude off";
  $("srvbadge").title = up ? "Claude server running" : "Claude server off";
  $("srvhelp").hidden = up;
  for (const id of ["aifill", "aiscorebtn", "dmbtn", "findhr"]) $(id).disabled = !up;

  const bullets = (arr) => arr.map((x) => "• " + x).join("\n");

  $("aifill").onclick = async () => {
    $("result").textContent = "Filling, then asking Claude (10–30s)…";
    try {
      const r = await aiFill(tab.id);
      const lines = [`Filled ${r.filled.length} from profile. Claude answered ${r.ai} of ${r.asked} open question(s) (purple).`];
      if (r.blank?.length) lines.push("Left for you:", bullets(r.blank.slice(0, 6)));
      if (r.check.length) lines.push("Also check (amber):", bullets(r.check.slice(0, 6)));
      lines.push("Read every answer, then submit yourself.");
      $("result").textContent = lines.join("\n");
    } catch (e) {
      $("result").textContent = "Claude fill failed: " + e.message;
    }
  };

  const job = () => ({ company: $("company").value.trim(), role: $("role").value.trim(), url: info.url || tab.url, jd: info.jd || "" });

  $("aiscorebtn").onclick = async () => {
    $("aiscore").textContent = "Claude is reading the job (about 10s)…";
    try {
      const s = await api("/api/score", job());
      $("score").textContent = s.score;
      $("score").style.color = s.score >= 75 ? "var(--success-ink)" : s.score >= 60 ? "var(--warn-ink)" : "var(--danger)";
      if (s.parts) renderBars(s.parts);
      info.score = { total: s.score, chars: 9999 };
      const lines = [(s.verdict || "").toUpperCase(), bullets(s.reasons || [])];
      if (s.gaps?.length) lines.push("Gaps: " + s.gaps.join(", "));
      if (s.lead_with) lines.push("Lead with: " + s.lead_with);
      $("aiscore").textContent = lines.join("\n");
    } catch (e) {
      $("aiscore").textContent = "Failed: " + e.message;
    }
  };

  $("dmbtn").onclick = async () => {
    $("aiscore").textContent = "Claude is writing (about 10s)…";
    try {
      const d = await api("/api/dm", job());
      $("dmout").hidden = false;
      $("dmout").value = [`TO: ${d.to}`, "", "DM:", d.dm, "", "EMAIL", `Subject: ${d.subject}`, "", d.email].join("\n");
      $("aiscore").textContent = "Edit and copy from the box below. Nothing is sent.";
    } catch (e) {
      $("aiscore").textContent = "Failed: " + e.message;
    }
  };

  $("findhr").onclick = async () => {
    $("hr").textContent = "Finding people (instant if cached, about a minute otherwise)…";
    $("findhr").disabled = true;
    try {
      const r = await api("/api/people", { ...job(), domain: info.domain || "" });
      $("hr").innerHTML = renderHr(r);
    } catch (e) {
      $("hr").textContent = "Failed: " + e.message;
    }
    $("findhr").disabled = false;
  };

  $("log").onclick = async () => {
    const log = await refreshLog();
    log.push({
      date: new Date().toISOString().slice(0, 10),
      company: $("company").value.trim(),
      role: $("role").value.trim(),
      url: info.url || tab.url,
      score: info.score && info.score.chars >= 400 ? info.score.total : "",
    });
    await chrome.storage.local.set({ log });
    try { await api("/api/applications", log[log.length - 1]); } catch {}
    await refreshLog();
    $("log").lastChild.textContent = "Logged";
  };

  $("copylog").onclick = async (e) => {
    const log = await refreshLog();
    const rows = log.map((l) => `| ${l.date} | ${l.company} | ${l.role} | ${l.url} | ${l.score} | Applied | No | Follow up in 5 days |`).join("\n");
    copy(rows || "(empty)", e.target);
  };

  $("clear").onclick = async () => {
    if (!$("clear").dataset.armed) {
      $("clear").dataset.armed = "1";
      $("clear").textContent = "Sure?";
      return;
    }
    await chrome.storage.local.set({ log: [] });
    $("clear").textContent = "✕";
    delete $("clear").dataset.armed;
    refreshLog();
  };

  await refreshLog();

  try {
    info = await readPage(tab.id);
    $("company").value = info.company || "";
    $("role").value = info.role || "";
    renderScore(info.score);
  } catch (e) {
    $("scorenote").textContent = "Can't read this page (" + e.message + ").";
  }
}

init();
