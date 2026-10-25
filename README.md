# Apply Kit

An AI job-application assistant: a Chrome extension plus a small local server that uses **Claude Code** to answer application questions, score job fit, find the right people to contact and draft outreach. It never submits anything. You review and press Submit.

Built in October 2026 with Claude Code.

## What it does

- **Fill** (Alt+Shift+F): fills application forms from your profile: name, contact, links, current/expected pay (₹ or $), notice period, relocation, education, and attaches your resume automatically. Green = filled, amber = check yourself. Never overwrites what you typed and never touches demographic questions.
- **Fill + Claude** (Alt+Shift+A): after filling, sends the questions that are still empty plus the job description to Claude, then fills the answers (purple) for you to edit. Claude answers only from facts in your `context.md` and leaves a question blank if it can't answer it honestly.
- **Score**: a quick heuristic fit score (stack, experience, location, domain, freshness) in the popup, or a deeper **Claude score** with reasons, gaps and what to lead with.
- **People & outreach**: Claude researches founders, hiring managers and recruiters from public sources, and drafts an email, LinkedIn or X message for each. "Open in Gmail" opens a prefilled compose window, so you send it yourself.
- **Find HR** (dashboard Jobs tab and the popup): finds the people who hire at a company and their best contact, in this order: phone, email, LinkedIn, X. Free sources first: Claude web research (names, titles, profiles, and numbers or emails recruiters published in public hiring posts), the company's own website, public GitHub commit emails (to learn the company's email format), and the job page. Every contact shows where it came from and how sure it is: verified, published, likely or guessed. Optional free-tier keys: `hunter_api_key` (checks guessed emails, 50 a month free) and `github_token` (higher GitHub rate limit). Results are cached per company and a credit counter keeps you inside free allowances. Phone chips open a call or WhatsApp, emails open Gmail compose; you always send yourself.
- **Guided mode** (side panel): for forms that ignore or flag scripted filling (Ashby). Lists every field with its suggested answer, lets Claude answer the blanks, and gives each a Copy button; it outlines the field on the page, follows the field you click into, and tracks what's done. It fills nothing.
- **Jobs tab + auto mode**: runs the board scanner from the dashboard and lists the jobs, ranked by a Claude fit score (one call rates 40 jobs from title, company and location). Companies you already applied to (dashboard log or a `TRACKER.md` beside your packs) are hidden. Auto mode (off by default) finds people for the newest jobs in the background, up to a daily cap.
- **Referrals**: import LinkedIn's `Connections.csv` and see who you know at each company, with a drafted referral ask.
- **Dashboard** (`localhost:4777`): your pipeline of prepared applications, an applications funnel (applied, replied, interview, offer) with reply rate per channel, and an outreach log.
- **RAG over your own notes**: point `docs` in `server/config.json` at your markdown notes (project write-ups, past achievements). Every Claude call retrieves the most relevant facts with hybrid search and adds them to the prompt, so answers use the right details instead of one fixed profile.
- **Board scanner** (`tools/scan-boards.py`): pulls live roles from Ashby, Greenhouse and Lever job boards and filters them to your profile.

## Setup

Requirements: Chrome, [Bun](https://bun.sh), and [Claude Code](https://claude.com/claude-code) logged in (the server calls `claude -p`, so it runs on your Claude plan, no API key needed).

```bash
git clone https://github.com/kuldeepsaini23/apply-kit
cd apply-kit
cp profile.example.js profile.js                     # your details (gitignored)
cp server/context.example.md server/context.md       # facts + rules Claude may use (gitignored)
cp server/config.example.json server/config.json     # name/email/deadline + "docs" paths for RAG (gitignored)
cd server && bun install && cd ..                    # local embedding model for RAG
# put your resume at ./resume.pdf (gitignored)
```

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Start the server: `bun server/server.ts` (Windows: double-click `start-server.cmd`). The dashboard opens at http://localhost:4777.

Optional: put prepared application notes as markdown files in `packs/` (or set `APPLYKIT_PACKS`) and they show up in the dashboard pipeline.

## How it's built

- **Extension (MV3)**: `fill.js` is injected into every frame on demand. It matches each field's label to a rule (regex on label, name and placeholder), sets values with native setters plus input/change events, attaches the resume via `DataTransfer`, and tags open questions for Claude. `background.js` handles the shortcuts and messages from the dashboard; `bridge.js` connects the dashboard page to the extension.
- **Server (Bun)**: `server/server.ts` binds to 127.0.0.1 only and rejects requests from other origins. Each AI endpoint spawns `claude -p` with your `context.md` as the system prompt (no tools for answers and drafts; WebSearch/WebFetch only for people research) and parses the JSON reply.
- **RAG** (`server/rag.ts`): markdown is split by heading into ~600-character chunks with overlap. Each chunk gets a BM25 keyword score and a vector embedding from `all-MiniLM-L6-v2`, run locally on CPU via transformers.js (no embedding API). Queries use reciprocal rank fusion of both rankings; vectors are cached until the notes change.
- **Retrieval eval** (`server/rag-eval.ts`, `bun run eval:rag`): checks whether the right fact lands in the top 5 for a set of questions, half in the notes' own words and half paraphrased. On my notes (428 chunks, 16 questions):

  | mode | recall@5 | MRR |
  |---|---|---|
  | BM25 only | 94% | 0.80 |
  | vector only | 100% | 0.92 |
  | hybrid (RRF) | 94% | **0.94** |

  Smaller chunks helped: 600 characters beat 900 and 400. Hybrid ranks the right fact first most often, so it's the default.
- **Dashboard**: plain HTML/JS, served by the same server.

## Known limits

- Some ATS forms (notably Ashby) flag automated filling and submission as spam and ignore values set from scripts. Use Guided mode there.
- The heuristic score is a rough guide; use the Claude score for decisions.

## Roadmap

- Gmail OAuth to create drafts with the resume attached and detect replies.

## License

MIT
