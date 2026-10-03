// judges/index.mjs — the pluggable "judge" step of `npm run board`.
//
// Everything before the judge (scan, prep, recheck) and after it (dashboard)
// is zero-token. The judge is the one step that reads job descriptions with a
// model, so it is the one step users choose: config/board.yml `judge:`.
//
// Contract: a judge receives the prep batch (batch.json: ranked, liveness-
// checked postings with JD text on disk) and leaves behind reports/ +
// tracker additions merged into data/applications.md, with the postings it
// handled moved from Pending to Processed in data/pipeline.md. Postings it
// does not handle stay Pending for the next run.

import { runClaudeJudge } from './claude.mjs';
import { runSingleJdJudge } from './single-jd.mjs';

export async function runJudge(name, ctx) {
  switch (name) {
    case 'none': return { evaluated: 0, note: 'judge: none (no model call)' };
    case 'claude': return runClaudeJudge(ctx);
    case 'openrouter':
    case 'gemini':
    case 'ollama':
    case 'openai':
      return runSingleJdJudge(name, ctx);
    default: throw new Error(`unknown judge "${name}"`);
  }
}
