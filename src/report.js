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
    ['.recording.xml', 'Recording (full bodies, secrets scrubbed)'],
    ['_secrets.json', 'Original secret values (gitignored)'],
    ['_data.csv', 'Synthesized data pool'],
    ['_parameters.json', 'Parameterization candidates'],
    ['_ghosts.json', 'Client-side (ghost) values'],
    ['_polling.json', 'Detected polling loops'],
    ['_llm_suggestions.json', 'LLM fix suggestions'],
    ['_java_safe_generate.json', 'Generated JMX Java-safe compatibility report'],
    ['_run_status.json', 'Validation attempt status'],
    ['_baseline_diff.json', 'Baseline vs test diff (status / length / shape)'],
    ['_memory_matches.json', 'Verified learning memory matches'],
    ['_memory_patches.json', 'Verified learning memory patches'],
    ['_learned_lessons.json', 'Lessons saved after green verification'],
    ['_reasoning.md', 'Reasoning trace'],
    ['_reasoning.json', 'Reasoning trace (structured)'],
    ['_report.json', 'Raw report (JSON)'],
    ['log.txt', 'Run log'],
];

function statCard(label, value) {
    return `<div class="card"><div class="num">${esc(value)}</div><div class="lbl">${esc(label)}</div></div>`;
}

/**
 * @param outDir folder the run wrote into
 * @param name   base name
 * @param data   { mode, verdict, stats, samples, baselineDiff?, memoryMatches?, learnedLessons?, correlations?, dualHar?, loadProfile?, reasoning?, businessVerification? }
 */
