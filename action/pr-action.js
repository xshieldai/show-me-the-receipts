#!/usr/bin/env node
// GitHub Action entry: grade a pull request's description. Exit 1 when a claim fails (see fail-on).

import { appendFileSync, readFileSync } from 'node:fs';
import { gradePullRequest, MARKER, renderMarkdown, shouldFail } from '../src/pr.js';

const env = process.env;

async function main() {
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    console.error('show-me-the-receipts refuses to run on pull_request_target: it would run code from a fork with a write token and secrets. Use the pull_request trigger.');
    return 1;
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.log('Not a pull request event: nothing to check.');
    return 0;
  }
  const repo = env.GITHUB_WORKSPACE || process.cwd();
  const report = gradePullRequest({ body: pr.body ?? '', repo, base: pr.base?.sha, head: 'HEAD' });
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const md = renderMarkdown(report, { runUrl });

  console.log(md.replace(MARKER, '').trim());
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');

  if ((env.INPUT_COMMENT ?? 'true') === 'true' && env.INPUT_TOKEN) {
    const note = await upsertComment({ token: env.INPUT_TOKEN, api: env.GITHUB_API_URL || 'https://api.github.com', repoName: env.GITHUB_REPOSITORY, number: pr.number, body: md });
    console.log(note);
  }
  const fail = shouldFail(report.results, env.INPUT_FAIL_ON || 'false');
  if (fail) console.error('A claim in the pull request description does not hold (see the receipts above).');
  return fail ? 1 : 0;
}

// One comment per pull request, updated in place. A fork's read-only token cannot comment: then the summary is the record.
async function upsertComment({ token, api, repoName, number, body }) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'show-me-the-receipts' };
  try {
    const list = await fetch(`${api}/repos/${repoName}/issues/${number}/comments?per_page=100`, { headers });
    if (!list.ok) return `Could not read comments (HTTP ${list.status}); the job summary holds the receipts.`;
    const mine = (await list.json()).find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    const res = mine
      ? await fetch(`${api}/repos/${repoName}/issues/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
      : await fetch(`${api}/repos/${repoName}/issues/${number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
    return res.ok ? `Receipts ${mine ? 'updated in' : 'posted to'} the pull request.` : `Could not comment (HTTP ${res.status}, a fork's token is read-only); the job summary holds the receipts.`;
  } catch (err) {
    return `Could not comment (${err.message}); the job summary holds the receipts.`;
  }
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(`show-me-the-receipts broke: ${err.message}`); process.exitCode = 3; });
