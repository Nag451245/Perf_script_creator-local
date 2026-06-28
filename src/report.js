'use strict';
/**
 * report.js — a standalone, browser-openable HTML summary per run.
 *
 * No engine module emits a reusable HTML report, so this is self-contained.
 * It stays decoupled by scanning the output folder for known artifacts and
 * linking them, rather than threading every detail through the call chain.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ARTIFACTS = [
    ['.jmx', 'JMeter script'],
    ['.recording.xml', 'Recording (full bodies)'],
    ['_data.csv', 'Synthesized data pool'],
    ['_parameters.json', 'Parameterization candidates'],
    ['_ghosts.json', 'Client-side (ghost) values'],
    ['_polling.json', 'Detected polling loops'],
    ['_llm_suggestions.json', 'LLM fix suggestions'],
    ['_report.json', 'Raw report (JSON)'],
    ['log.txt', 'Run log'],
];

function statCard(label, value) {
    return `<div class="card"><div class="num">${esc(value)}</div><div class="lbl">${esc(label)}</div></div>`;
}

/**
 * @param outDir folder the run wrote into
 * @param name   base name
 * @param data   { mode, verdict, stats, samples }
 */
function writeHtmlReport(outDir, name, data = {}) {
    const { mode = 'generate', verdict = 'generated', stats = {}, samples = [] } = data;
    const reqs = (samples || []).filter(s => !s.isTransaction);
    const passed = reqs.filter(s => s.success).length;
    const failures = reqs.filter(s => s.success === false);

    const verdictClass = verdict === 'GREEN' ? 'ok' : (verdict === 'generated' ? 'neutral' : 'bad');

    const cards = [
        statCard('Samplers', stats.samplers ?? '–'),
        statCard('Correlations', stats.correlations ?? '–'),
        statCard('Parameterized', stats.parameterized ?? '–'),
        statCard('Ghost values', stats.clientSideGhosts ?? '–'),
        statCard('Polling loops', stats.pollingLoops ?? '–'),
        statCard('Orphans', stats.orphans ?? '–'),
    ].join('');

    const reqRows = reqs.length ? reqs.map(s => `
        <tr class="${s.success ? 'ok' : 'bad'}">
            <td>${s.success ? '✓' : '✗'}</td>
            <td>${esc(s.label || s.name || '')}</td>
            <td>${esc(s.responseCode || '')}</td>
            <td>${esc(s.responseMessage || s.failureMessage || '')}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="muted">No request results (generate-only, or run did not execute).</td></tr>`;

    const artifactItems = ARTIFACTS
        .map(([suffix, desc]) => {
            const file = suffix === 'log.txt' ? 'log.txt' : `${name}${suffix}`;
            const full = path.join(outDir, file);
            return fs.existsSync(full) ? `<li><a href="${esc(file)}">${esc(file)}</a> — ${esc(desc)}</li>` : '';
        })
        .filter(Boolean).join('');

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>perfscript-local — ${esc(name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa0a6; margin-bottom: 20px; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; }
  .badge.ok { background: #123d1f; color: #5fd98a; } .badge.bad { background: #4a1d1d; color: #ff8a8a; }
  .badge.neutral { background: #25303f; color: #8fb6e0; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 24px; }
  .card { background: #1a1e26; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px 18px; min-width: 110px; }
  .card .num { font-size: 24px; font-weight: 700; } .card .lbl { color: #9aa0a6; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #242a34; font-size: 13px; }
  th { color: #9aa0a6; font-weight: 600; }
  tr.ok td:first-child { color: #5fd98a; } tr.bad td:first-child { color: #ff8a8a; }
  tr.bad { background: #2a1414; }
  .muted { color: #9aa0a6; } a { color: #8fb6e0; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-top: 1px solid #242a34; padding-top: 16px; }
  ul { margin: 8px 0; padding-left: 20px; } li { margin: 4px 0; }
</style></head>
<body>
  <h1>perfscript-local · ${esc(name)}</h1>
  <div class="sub">mode: ${esc(mode)} · generated ${esc(new Date().toLocaleString())} ·
    verdict: <span class="badge ${verdictClass}">${esc(verdict)}</span>
    ${reqs.length ? ` · ${passed}/${reqs.length} requests passed` : ''}</div>

  <div class="grid">${cards}</div>

  <h2>Request results</h2>
  <table><thead><tr><th></th><th>Sampler</th><th>Code</th><th>Message</th></tr></thead>
  <tbody>${reqRows}</tbody></table>

  ${failures.length ? `<h2>Failures (${failures.length})</h2><ul>${failures.map(f => `<li><b>${esc(f.label || f.name)}</b> — ${esc(f.responseCode || '')} ${esc(f.responseMessage || f.failureMessage || '')}</li>`).join('')}</ul>` : ''}

  <h2>Artifacts</h2>
  <ul>${artifactItems || '<li class="muted">none</li>'}</ul>
</body></html>`;

    const out = path.join(outDir, `${name}_report.html`);
    fs.writeFileSync(out, html);
    return out;
}

module.exports = { writeHtmlReport };
