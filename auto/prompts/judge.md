Run the career-ops pipeline evaluation for this scheduled run. Before this
prompt ran, the wrapper already did every mechanical step at zero token cost:
`node scan.mjs` (all portals.yml providers) and `node auto/prep.mjs`
(the reverse ATS sweep runs AFTER you finish; its matches from earlier runs
are already in the queue), which ranked the Pending
queue, liveness-checked the top of it, moved expired postings to Processed,
saved each live JD to data/auto/jd/NN.txt, and wrote data/auto/digest.md.
Do NOT redo any of that: do not run scan.mjs, check-liveness, fetch-jd, or
re-rank; do not read data/pipeline.md or the scan-history.

Paths: data files (data/, cv.md, modes/_profile.md, modes/_custom.md,
portals.yml, reports/) are relative to the data root {{data_root}}, which
is your working directory. Engine scripts (auto/*.mjs, discover-ats.mjs)
live in {{engine}}.

Token discipline (the candidate asked for minimum tokens at near-current
fidelity): read files once; never cat whole mode files -- the rules you need
are below plus modes/_profile.md, modes/_custom.md and cv.md. Never print a
whole JD to the console; open data/auto/jd/NN.txt only for postings that
survive the pre-screen, and only when the digest excerpt is not enough.
Work inline in this single turn -- no background subagents, no wakeup tools.

Steps:
1. Read data/auto/digest.md, cv.md, modes/_profile.md, modes/_custom.md, and
   data/auto/judgment.example.json (the exact shape of one evaluated job).
2. Pre-screen every digest item. Discard (one-line reason) when the JD
   {{discard_criteria}}. The regex flags are hints only -- confirm in the
   excerpt. Items marked NO JD TEXT: discard as "JD unavailable" only if the
   excerpt is empty too.
3. For survivors, do the full A-G evaluation and write ONE file,
   data/auto/judgments.json:
   {"discards": {"NN": "reason"}, "jobs": [ ...one object per survivor in
   the judgment.example.json shape, "n" = digest number... ],
   "newStories": {"key": [title, S, T, A, R, reflection]} (only if needed)}
   Story keys come from data/auto/library.json. coverBullets must be copied
   verbatim from cv.md (the generator refuses anything else). Never invent
   metrics, tools or authorship not in cv.md.
4. Run `node {{engine}}/auto/gen.mjs`. It reserves report numbers, writes the full
   reports (JD archived verbatim from disk), tracker TSVs (PDF ❌), moves the
   items in pipeline.md, runs merge-tracker.mjs and verify-pipeline.mjs. If it
   rejects judgments.json, fix only the listed fields and re-run.
5. Do NOT try to sync the job board or republish it: headless sessions have
   no Artifact tools. The wrapper hands that to a background session after
   you finish (tracking sync, board rebuild, republish). Just finish step 4.

Do NOT generate any tailored CV, CV HTML, or CV PDF (the candidate tailors
CVs personally; see modes/_custom.md).

{{discovery}}

This is unattended: for anything that would need the candidate's answer
(blacklist hit, agency reveal, knock-out ambiguity), skip that item with a
logged reason. Never submit, apply, or fill a live application form.

Final summary (short): reports written with scores, discards count, companies
added/skipped, items still pending. Then stop.