function writeHtmlReport(outDir, name, data = {}) {
    const {
        mode = 'generate', verdict = 'generated', stats = {}, samples = [],
        baselineDiff = null, memoryMatches = [], learnedLessons = null, correlations = [], dualHar = null, loadProfile = null, reasoning = [], businessVerification = null,
    } = data;
    const reqs = (samples || []).filter(s => !s.isTransaction);
    const passed = reqs.filter(s => s.success).length;
    const failures = reqs.filter(s => s.success === false);

    const verdictClass = verdict === 'GREEN' ? 'ok' : (verdict === 'generated' ? 'neutral' : 'bad');

    const cards = [
        statCard('Samplers', stats.samplers ?? '–'),
        statCard('Correlations', stats.correlations ?? '–'),
        statCard('Parameterized', stats.parameterized ?? '–'),
        statCard('Native extractors', stats.nativeExtractorsPlanned ?? '–'),
        statCard('Ghost synths', stats.ghostSynthesizers ?? stats.clientSideGhosts ?? '–'),
        statCard('Polling loops', stats.whileControllers ?? stats.pollingLoops ?? '–'),
        statCard('Assertions', stats.assertions ?? '–'),
        statCard('Pacing timers', stats.pacingTimers ?? '–'),
        statCard('Orphans', stats.orphans ?? '–'),
    ].join('');

    const reqRows = reqs.length ? reqs.map(s => `
        <tr class="${s.success ? 'ok' : 'bad'}">
            <td>${s.success ? '✓' : '✗'}</td>
            <td>${esc(s.label || s.name || '')}</td>
            <td>${esc(s.responseCode || '')}</td>
            <td>${esc(s.responseMessage || s.failureMessage || '')}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="muted">No request results (generate-only, or run did not execute).</td></tr>`;

    const businessSection = businessVerification ? `<h2>Business verification</h2>
      <p><span class="badge ${businessVerification.ok ? 'ok' : 'bad'}">${businessVerification.ok ? 'PASSED' : 'NOT VERIFIED'}</span></p>
      <p>${esc(businessVerification.reason || '')}</p>
      ${businessVerification.protectedSamplers && businessVerification.protectedSamplers.length
        ? `<ul>${businessVerification.protectedSamplers.slice(0, 20).map(s => `<li>${esc(s.name)} <span class="muted">(${esc(s.reason || 'protected')})</span></li>`).join('')}</ul>`
        : ''}
      ${businessVerification.blockedDisables && businessVerification.blockedDisables.length
        ? `<p class="muted">Blocked disable attempts: ${esc(businessVerification.blockedDisables.map(s => s.sampler).slice(0, 8).join(', '))}</p>`
        : ''}` : '';

    const pointerItems = fs.readdirSync(outDir)
        .filter(file => file === '00_OPEN_THIS_FIRST.txt' || /^00_USE_THIS_.*\.jmx$/i.test(file))
        .sort()
        .map(file => `<li><a href="${esc(file)}">${esc(file)}</a> — ${file.endsWith('.jmx') ? 'Final JMX to open in JMeter' : 'Read this first'}</li>`)
        .join('');
    const artifactItems = pointerItems + ARTIFACTS
        .map(([suffix, desc]) => {
            const file = suffix === 'log.txt' ? 'log.txt' : `${name}${suffix}`;
            const full = path.join(outDir, file);
            return fs.existsSync(full) ? `<li><a href="${esc(file)}">${esc(file)}</a> — ${esc(desc)}</li>` : '';
        })
        .filter(Boolean).join('');

    // Dashboard link (jmeter -g produces dashboard/index.html)
    const dashLink = fs.existsSync(path.join(outDir, 'dashboard', 'index.html'))
        ? `<p><a href="dashboard/index.html">▸ Open JMeter HTML dashboard (full perf metrics)</a></p>`
        : '';

    // Load profile callout: what shape will this script actually drive?
    let loadProfileSection = '';
    if (loadProfile && (loadProfile.users || loadProfile.rampUpSec || loadProfile.holdSec || loadProfile.loops)) {
        const bits = [
            loadProfile.users     != null ? `${loadProfile.users} user${loadProfile.users === 1 ? '' : 's'}` : null,
            loadProfile.rampUpSec != null ? `ramp-up ${loadProfile.rampUpSec}s` : null,
            loadProfile.holdSec   != null ? `hold ${loadProfile.holdSec}s` : null,
            loadProfile.loops     != null ? `${loadProfile.loops} loop${loadProfile.loops === 1 ? '' : 's'}` : null,
        ].filter(Boolean);
        loadProfileSection = `<h2>Load profile</h2><p>${esc(bits.join(' · '))}</p>
            <p class="muted">Applied to the first Thread Group. ${loadProfile.holdSec ? 'A hold duration overrides finite loops (scheduler enabled).' : ''}</p>`;
    }

    // Correlation table: which variables came from where, and how. Counts
    // alone don't help a reviewer decide if the correlations are sound.
    let correlationSection = '';
    if (Array.isArray(correlations) && correlations.length) {
        const rows = correlations.slice(0, 200).map(c => {
            const variable = c.variableName || c.refname || c.name || c.value || '?';
            const source = c.sourceUrl || c.source || c.sourceSampler || (c.origin && (c.origin.sampler || c.origin.label)) || '?';
            const sink   = c.targetUrl || c.sink || c.targetSampler || c.location || '';
            const type   = c.extractorType || c.type || c.kind || '';
            const conf   = (c.confidence != null) ? Number(c.confidence).toFixed(2) : '';
            return `<tr><td><code>${esc(variable)}</code></td><td>${esc(source)}</td><td>${esc(sink)}</td><td>${esc(type)}</td><td>${esc(conf)}</td></tr>`;
        }).join('');
        const note = correlations.length > 200 ? `<p class="muted">Showing first 200 of ${correlations.length}.</p>` : '';
        correlationSection = `<h2>Correlations (${correlations.length})</h2>
            <table><thead><tr><th>Variable</th><th>Source</th><th>Sink</th><th>Type</th><th>Confidence</th></tr></thead>
            <tbody>${rows}</tbody></table>${note}`;
    }

    // Dual-recording dynamics panel: the Phase 1 signal everyone wants but
    // never sees. Lists every value that differed across the two runs and
    // where it surfaced — the reviewer's primary scan for "is this script
    // safe to run repeatedly?"
    let dualHarSection = '';
    if (dualHar && dualHar.dynamicsByName && Object.keys(dualHar.dynamicsByName).length) {
        const names = Object.entries(dualHar.dynamicsByName).slice(0, 100);
        const rows = names.map(([n, list]) => {
            const sample = list[0] || {};
            const where = sample.location || (sample.origin && sample.origin.location) || '';
            return `<tr><td><code>${esc(n)}</code></td><td>${esc(String(sample.value1 || '').slice(0, 60))}</td><td>${esc(String(sample.value2 || '').slice(0, 60))}</td><td>${esc(where)}</td><td>${list.length}</td></tr>`;
        }).join('');
        const truncated = Object.keys(dualHar.dynamicsByName).length > 100
            ? `<p class="muted">Showing first 100 of ${Object.keys(dualHar.dynamicsByName).length}.</p>` : '';
        dualHarSection = `<h2>Dual-recording dynamics (${dualHar.dynamicValueCount || 0} unique values)</h2>
            <p class="muted">Values that differed between the two recorded runs of ${esc(dualHar.run2File || 'run2')}. These are the highest-confidence dynamic-parameter candidates.</p>
            <table><thead><tr><th>Name</th><th>Run 1</th><th>Run 2</th><th>Where</th><th>Hits</th></tr></thead>
            <tbody>${rows}</tbody></table>${truncated}`;
    }

    // Reasoning trace summary (one row per phase/action). Full text lives in
    // the .md / .json artifacts; this panel just gives a reviewer the gist.
    let reasoningSection = '';
    if (Array.isArray(reasoning) && reasoning.length) {
        const rows = reasoning.slice(0, 30).map(r =>
            `<tr><td>${esc(r.phase)}</td><td>${esc(r.hypothesis)}</td><td>${esc(r.action)}</td></tr>`
        ).join('');
        const truncated = reasoning.length > 30 ? `<p class="muted">Showing first 30 of ${reasoning.length} reasoning step(s).</p>` : '';
        reasoningSection = `<h2>Reasoning</h2>
            <table><thead><tr><th>Phase</th><th>Hypothesis</th><th>Action</th></tr></thead>
            <tbody>${rows}</tbody></table>${truncated}`;
    }

    // Baseline diff section: surface drift the status-only verdict misses
    let driftSection = '';
    if (baselineDiff && baselineDiff.samplesCompared > 0) {
        if (baselineDiff.drift.length === 0) {
            driftSection = `<h2>Baseline vs test</h2><p class="muted">${baselineDiff.samplesCompared} sampler(s) compared — no drift (status, body length, JSON shape all match recording).</p>`;
        } else {
            const rows = baselineDiff.drift.map(d => `
                <tr><td>${esc(d.sampler)}</td><td>${d.issues.map(i =>
                    i.kind === 'statusDiff' ? `status ${i.recorded}→${i.observed}` :
                    i.kind === 'lengthDriftPct' ? `body ${i.recorded}B→${i.observed}B (${i.pct}%)` :
                    i.kind === 'shapeDiff' ? `JSON shape changed` : esc(JSON.stringify(i))
                ).join(', ')}</td></tr>`).join('');
            driftSection = `<h2>Baseline vs test — drift on ${baselineDiff.drift.length}/${baselineDiff.samplesCompared}</h2>
                <table><thead><tr><th>Sampler</th><th>Drift</th></tr></thead><tbody>${rows}</tbody></table>
                <p class="muted">Drift means the live response did not match what the recording captured. "200 OK" alone can hide login pages returned in place of dashboards, empty lists in place of data, etc.</p>`;
        }
    }

    let learningSection = '';
    const matchRows = Array.isArray(memoryMatches) && memoryMatches.length
        ? memoryMatches.slice(0, 25).map(m => `<tr><td>${esc(m.lessonId)}</td><td>${esc(m.confidence)}</td><td>${esc(m.contextPattern && m.contextPattern.samplerPattern)}</td><td><code>${esc(m.fix && m.fix.kind)}</code></td></tr>`).join('')
        : '';
    const learned = learnedLessons && Array.isArray(learnedLessons.learned) ? learnedLessons.learned : [];
    if (matchRows || learned.length) {
        const learnedRows = learned.slice(0, 25).map(l => `<tr><td>${esc(l.id)}</td><td>${esc(l.confidence)}</td><td>${esc(l.contextPattern && l.contextPattern.samplerPattern)}</td><td><code>${esc(l.fix && l.fix.kind)}</code></td></tr>`).join('');
        learningSection = `<h2>Verified learning store</h2>
            ${matchRows ? `<p class="muted">Previously verified, redacted lessons considered before AI escalation.</p>
            <table><thead><tr><th>Lesson</th><th>Confidence</th><th>Pattern</th><th>Fix</th></tr></thead><tbody>${matchRows}</tbody></table>` : ''}
            ${learnedRows ? `<p class="muted">New lessons saved only after this run verified green.</p>
            <table><thead><tr><th>Lesson</th><th>Confidence</th><th>Pattern</th><th>Fix</th></tr></thead><tbody>${learnedRows}</tbody></table>` : ''}`;
    }

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

  ${loadProfileSection}

  ${dashLink}

  ${businessSection}

  <h2>Request results</h2>
  <table><thead><tr><th></th><th>Sampler</th><th>Code</th><th>Message</th></tr></thead>
  <tbody>${reqRows}</tbody></table>

  ${failures.length ? `<h2>Failures (${failures.length})</h2><ul>${failures.map(f => `<li><b>${esc(f.label || f.name)}</b> — ${esc(f.responseCode || '')} ${esc(f.responseMessage || f.failureMessage || '')}</li>`).join('')}</ul>` : ''}

  ${dualHarSection}

  ${correlationSection}

  ${reasoningSection}

  ${driftSection}

  ${learningSection}

  <h2>Artifacts</h2>
  <ul>${artifactItems || '<li class="muted">none</li>'}</ul>
</body></html>`;

    const out = path.join(outDir, `${name}_report.html`);
    fs.writeFileSync(out, html);
    return out;
}

module.exports = { writeHtmlReport };
