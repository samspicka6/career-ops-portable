# Career-Ops Portable

Career-Ops finds jobs that fit you, checks they are still open, and lists them
on a job board page you open in your browser. It runs on your own computer
(Windows, Mac or Linux), and you set it up and use it by double-clicking, with
no terminal needed.

| What you get | |
|--------------|---|
| **Job search** | Searches public job boards (Greenhouse, Lever, Ashby and more) for the job titles and places you pick. No company list needed. |
| **Live check** | Every posting is checked before you see it, so closed jobs don't waste your time. |
| **AI review (optional)** | An AI helper of your choice scores each job against your CV in an A-H report: fit, gaps, pay, and a cover-letter draft. Free options exist, or pick none. |
| **Job board** | One page with every job, its score, location, pay and links. Mark jobs as interested, applied, interviewing and so on. |
| **Daily search** | One switch to run the search every morning by itself. |
| **Human-in-the-Loop** | It finds, checks and ranks jobs; you decide and apply. The system never submits an application -- you always have the final call <!-- hitl: absolute guarantee. Do not add "automatically", "by itself", "without your permission" or any other hedge when translating this row. --> |

Your CV and everything about your search stay in a folder on your computer.
Nothing is sent anywhere except the job postings you look up and, if you pick
one, the AI helper you choose.

## Quick Start

### Easiest: no terminal, no commands

1. **Download.** On this page click the green **Code** button, then **Download ZIP**.
   Unzip it (double-click the file) and move the folder somewhere you'll keep it,
   such as your home folder. On a Mac, keep it out of Downloads, Desktop and
   Documents if you want daily searches (macOS blocks background jobs there).
