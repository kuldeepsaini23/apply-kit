// Injected into every frame of the page. Defines globalThis.__applyKit = { fill, score, pageInfo }.
// Never clicks submit. Never overwrites a field that already has a value.
(() => {
  const GREEN = "2px solid #22c55e";
  const AMBER = "2px solid #f59e0b";

  // Questions we never answer for you.
  const SKIP = /gender|pronoun|race|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual|orientation|transgender|demograph|birth|\bage\b|religio|caste|marital|ssn|social security|aadhaar|\bpan\b|passport|password|captcha|signature|middle name|zip|postal|pin ?code|street|address line/i;

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (n) => norm(n && (n.innerText || n.textContent));
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const CONTROLS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select";

  // Text of the nearest ancestor that holds this control (or radio group) and nothing else.
  function ancestorText(el, sameGroup) {
    let node = el.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
      const others = [...node.querySelectorAll(CONTROLS)].filter((c) => !sameGroup(c));
      if (others.length) return "";
      const t = textOf(node);
      if (t && t.length < 250) return t;
    }
    return "";
  }

  function questionFor(el) {
    const parts = [];
    const lb = el.getAttribute("aria-labelledby");
    if (lb) parts.push(lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" "));
    if (el.labels && el.labels.length) parts.push(textOf(el.labels[0]));
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    if (!norm(parts.join(""))) parts.push(ancestorText(el, (c) => c === el));
    if (el.placeholder) parts.push(el.placeholder);
    parts.push(((el.name || "") + " " + (el.id || "")).replace(/[_\[\]\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
    return norm(parts.join(" | ")).toLowerCase();
  }

  function groupQuestion(radios) {
    const first = radios[0];
    const fs = first.closest("fieldset");
    if (fs && fs.querySelector("legend")) return textOf(fs.querySelector("legend")).toLowerCase();
    const lb = first.closest("[role=radiogroup]")?.getAttribute("aria-labelledby");
    if (lb) return textOf(document.getElementById(lb)).toLowerCase();
    // Walk up to the smallest ancestor holding the whole group, and use it if it holds nothing else.
    let node = first.parentElement;
    while (node && node !== document.body && !radios.every((r) => node.contains(r))) node = node.parentElement;
    let t = "";
    for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
      if ([...node.querySelectorAll(CONTROLS)].some((c) => c.name !== first.name)) break;
      const s = textOf(node);
      if (radios.reduce((acc, r) => acc.replace(optionText(r), ""), s).trim().length > 3) { t = s; break; }
    }
    // Strip the option labels so "Yes No" doesn't pollute the question.
    let q = t;
    for (const r of radios) q = q.replace(optionText(r), "");
    return norm(q || first.name.replace(/[_\[\]\-]+/g, " ")).toLowerCase();
  }

  function optionText(r) {
    return textOf(r.labels && r.labels[0]) || norm(r.getAttribute("aria-label")) || r.value || "";
  }

  const isoPlusDays = (d) => {
    const x = new Date();
    x.setDate(x.getDate() + d);
    return x.toISOString().slice(0, 10);
  };

  function rules(P, usd) {
    const R = (re, text, extra = {}) => ({ re, text, ...extra });
    return [
      R(/preferred (first )?name|nick ?name/, P.firstName),
      R(/first ?name|given name|\bfname\b/, P.firstName),
      R(/last ?name|surname|family name|\blname\b/, P.lastName),
      R(/e-?mail/, P.email, { not: /referr|manager|recruiter|reference/ }),
      R(/phone|mobile|contact (no|number)|whatsapp|\bcell\b|\btel\b/, P.phone, { not: /country code|extension|referr|reference/ }),
      R(/linked ?in/, P.linkedin),
      R(/git ?hub/, P.github),
      R(/twitter|\bx (profile|handle|url|account)|x\.com/, P.x),
      R(/portfolio|personal (web)?site|website|\bblog\b|other (link|url|website)|\burl\b|link to (your )?work/, P.website),
      R(/current (company|employer|organi[sz]ation)|present (company|employer)|employer name|most recent (company|employer)|company you (currently )?work/, P.company),
      R(/current (job )?(title|role|position|designation)|job title|most recent (title|role)/, P.title),
      R(/(years|yrs).{0,40}experience|experience.{0,40}(years|yrs)|how many years/, P.yearsText, { num: P.years, check: true }),
      R(/notice period|serving notice/, P.notice, { num: P.noticeDays }),
      R(/(current|present|existing).{0,30}(ctc|salary|compensation|pay\b|package)/, usd ? P.currentUSD : P.currentCTC, { num: usd ? null : P.currentCTCNum, check: true }),
      R(/expected|expectation|desired (salary|compensation|pay)|salary requirement|compensation (requirement|range)|what (salary|compensation)|\bctc\b|salary/, usd ? P.expectedUSD : P.expectedCTC, { num: usd ? P.expectedUSDNum : P.expectedCTCNum, check: true }),
      R(/start date|when can you (start|join)|earliest|available to (start|join)|availability|joining/, P.startText, { date: isoPlusDays(15), num: 15 }),
      R(/relocat/, P.relocateText, { choice: /^yes/i }),
      R(/(authori[sz]ed|eligible|legally (able|permitted)|right) to work|work (authori[sz]ation|permit)|visa status/, P.workAuthText, { auth: true }),
      R(/sponsor/, null, { flag: true }),
      R(/how did you (hear|find|learn)|where did you (hear|find|see)|referral source|\bsource\b/, null, { flag: true }),
      R(/why.{0,30}(leav|look|switch|chang|mov|explor)|reason for (leaving|change|switch|looking)/, P.answers["Why are you looking (long)"]),
      R(/school|university|college|institution/, P.school, { not: /high school/ }),
      R(/degree|qualification/, P.degree),
      R(/discipline|major|field of study|speciali[sz]ation/, P.field),
      R(/graduat.{0,20}(year|date)|year of (passing|graduation)|passing year/, String(P.gradYear), { num: P.gradYear, date: "2025-05-31" }),
      R(/\bcity\b/, P.city),
      R(/\bstate\b|province/, P.state),
      R(/country/, P.country, { choice: /^india\b/i, not: /code/ }),
      R(/location|where are you (located|based)|based (in|out of)|where do you live/, P.location, { not: /willing|open to|prefer|relocat/ }),
      R(/full ?name|legal name|your name|candidate name|^name\b|\| name\b|\bname\b/, P.fullName, { not: /company|employer|school|universit|college|referr|reference|manager|recruiter|emergency|project|file|user ?name|first|last/ }),
    ];
  }

  function matchRule(q, list) {
    if (!q || SKIP.test(q)) return null;
    // Prefer the human label (before the first " | "); fall back to the whole string.
    const label = q.split(" | ")[0];
    for (const src of [label, q]) {
      for (const r of list) if (r.re.test(src) && !(r.not && r.not.test(src))) return r;
    }
    return null;
  }

  const ABROAD = /united states|\bu\.?s\.?a?\b|america|canada|\buk\b|united kingdom|europe|\beu\b|germany|australia|singapore|uae|dubai/;

  function authAnswer(q) {
    if (/india/.test(q)) return "yes";
    if (ABROAD.test(q)) return "no";
    return null;
  }

  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function pickOption(options, rule, q) {
    const opts = options.filter((o) => norm(o.text) && !/^(select|choose|--|please)/i.test(norm(o.text)));
    if (rule.auth) {
      const a = authAnswer(q);
      return a ? opts.find((o) => new RegExp("^" + a, "i").test(norm(o.text))) : null;
    }
    if (rule.choice) return opts.find((o) => rule.choice.test(norm(o.text)));
    const v = (rule.text || "").toLowerCase();
    return (
      opts.find((o) => norm(o.text).toLowerCase() === v) ||
      opts.find((o) => norm(o.text).length > 2 && v.includes(norm(o.text).toLowerCase())) ||
      opts.find((o) => norm(o.text).toLowerCase().includes(v.split(",")[0]))
    );
  }

  function attachResume(input, b64, name) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: "application/pdf" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mark(el, color) {
    const target = el.type === "file" && !visible(el) ? el.parentElement || el : el;
    target.style.outline = color;
    target.style.outlineOffset = "2px";
  }

  function toast(msg) {
    document.getElementById("__applykit_toast")?.remove();
    const d = document.createElement("div");
    d.id = "__applykit_toast";
    d.textContent = msg;
    d.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;border-radius:10px;background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);white-space:pre-line";
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 9000);
  }

  function fill({ resumeB64 = null, currency = "INR", profile } = {}) {
    const P = profile || globalThis.APPLY_PROFILE;
    const list = rules(P, currency === "USD");
    const filled = [];
    const check = [];
    const all = [...document.querySelectorAll(CONTROLS)];
    if (!all.length) return { filled, check, controls: 0 };

    // Radio groups first.
    const groups = {};
    for (const r of all.filter((e) => e.type === "radio" && e.name)) (groups[r.name] ||= []).push(r);
    for (const radios of Object.values(groups)) {
      if (radios.some((r) => r.checked)) continue;
      const q = groupQuestion(radios);
      const rule = matchRule(q, list);
      if (!rule || rule.flag) {
        if (rule) { check.push(q.slice(0, 80)); radios.forEach((r) => mark(r.parentElement || r, AMBER)); }
        continue;
      }
      let want = null;
      if (rule.auth) { const a = authAnswer(q); want = a && new RegExp("^" + a, "i"); }
      else if (rule.choice) want = rule.choice;
      const hit = want ? radios.find((r) => want.test(optionText(r))) : radios.find((r) => optionText(r).toLowerCase() === (rule.text || "").toLowerCase());
      if (hit) { hit.click(); filled.push(q.slice(0, 60)); mark(hit.parentElement || hit, GREEN); }
      else { check.push(q.slice(0, 80)); radios.forEach((r) => mark(r.parentElement || r, AMBER)); }
    }

    // Resume upload.
    const files = all.filter((e) => e.type === "file");
    for (const f of files) {
      const q = questionFor(f);
      const isResume = /resume|\bcv\b|curriculum/.test(q) && !/cover|autofill|parse/.test(q);
      const onlyOne = files.length === 1 && !/cover|autofill|parse|photo|image|transcript/.test(q);
      if ((isResume || onlyOne) && resumeB64 && !(f.files && f.files.length)) {
        try { attachResume(f, resumeB64, P.resumeFileName); filled.push("resume upload"); mark(f, GREEN); }
        catch (e) { check.push("resume upload (attach manually)"); mark(f, AMBER); }
      }
    }

    // Everything else.
    for (const el of all) {
      if (el.type === "radio" || el.type === "file" || el.type === "checkbox") continue;
      if (el.disabled || el.readOnly || !visible(el)) continue;
      if (el.tagName !== "SELECT" && norm(el.value)) continue;
      if (el.tagName === "SELECT" && el.selectedIndex > 0) continue;

      const q = questionFor(el);
      const required = el.required || el.getAttribute("aria-required") === "true" || /[*✱]/.test(q.split(" | ")[0]);
      const rule = matchRule(q, list);
      const short = q.split(" | ")[0].slice(0, 80) || q.slice(0, 80);

      if (!rule || rule.flag) {
        if (rule || required) { check.push(short); mark(el, AMBER); }
        continue;
      }

      let value = null;
      if (el.tagName === "SELECT") {
        const opt = pickOption([...el.options], rule, q);
        if (opt) value = opt.value;
      } else if (el.type === "number") {
        value = rule.num != null ? String(rule.num) : null;
      } else if (el.type === "date") {
        value = rule.date || null;
      } else if (rule.num != null && /\blpa\b|lakhs?|in numbers|numeric|\(years\)|\(days\)/.test(q) && rule.text !== P.yearsText) {
        value = /ctc|salary|compensation/.test(q) ? String(rule.num / 100000) : String(rule.num);
      } else if (rule.auth) {
        const a = authAnswer(q);
        value = el.tagName === "TEXTAREA" || !a ? rule.text : a === "yes" ? "Yes" : "No";
      } else {
        value = rule.text;
      }

      if (value == null || value === "") { check.push(short); mark(el, AMBER); continue; }
      setNative(el, value);
      filled.push(short.slice(0, 60));
      const combo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete");
      if (rule.check || combo || (rule.auth && !authAnswer(q))) { check.push(short + (combo ? " (pick from dropdown)" : "")); mark(el, AMBER); }
      else mark(el, GREEN);
    }

    if (filled.length || check.length) {
      toast(`Apply Kit: filled ${filled.length} field(s).` + (check.length ? `\nCheck ${check.length} amber field(s):\n• ` + check.slice(0, 6).join("\n• ") : "") + "\nNothing was submitted.");
    }
    return { filled, check, controls: all.length };
  }

  // Empty questions left after fill(), for Claude to answer. Tags each with data-applykit-id.
  function collectOpen() {
    const out = [];
    const P = globalThis.APPLY_PROFILE;
    const list = rules(P, false);
    let n = 0;
    for (const el of document.querySelectorAll("textarea, input[type=text], input:not([type])")) {
      if (el.disabled || el.readOnly || !visible(el) || norm(el.value)) continue;
      if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete")) continue;
      const q = questionFor(el);
      const label = q.split(" | ")[0];
      if (!label || label.length < 4 || SKIP.test(q)) continue;
      const rule = matchRule(q, list);
      const required = el.required || el.getAttribute("aria-required") === "true" || /[*✱]/.test(label);
      if (rule && !rule.flag) continue;
      if (!(el.tagName === "TEXTAREA" || required || rule)) continue;
      const id = el.dataset.applykitId || (globalThis.__akPrefix ||= "f" + Math.random().toString(36).slice(2, 6)) + "_" + n++;
      el.dataset.applykitId = id;
      const max = +el.getAttribute("maxlength") || null;
      out.push({ id, question: label.replace(/\s*[*✱]\s*$/, ""), kind: el.tagName === "TEXTAREA" ? "long text" : "short text", maxLength: max && max > 0 ? max : null });
    }
    return out;
  }

  function applyAnswers(answers) {
    let done = 0;
    for (const { id, answer } of answers || []) {
      const el = document.querySelector(`[data-applykit-id="${id}"]`);
      if (!el || !answer || norm(el.value)) continue;
      setNative(el, el.maxLength > 0 ? answer.slice(0, el.maxLength) : answer);
      mark(el, "2px solid #a855f7");
      done++;
    }
    if (done) toast(`Apply Kit: Claude answered ${done} question(s) (purple). Read and edit them before submitting.`);
    return done;
  }

  // Rough interview-chance score from the job description text.
  function score(raw) {
    const t = " " + (raw || "").toLowerCase().replace(/\s+/g, " ") + " ";
    const hits = [];
    const gaps = [];
    const STACK = [
      ["TypeScript", /typescript|\bts\b/, 7],
      ["React/Next.js", /next\.?js|react/, 6],
      ["Node/Bun", /node\.?js|\bnode\b|\bbun\b|express|nest\.?js|hono/, 6],
      ["Postgres/SQL", /postgres|\bsql\b|mysql|prisma|drizzle/, 5],
      ["MongoDB", /mongo/, 2],
      ["AWS/Cloud", /\baws\b|amazon web services|\becs\b|lambda|cloudflare|\bgcp\b|docker/, 4],
      ["LLM/AI", /\bllms?\b|openai|anthropic|claude|\bgpt|\bagents?\b|agentic|\brag\b|\bai\b|genai|generative/, 5],
      ["GraphQL/Redis/queues", /graphql|redis|kafka|queues?\b|bullmq|websocket|real-?time/, 3],
    ];
    let stack = 0;
    for (const [n, re, w] of STACK) if (re.test(t)) { stack += w; hits.push(n); }
    const GAPS = [
      ["Python", /python|django|fastapi|flask/],
      ["Go", /golang|\bgo (developer|engineer|services|backend)|\bin go\b/],
      ["Java/Spring", /\bjava\b(?!script)|spring boot|kotlin/],
      ["Rust", /\brust\b/],
      ["C#/.NET", /c#|\.net\b/],
      ["Ruby/Rails", /\bruby\b|rails/],
      ["PHP", /\bphp\b|laravel/],
      ["iOS/Android native", /\bswift\b|swiftui|android (sdk|native)/],
    ];
    for (const [n, re] of GAPS) if (re.test(t)) gaps.push(n);
    stack = Math.max(0, Math.min(35, stack) - Math.min(12, gaps.length * 3));

    let exp = 14;
    const years = [...t.matchAll(/(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2})?\s*\+?\s*(?:years?|yrs)/g)].map((m) => +m[1]).filter((n) => n > 0 && n <= 15);
    if (years.length) {
      const min = Math.min(...years);
      exp = min <= 3 ? 20 : min === 4 ? 12 : min === 5 ? 7 : 3;
    } else if (/\b(senior|staff|principal)\b/.test(t)) exp = 9;

    let loc = 8;
    if (/india|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|hyderabad|pune|mumbai|chennai/.test(t)) loc = 15;
    else if (/remote.{0,20}(anywhere|worldwide|global)|(anywhere|worldwide|global).{0,20}remote|work from anywhere/.test(t)) loc = 15;
    else if (/(us|u\.s\.|united states|north america|europe|emea|uk)[- ]?(only|based)|must (be|reside|live) in the (us|u\.s\.|united states)|authori[sz]ed to work in the (us|united states)/.test(t)) loc = 3;
    else if (/remote/.test(t)) loc = 10;
    else if (/san francisco|new york|london|berlin|seattle|toronto|onsite|on-site|in office/.test(t)) loc = 4;

    let domain = 6;
    if (/\bai\b|\bllm|agent/.test(t)) domain += 4;
    if (/developer tools|devtools|developer platform|\bapi\b/.test(t)) domain += 2;
    if (/\bsaas\b|b2b/.test(t)) domain += 2;
    if (/e-?commerce|d2c|shopify|storefront/.test(t)) domain += 3;
    if (/ed-?tech|learning platform|education/.test(t)) domain += 3;
    if (/founding|early[- ]stage|\bseed\b|series a|y ?combinator|\byc\b/.test(t)) domain += 4;
    domain = Math.min(15, domain);

    let fresh = 9;
    const ago = t.match(/(\d+)\s*(hour|day|week|month)s? ago/);
    if (ago) {
      const n = +ago[1];
      const days = ago[2] === "hour" ? 0 : ago[2] === "day" ? n : ago[2] === "week" ? n * 7 : n * 30;
      fresh = days <= 7 ? 15 : days <= 14 ? 10 : days <= 30 ? 6 : 3;
    }
    const apps = t.match(/(\d[\d,]*)\+?\s*applicants/);
    if (apps && +apps[1].replace(/,/g, "") > 200) fresh = Math.max(2, fresh - 5);

    const total = stack + exp + loc + domain + fresh;
    return { total, parts: { stack, exp, loc, domain, fresh }, hits, gaps, chars: t.length };
  }

  function pageInfo() {
    const u = new URL(location.href);
    const seg = u.pathname.split("/").filter(Boolean);
    const pick = (...sels) => sels.map((s) => textOf(document.querySelector(s))).find((t) => t && t.length < 80) || "";
    // Job portals show the hiring company on the page, not in the URL.
    let company = /linkedin\.com/.test(u.hostname) ? pick(".job-details-jobs-unified-top-card__company-name a", ".job-details-jobs-unified-top-card__company-name", 'a[href*="/company/"]')
      : /naukri\.com/.test(u.hostname) ? pick(".jd-header-comp-name a", '[class*="comp-name"] a', '[class*="comp-name"]')
      : /instahyre\.com/.test(u.hostname) ? pick(".company-name", '[class*="company-name"]')
      : /wellfound\.com/.test(u.hostname) ? pick('a[href^="/company/"]') : "";
    if (!company) {
      if (/ashbyhq|lever\.co|greenhouse\.io|workable\.com|smartrecruiters|breezy|recruitee/.test(u.hostname)) company = seg[0] === "embed" ? u.searchParams.get("for") || "" : seg[0] || "";
      else if (/myworkdayjobs/.test(u.hostname)) company = u.hostname.split(".")[0];
      company = company || document.querySelector('meta[property="og:site_name"]')?.content || u.hostname.replace(/^(www|jobs|careers|apply)\./, "").split(".")[0];
      company = company.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    const h1 = textOf(document.querySelector("h1")) || textOf(document.querySelector("h2"));
    const role = (h1 && h1.length < 120 ? h1 : document.title.split(/ [-|@–] /)[0]).trim();
    return { company, role, url: location.href, text: (document.body?.innerText || "").slice(0, 30000), domain: siteDomain() };
  }

  // The company's own website: a "Website" link on a job board, or the page itself when it's a company careers site.
  const BOARD = /linkedin|naukri|instahyre|wellfound|ashbyhq|lever\.co|greenhouse|workable|smartrecruiters|breezy|recruitee|myworkdayjobs/;
  function siteDomain() {
    for (const a of document.querySelectorAll("a[href^='http']")) {
      if (!/^(website|company (web)?site|visit website|homepage)$/i.test((a.textContent || "").trim())) continue;
      try { const h = new URL(a.href).hostname.replace(/^www\./, ""); if (!BOARD.test(h)) return h; } catch {}
    }
    return BOARD.test(location.hostname) ? "" : location.hostname.replace(/^(www|jobs|careers|apply)\./, "");
  }

  globalThis.__applyKit = { fill, score, pageInfo, collectOpen, applyAnswers };
})();