2. **Start.** Open the folder and double-click:
   - Windows: **`_Start Career-Ops (Windows).bat`**
   - Mac: **`_Start Career-Ops (Mac).command`**

   The first time, Windows or macOS may warn you about a downloaded file
   ([what to click](#the-first-start-windows-and-mac-warnings)). If Node.js
   isn't installed, the launcher offers to install it for you. The first start
   then downloads what Career-Ops needs, which takes a few minutes.
3. **Set up in your browser.** Career-Ops opens a page in your browser. Upload
   your CV (PDF, Word or text), check what it read, say which jobs and places
   you want, and pick an AI helper or none. That's it.
4. **Find jobs.** Press **Find new jobs**, then **Open my job board**. Turn on
   **Search every day** to have it run on its own each morning.

To use it again later, double-click the same Start file. Updates are one
button: **Check for updates** in the app (your files are never touched). The
full walkthrough is in [The app](#the-app-setup-and-daily-use-without-a-terminal).

### With a terminal: two commands

How it all works: [Portable Guide](#portable-guide-how-everything-works).

```bash
git clone https://github.com/samspicka6/career-ops-portable && cd career-ops-portable && npm install
npm run setup    # paste your CV, pick target roles, where to look and who judges
npm run board    # scan → verify live → judge (optional) → your job board
```

`npm run setup` asks a few questions and writes everything for you: it creates a
data folder (default `../career-ops-data`, so the checkout stays a clean engine
you can update), turns a pasted CV or a `.pdf` / `.docx` / `.txt` / `.md` file into
`cv.md`, fills `config/profile.yml` and the target roles in `modes/_profile.md`,
sets the title keywords and locations in `portals.yml`, and picks a judge.
Re-run it any time; it keeps what you already have unless you say otherwise.
Every question also has a flag for scripted installs (`node setup.mjs --help`).

`npm run board` runs the whole loop on Windows, macOS or Linux: scan your portals
(or sweep every public Greenhouse/Lever/Ashby board for your keywords), rank the
queue, liveness-check the top of it and fetch the job descriptions, re-check that
evaluated roles are still open, then hand the live postings to the judge you
chose and rebuild `output/career-dashboard.html` (the board) and
`output/queue.html` (live postings still waiting). Every step except the judge
is free. Pick the judge in `config/board.yml` or per run with `--judge`:

| Judge | Needs | Cost |
|-------|-------|------|
| `claude` | Claude Code CLI, logged in | your Claude plan |
| `openrouter` | `OPENROUTER_API_KEY` in `.env` | free models |
| `gemini` | `GEMINI_API_KEY` in `.env` | free tier |
| `ollama` | Ollama running locally with a model | free, private |
| `openai` | any OpenAI-compatible endpoint (`OPENAI_API_KEY`, `OPENAI_BASE_URL`) | per provider |
| `none` | nothing | free: rank, verify and list only |

Useful flags: `--open` (open the board when done), `--build-only` (just rebuild
it, also `npm run board:build`), `--no-scan`, `--sweep`, `--n 20` (postings to
verify), `--max 5` (postings to judge). To run it every night, schedule
`npm run board` with cron, launchd or Task Scheduler
([docs/AUTOMATION.md](docs/AUTOMATION.md)). `npm run init` creates just the data
folder from templates, if you'd rather fill the files in by hand.

## Portable Guide: How Everything Works

This section explains the whole portable setup end to end: what lives where,
what each command does, how a posting travels from a job site to your board,
and how to tune, schedule and update it. You only need the Quick Start to get
going; read this when you want to know what is happening underneath.

### The big picture

```
┌────────────── this checkout (the engine) ──────────────┐   ┌──── your data folder ────┐
│ scripts (*.mjs), auto/, judges/, lib/, modes/,         │   │ cv.md                    │
│ templates/, .env (API keys), config/board.yml          │──▶│ config/profile.yml       │
│                                                        │   │ modes/_profile.md        │
│ .career-ops-data  ── one line: path to your data ──────┼──▶│ portals.yml              │
└────────────────────────────────────────────────────────┘   │ data/ reports/ jds/      │
                                                             │ output/ interview-prep/  │
                                                             └──────────────────────────┘
```

The repository is split into two layers:

- **The engine** is this checkout: every script, template and mode. It holds
  nothing about you, so you can `git pull` updates without merge conflicts and
  share it without leaking your CV.
- **Your data folder** holds everything personal: CV, profile, the companies
  you watch, the tracker, reports, saved job descriptions and the generated
  board. `npm run setup` creates it at `../career-ops-data` by default (next
  to the checkout, not inside it). You can back it up, sync it, or keep it in
  its own private git repo.

Every script finds your data folder the same way (`path-resolver.mjs`), in
this order:

1. the `CAREER_OPS_DATA_DIR` (or `CAREER_OPS_ROOT`) environment variable;
2. the `.career-ops-data` marker file in the checkout, which `setup` / `init`
   write and which holds one line: the path to your folder;
3. otherwise the checkout itself (the original single-folder layout).

So you can keep several searches side by side (for example `~/search-2026`
and `~/search-partner`) and switch with
`CAREER_OPS_DATA_DIR=~/search-partner npm run board`.

### The app: setup and daily use without a terminal

The Start files and `npm start` all run `app/launch.mjs`, which:

1. checks Node.js (18 or newer). The Windows and Mac launchers offer to install
   it when it's missing: Windows through `winget`, or the official installer
   from nodejs.org when `winget` isn't there; Mac by downloading and opening
   the official installer;
2. runs `npm install` the first time, and again only when `package.json`
   changed (after an update). This includes the browser Playwright uses for
   liveness checks, a few hundred MB;
3. starts a small local web server (`app/server.mjs`) on
   `http://127.0.0.1:4747` (the next free port if that one is busy) and opens
   it in your browser. It only accepts connections from this computer.
   Double-clicking Start again while it runs just reopens the page. Closing the
   launcher window (or **Close** in the app) stops it.

**The setup wizard** asks the same things as `npm run setup`, in six screens:
your CV, about you, jobs you want, where to look, AI helper, and a summary.
It then runs `setup.mjs` with your answers as flags, so the files it writes are
exactly the ones the terminal setup writes (see Step 1 below). A few
differences:

- You can upload the CV file (PDF, Word `.docx` or text) instead of pasting.
  It is read on your computer by `lib/cv-text.mjs` (pdf.js for PDFs, mammoth
  for Word; the terminal setup uses the same code), and you see the converted
  text and can fix it before saving. A scanned-image PDF has no text to read;
  paste the text instead.
- The data folder defaults to `career-ops-data` in your home folder (the
  terminal setup defaults to next to the checkout). Keeping it outside the app
  folder means deleting or replacing the app never loses your files. If you
  download a fresh copy of the app, it finds that folder and picks up where you
  left off.
- An API key you paste for an AI helper goes into `.env` in the app folder,
  the same as the terminal setup.

**The home screen** is what you see every time after that:

| Button | What it runs |
|--------|--------------|
| Find new jobs | `node board.mjs` (the full run in Step 2 below), with each step's progress and the log shown live. |
| Open my job board | `output/career-dashboard.html` from your data folder. |
| Jobs waiting for a look | `output/queue.html`, the live postings no AI has reviewed yet. |
| Edit (your CV and preferences) | The setup wizard again, filled in with your current answers. |
| Search every day | Registers one daily `board.mjs` run (`app/schedule.mjs`): Windows Task Scheduler task "Career-Ops Board", a macOS LaunchAgent `org.career-ops.board`, or a tagged crontab line on Linux. The computer must be on at that time. |
| Check for updates | `app/update.mjs`: `git pull` in a git checkout; in a ZIP copy, downloads the newest version from GitHub and writes the engine files over the old ones. `.env`, `.career-ops-data`, `node_modules` and your data folder are never touched. Close and reopen the app afterwards. |
| Open folder | Opens your data folder. |
| Rebuild | `node board.mjs --build-only`: redraws the board without searching. |

Updates come from the repository named in `package.json` under
`careerOpsPortable.updateRepo` (and `.branch`), so a fork updates from itself.

#### The first start: Windows and Mac warnings

Files downloaded from the internet get a warning the first time:

- **Windows** ("Windows protected your PC"): click **More info**, then
  **Run anyway**.
- **Mac** ("cannot be opened" or "Apple could not verify"): open **System
  Settings → Privacy & Security**, scroll down, and click **Open Anyway** next
  to the Career-Ops message, then double-click the file again. On older macOS,
  right-click the file and choose **Open**.

### Commands at a glance

| Command | What it does | Uses AI? |
|---------|--------------|----------|
| `npm start` | The app: setup wizard and home screen in your browser (what the Start files run). | Only if you pick an AI helper |
| `npm run setup` | Guided first run: data folder, CV, profile, portals, judge. Safe to re-run. | No |
| `npm run board` | The daily loop: scan → prep → recheck → judge → board → (sweep). | Only the judge step, and only if you pick one |
| `npm run board:build` | Rebuild the board pages from what is already on disk. | No |
| `npm run init [dir]` | Create an empty data folder from templates (no questions). | No |
| `npm run move-data [dir]` | Move an existing in-checkout setup out into a data folder. | No |
| `npm run doctor` | Check prerequisites; reports which data folder is in use. | No |
| `npm run scan` | Just the portal scan (adds postings to `data/pipeline.md`). | No |

### Step 1: `npm run setup`

`setup.mjs` asks five questions and writes plain files you can edit later.
Each step shows what is already there and keeps it unless you say otherwise.

1. **Data folder.** Creates it from the templates (`init-data.mjs`) and
   writes the `.career-ops-data` marker. Default `../career-ops-data`; pass
   `--in-place` to keep data in the checkout instead.
2. **CV.** Paste it, or give a `.pdf`, `.docx`, `.txt` or `.md` path. It is converted to
   `cv.md` without AI, so glance at the headings once. `cv.md` is the single
   source of truth: reports and cover-letter bullets may only restate what is
   in it, never invent.
3. **Profile.** Name, contact, location and target roles go into
   `config/profile.yml`; the target roles also fill the archetype table in
   `modes/_profile.md`, which is what evaluations score you against.
4. **Where to look.** Title keywords and locations are written into
   `portals.yml`, then you choose a source:
   - *Keyword sweep* (recommended): search every public Greenhouse, Lever and
     Ashby board for your keywords. No company list needed, any industry.
   - *Starter list*: 200+ preset companies (mostly tech and AI).
   - *Both*, or *keep* your current `portals.yml`.
5. **Judge.** Detects what this computer can use (Claude CLI, API keys in
   `.env`, a running Ollama) and saves your choice in `config/board.yml`.
   Keys you paste are stored in `.env` in the checkout, which git ignores.

Scripted installs can answer everything with flags:

```bash
node setup.mjs --yes --data-dir ~/my-search --cv cv.pdf \
  --roles "Data Analyst, BI Analyst" --location "Denver, CO" \
  --locations "Denver, Remote" --portals sweep --judge none
```

### Step 2: `npm run board`

`board.mjs` runs the same steps on Windows, macOS and Linux. Each step has a
time limit (`budgets` in `config/board.yml`); a step that fails or overruns is
logged and the run carries on, so the board is always rebuilt. Nothing in the
run ever submits or applies to anything.

| # | Step | Script | What happens | Reads → writes |
|---|------|--------|--------------|----------------|
| 1 | **scan** | `scan.mjs` | Queries every enabled company in `portals.yml` through the job-board APIs (Greenhouse, Lever, Ashby and the many other providers in `providers/`), keeps titles matching your `title_filter` and locations matching `location_filter`, and skips anything seen before. | `portals.yml`, `data/scan-history.tsv` → new lines under *Pending* in `data/pipeline.md` |
| 2 | **prep** | `auto/prep.mjs` | Ranks the Pending queue, liveness-checks the top `prep_count` postings, moves dead ones to *Processed*, downloads each live job description and flags things worth a look. | `data/pipeline.md` → `data/auto/jd/NN.txt`, `data/auto/digest.md`, `data/auto/batch.json` |
| 3 | **recheck** | `auto/recheck.mjs` | Re-verifies roles you have evaluated but not applied to. Postings that are conclusively closed are set to *Discarded* with a "posting closed" note. | `data/applications.md` |
| 4 | **judge** | `judges/` | Evaluates the live postings from prep with the model you chose (see below). Skipped with `judge: none`. | `data/auto/batch.json` → `reports/*.md`, `data/applications.md` |
| 5 | **board** | `auto/dashboard.mjs`, `lib/board-queue.mjs` | Builds the two pages you look at. | tracker + reports → `output/career-dashboard.html`, `output/queue.html` |
| 6 | **sweep** | `scan-ats-full.mjs` | Optional keyword-first search across all public Greenhouse/Lever/Ashby boards; matches are queued for the next run's prep. When the queue is empty (a first run, for example) it runs first instead, so that run has postings to check. Resumes from a checkpoint if it ran out of time. | → `data/pipeline.md` |

Every step's start, end and duration go to `data/board.log` in your data folder.

**How prep ranks the queue.** Titles are sorted into tiers using the
`auto_scan.ranking` lists in `config/profile.yml`:

- tier 1: an entry-level word (`entry_level_titles`, e.g. "Engineer I", "New
  Grad") *and* a discipline word (`discipline_titles`);
- tier 2: a discipline word only;
- tier 3: everything else;
- tier 4: employers that discovery logged as skipped (off-industry) in
  `data/auto-scan-companies.log`.

Within a tier, employers listed in `big_employers` go last and newer postings
go first. With no discipline list, every title counts as in-discipline.

**What prep flags.** Without any AI it scans each job description for:
years-of-experience asks, degree restrictions outside your field, start-date
wording, security clearance, GPA cut-offs, non-day shifts, and internship or
co-op wording. Flags appear on the queue page and in the digest the judge reads.

**Liveness.** Every posting is checked before it reaches you (`check-liveness.mjs`):
ATS APIs first, then a headless browser for pages that need one. Expired signals
win over a generic "Apply" button, so closed postings don't slip through.

### The judge step

The judge is the only step that can cost money. Choose it in
`config/board.yml` (`judge:`) or per run with `--judge <name>`.

| Judge | How it runs | Needs |
|-------|-------------|-------|
| `none` | No evaluation. You get the ranked, verified, flagged queue page. | Nothing |
| `claude` | One `claude -p` session reads `data/auto/digest.md`, your CV and profile, and writes `data/auto/judgments.json`. `auto/gen.mjs` then turns that into full A–G reports with zero tokens. | Claude Code CLI, logged in |
| `openrouter` | `openrouter-runner.mjs`, one posting per call. | `OPENROUTER_API_KEY` in `.env` |
| `gemini` | `gemini-eval.mjs`, one posting per call. | `GEMINI_API_KEY` in `.env` |
| `ollama` | `ollama-eval.mjs` against a local model; private and free. | `ollama serve` running with a model |
| `openai` | `openai-eval.mjs` against any OpenAI-compatible endpoint. | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |

API judges evaluate at most `max_evaluations` postings per run, so cost stays
predictable. Postings a judge doesn't reach stay *Pending* for the next run.

Whatever the judge, the bookkeeping is the same: each evaluated posting gets a
numbered report in `reports/` (score, archetype, requirement-by-requirement
match against `cv.md`, gaps, legitimacy, a cover-letter draft and the job
description archived verbatim), a row is merged into `data/applications.md`
through `merge-tracker.mjs` (deduplicated by posting URL), and the posting
moves to *Processed* in `data/pipeline.md`.

Safety rails in the `claude` path (`auto/gen.mjs`): cover-letter "key
achievement" bullets are rejected unless they appear word for word in
`cv.md`, report numbers are reserved atomically, and the job description is
copied from the downloaded file, never retyped by the model. No tailored CV or
PDF is ever generated automatically.

### What you look at

- **`output/career-dashboard.html`** — the job board. One self-contained file:
  open it in any browser or copy it anywhere. It lists every evaluated role with
  score, location, pay, flags and a link to the report and posting. Mark roles
  Interested / Applied / Interviewing / Offer / Rejected / Not interested; that
  tracking is saved in the browser you used. Its title and subtitle come from
  `auto_scan.board` in `config/profile.yml`.
- **`output/queue.html`** — live postings that are still waiting, with prep's
  flags. With `judge: none` this is your main view.
- **`reports/NNN-company-role-date.md`** — the full evaluation for one role.
- **`data/applications.md`** — the tracker, one row per role. Change a status
  with `node set-status.mjs <report#|company> <State>` rather than by hand.

### Files you edit to tune it

All of these live in your data folder except `config/board.yml` and `.env`.

| File | Controls |
|------|----------|
| `cv.md` | Everything an evaluation or cover letter may claim about you. |
| `config/profile.yml` | Name, contact, location, comp targets, and the `auto_scan:` block: board title, candidate facts (graduation year, earliest start, degree fields), ranking lists, pre-screen rules, which new employers discovery may add. Every key is optional; see `config/profile.example.yml`. |
| `modes/_profile.md` | Your archetypes and narrative, which the scoring uses. |
| `modes/_custom.md` | Your own house rules for any mode (optional). |
| `portals.yml` | Companies to scan, `title_filter` (positive/negative keywords), `location_filter`. |
| `config/board.yml` (checkout) | Judge, `prep_count`, `max_evaluations`, which steps run, sweep settings, time limits, auto-open. See `config/board.example.yml`. |
| `.env` (checkout) | API keys for the judges. Never committed. |

Useful one-off flags: `--judge none`, `--n 20` (postings to prep),
`--max 5` (postings to judge), `--no-scan`, `--no-recheck`, `--sweep`,
`--build-only`, `--open`.

### Running it every day

In the app, turn on **Search every day** and pick a time. To do it by hand,
schedule the one command; it takes care of the rest. Examples (see
[docs/AUTOMATION.md](docs/AUTOMATION.md) for more):

```bash
# macOS / Linux (crontab -e), every day at 6am
0 6 * * * cd /path/to/career-ops-portable && /usr/local/bin/node board.mjs > /dev/null 2>&1
```

```powershell
# Windows Task Scheduler, every day at 6am
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "board.mjs" -WorkingDirectory "C:\path\to\career-ops-portable"
$trigger = New-ScheduledTaskTrigger -Daily -At 6am
Register-ScheduledTask -TaskName "career-ops board" -Action $action -Trigger $trigger
```

The log is in `data/board.log` in your data folder either way.

### Using it with an AI CLI (optional)

Everything above runs without AI except the judge. If you also use Claude Code,
Codex, OpenCode, Gemini CLI or similar in this checkout, the agent reads
`AGENTS.md` and can run the interactive modes on top of the same data folder:
paste a job URL for a full evaluation, `pdf` for a tailored CV, `cover`,
`interview-prep`, `contacto`, `apply` (fills forms, never submits) and the rest
of the modes in `AGENTS.md`. The agent follows the same rules: it reads and
writes your data folder, never invents facts that are not in `cv.md`, and
never submits an application without you.

In Claude Code the modes are slash commands (`/career-ops scan`). In Codex,
slash commands are not guaranteed, so ask in plain language ("Run the
career-ops pdf mode for the latest evaluated role") or run one-shot with
`codex exec "..."`; see [docs/CODEX.md](docs/CODEX.md) and `CODEX.md`.

### Keeping it up to date

The engine and your data are separate, so updating is just **Check for
updates** in the app, or in a terminal:

```bash
cd career-ops-portable && git pull && npm install
```

Your data folder is never touched. Don't run `node update-system.mjs apply`
here: it updates from the upstream career-ops project, which doesn't have the
portable board, setup or judges. If you used career-ops before with your
files inside the checkout, `npm run move-data` moves them into a data folder
(use `--dry-run` first to see the list).

### Troubleshooting

- **Double-clicking Start does nothing, or a window flashes and closes**: on
  Windows, right-click the `.bat` file and choose **Open**; on a Mac, see
  [the first start](#the-first-start-windows-and-mac-warnings). If a window
  stays open with an error, the message says what is missing.
- **The browser didn't open**: open `http://127.0.0.1:4747` yourself (the
  launcher window prints the exact address).
- **"Career-Ops is not running"** in the page: the launcher window was closed.
  Double-click Start again.
- **The first start stops during the install**: it needs internet. Start it
  again; it continues where it left off. On Linux the browser install may ask
  for your password to add system libraries.
- **My CV came out jumbled**: fix it in the box on the CV screen (first line
  your name, sections starting with `##`), or paste the text instead of
  uploading the file.

- **"setup isn't finished"** when running the board: a required file is
  missing from the data folder. Run `npm run setup` again; it keeps what exists.
- **The board is empty**: with `judge: none` the board only lists evaluated
  roles; look at `output/queue.html`. Otherwise check `data/board.log` for a
  step that failed or hit its time limit.
- **Few or no postings**: widen `title_filter.positive` and
  `location_filter` in `portals.yml`, enable the sweep (`--sweep` or
  `sweep.enabled: true`), or raise `sweep.since_days`.
- **Wrong data folder**: `npm run doctor` prints the folder in use ("Data folder: ..."); check
  `CAREER_OPS_DATA_DIR` and the `.career-ops-data` file.
- **Judge did nothing**: `npm run setup` re-detects what is available; an API
  key with a placeholder value counts as missing.

## Credits and license

Career-Ops Portable is built on [career-ops](https://github.com/career-ops-hq/career-ops)
by [Santiago Fernández de Valderrama](https://santifer.io), released under the
[MIT License](LICENSE). This version adds the double-click launchers, the
browser setup wizard, the daily job board and the separate data folder.

It is a local tool, not a hosted service. AI reviews are suggestions and can be
wrong, so check anything before you send it, and use job sites within their
terms. Full details: [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md).
