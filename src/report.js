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
const peNaming = require('./pe-naming');

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
    ['_label_map.json', 'PE sampler label map (SC/T prefixes back to Step NN)'],
    ['_file_uploads.json', 'Multipart upload files detected, staged, or missing'],
    ['_llm_suggestions.json', 'LLM fix suggestions'],
    ['_java_safe_generate.json', 'Generated JMX Java-safe compatibility report'],
    ['_run_status.json', 'Validation attempt status'],
    ['_baseline_diff.json', 'Baseline vs test diff (status / length / shape)'],
    ['_failure_forensics.json', 'Failure forensics ledger and recommended action'],
    ['_failure_forensics.md', 'Failure forensics summary (Markdown)'],
    ['_request_adjudication.json', 'Post-run request adjudication decisions'],
    ['_final_green_gate.json', 'Final green gate verdict'],
    ['_senior_pe_debrief.json', 'Senior performance engineering debrief'],
    ['_senior_pe_debrief.md', 'Senior performance engineering debrief (Markdown)'],
    ['_domain_profile.json', 'Domain, stack, SLO, and memory-scope profile'],
    ['_pe_analysis.json', 'Senior PE failure and flow-intent analysis'],
    ['_pe_analysis.md', 'Senior PE failure and flow-intent analysis (Markdown)'],
    ['_ai_strategy.json', 'Bounded senior PE AI strategy'],
    ['_human_questions.md', 'Targeted human questions from senior PE analysis'],
    ['_evidence_citations.json', 'Evidence citations for senior PE strategy'],
    ['_blockers.json', 'Terminal blockers requiring human input'],
    ['_blockers.md', 'Terminal blockers requiring human input (Markdown)'],
    ['_blueprint_context.json', 'Blueprint agent phase context'],
    ['_lineage.json', 'Blueprint dynamic producer-to-consumer lineage'],
    ['_repair_rounds.json', 'Blueprint closed-loop repair rounds'],
    ['_correlation_hypotheses.json', 'Verified correlation hypotheses and proof'],
    ['_correlation_hypothesis_validation.json', 'Verified correlation schema validation'],
    ['_correlation_fast_repair.json', 'Verified correlation fast-replay proof'],
    ['_correlation_patches.json', 'Verified correlation JMX patch application'],
    ['_fast_repair_rounds.json', 'Fast-replay repair hypothesis rounds'],
    ['_memory_matches.json', 'Verified fix memory matches'],
    ['_memory_patches.json', 'Verified learning memory patches'],
    ['_learned_lessons.json', 'Verified fix memory saved after green verification'],
    ['_reasoning.md', 'Reasoning trace'],
    ['_reasoning.json', 'Reasoning trace (structured)'],
    ['_report.json', 'Raw report (JSON)'],
    ['log.txt', 'Run log'],
];

function statCard(label, value) {
    return `<div class="card"><div class="num">${esc(value)}</div><div class="lbl">${esc(label)}</div></div>`;
}

function firstNumeric(...vals) {
    for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    const rank = (p / 100) * (sortedAsc.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sortedAsc[lo];
    return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo));
}

// Performance + SLO scorecard. Pass/error rate always render (from success
// flags); latency percentiles render only when samples carry a numeric elapsed
// time, so we never fabricate timings. An optional SLO object
// ({ p95Ms, errorRatePct, avgMs }) is scored PASS/FAIL against the observed run.
function buildPerformanceSummary(reqs, slo) {
    if (!reqs || !reqs.length) return '';
    const total = reqs.length;
    const passed = reqs.filter(s => s.success).length;
    const errorRatePct = Math.round(((total - passed) / total) * 1000) / 10;
    const latencies = reqs
        .map(s => firstNumeric(s.elapsed, s.time, s.t, s.latency, s.responseTime))
        .filter(n => n != null && n >= 0)
        .sort((a, b) => a - b);

    const cells = [statCard('Requests', total), statCard('Pass rate', `${Math.round((passed / total) * 1000) / 10}%`), statCard('Error rate', `${errorRatePct}%`)];
    let p95 = null; let avg = null;
    if (latencies.length) {
        avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        p95 = percentile(latencies, 95);
        cells.push(statCard('Avg ms', avg));
        cells.push(statCard('p90 ms', percentile(latencies, 90)));
        cells.push(statCard('p95 ms', p95));
        cells.push(statCard('p99 ms', percentile(latencies, 99)));
        cells.push(statCard('Max ms', latencies[latencies.length - 1]));
    }

    let sloRows = '';
    if (slo && typeof slo === 'object') {
        const checks = [];
        if (slo.errorRatePct != null) checks.push(['Error rate', `${errorRatePct}%`, `<= ${slo.errorRatePct}%`, errorRatePct <= Number(slo.errorRatePct)]);
        if (slo.p95Ms != null && p95 != null) checks.push(['p95 latency', `${p95} ms`, `<= ${slo.p95Ms} ms`, p95 <= Number(slo.p95Ms)]);
        if (slo.avgMs != null && avg != null) checks.push(['Avg latency', `${avg} ms`, `<= ${slo.avgMs} ms`, avg <= Number(slo.avgMs)]);
        if (checks.length) {
            sloRows = `<h3>SLO scorecard</h3><table><thead><tr><th>Objective</th><th>Observed</th><th>Target</th><th>Result</th></tr></thead><tbody>${
                checks.map(([k, obs, target, ok]) => `<tr class="${ok ? 'ok' : 'bad'}"><td>${esc(k)}</td><td>${esc(obs)}</td><td>${esc(target)}</td><td><span class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'}</span></td></tr>`).join('')
            }</tbody></table>`;
        }
    }
    const latencyNote = latencies.length ? '' : '<p class="muted">Latency percentiles need per-sample timing; run with response results to populate them.</p>';
    return `<h2>Performance summary</h2><div class="grid">${cells.join('')}</div>${latencyNote}${sloRows}`;
}

function firstPresent(...values) {
    return values.find(v => v !== undefined && v !== null && String(v) !== '');
}

function stepLabel(index) {
    const n = Number(index);
    return Number.isFinite(n) ? `Step ${String(n + 1).padStart(2, '0')}` : '';
}

/**
 * @param outDir folder the run wrote into
 * @param name   base name
 * @param data   { mode, verdict, stats, samples, baselineDiff?, memoryMatches?, learnedLessons?, correlations?, dualHar?, loadProfile?, reasoning?, businessVerification? }
 */
function writeHtmlReport(outDir, name, data = {}) {
    const {
        mode = 'generate', verdict = 'generated', stats = {}, samples = [],
        baselineDiff = null, memoryMatches = [], learnedLessons = null, correlations = [], dualHar = null, loadProfile = null, reasoning = [], businessVerification = null, disableDecisions = null,
    } = data;
    const reqs = (samples || []).filter(s => !s.isTransaction);
    const passed = reqs.filter(s => s.success).length;
    const failures = reqs.filter(s => s.success === false);
    const performanceSummarySection = buildPerformanceSummary(reqs, data.slo || null);
    const failureForensics = data.failureForensics || readJsonIfExists(path.join(outDir, `${name}_failure_forensics.json`));
    const requestAdjudication = data.requestAdjudication || readJsonIfExists(path.join(outDir, `${name}_request_adjudication.json`));
    const labelMap = data.peNaming || readJsonIfExists(path.join(outDir, `${name}_label_map.json`));
    const decisionBySampler = buildDecisionMap(requestAdjudication || disableDecisions || data.samplerDecisions || (data.lineage && data.lineage.disableDecisions));

    const verdictClass = verdict === 'GREEN' ? 'ok' : (verdict === 'generated' ? 'neutral' : 'bad');

    const cards = [
        statCard('Samplers', stats.samplers ?? '–'),
        statCard('Correlations', stats.correlations ?? '–'),
        statCard('Parameterized', stats.parameterized ?? '–'),
        statCard('Native extractors', stats.nativeExtractorsPlanned ?? '–'),
        statCard('Ghost synths', stats.ghostSynthesizers ?? stats.clientSideGhosts ?? '–'),
        statCard('JSR223 stripped', stats.jsr223Stripped ?? '–'),
        statCard('Polling loops', stats.whileControllers ?? stats.pollingLoops ?? '–'),
        statCard('Assertions', stats.assertions ?? '–'),
        statCard('Pacing timers', stats.pacingTimers ?? '–'),
        statCard('Orphans', stats.orphans ?? '–'),
    ].join('');

    const reqRows = reqs.length ? reqs.map(s => `
        <tr class="${s.success ? 'ok' : 'bad'}">
            <td>${s.success ? '✓' : '✗'}</td>
            <td>${esc(firstPresent(s.transactionName, s.transaction, s.parentTransaction, ''))}</td>
            <td>${esc(s.label || s.name || '')}</td>
            <td>${esc(firstPresent(s.responseCode, s.code, s.rc, ''))}</td>
            <td>${esc(decisionForSampler(decisionBySampler, s.label || s.name))}</td>
            <td>${esc(firstPresent(s.responseMessage, s.message, s.failureMessage, ''))}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="muted">No request results (generate-only, or run did not execute).</td></tr>`;

    const businessSection = businessVerification ? `<h2>Business verification</h2>
      <p><span class="badge ${businessVerification.ok ? 'ok' : 'bad'}">${businessVerification.ok ? 'PASSED' : 'NOT VERIFIED'}</span></p>
      <p>${esc(businessVerification.reason || '')}</p>
      ${businessVerification.protectedSamplers && businessVerification.protectedSamplers.length
        ? renderBusinessSamplerList(businessVerification.protectedSamplers)
        : ''}
      ${businessVerification.blockedDisables && businessVerification.blockedDisables.length
        ? `<p class="muted">Blocked disable attempts: ${esc(businessVerification.blockedDisables.map(s => s.sampler).slice(0, 8).join(', '))}</p>`
        : ''}` : '';

    const pointerItems = fs.readdirSync(outDir)
        .filter(file => file === '00_OPEN_THIS_FIRST.txt' || /^00_USE_THIS_.*\.jmx$/i.test(file))
        .sort()
        .map(file => `<li><a href="${esc(file)}">${esc(file)}</a> — ${file.endsWith('.jmx') ? 'Final JMX to open in JMeter' : 'Read this first'}</li>`)
        .join('');
    const explicitArtifacts = [
        ['final.jtl', 'Current validation JTL'],
        [`evidence/${name}_label_map.json`, 'PE label map copy'],
        [`reports/${name}_report.html`, 'HTML report copy'],
        [`results/final.jtl`, 'Current JTL copy'],
    ].map(([file, desc]) => fs.existsSync(path.join(outDir, file)) ? `<li><a href="${esc(file)}">${esc(file)}</a> — ${esc(desc)}</li>` : '')
        .filter(Boolean).join('');
    const manifestItems = ['00_OUTPUT_INDEX.md', 'output_manifest.json']
        .map(file => fs.existsSync(path.join(outDir, file)) ? `<li><a href="${esc(file)}">${esc(file)}</a> — Output folder index and manifest</li>` : '')
        .filter(Boolean).join('');
    const artifactItems = pointerItems + manifestItems + explicitArtifacts + ARTIFACTS
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
            const source = firstPresent(c.sourceUrl, c.source, c.sourceSampler, c.producerSampler,
                c.origin && (c.origin.sampler || c.origin.label),
                stepLabel(firstPresent(c.sourceRequestIndex, c.producer))) || '';
            const sink   = firstPresent(c.targetUrl, c.sink, c.targetSampler, c.consumerSampler, c.location,
                stepLabel(firstPresent(c.targetRequestIndex, c.consumer))) || '';
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

    let failureForensicsSection = '';
    if (failureForensics && failureForensics.rootCause) {
        const root = failureForensics.rootCause;
        const missingCookies = failureForensics.authSession && failureForensics.authSession.missingSessionCookies || [];
        const interactiveAuthWall = !!(failureForensics.redirects && failureForensics.redirects.interactiveAuthWall);
        const downstreamGraphql = failureForensics.graphql && failureForensics.graphql.downstreamSymptoms || [];
        const downstreamDivergences = (failureForensics.divergences || []).filter(d => Number(d.index) > Number(root.index));
        const bodyComparison = failureForensics.bodyComparison || {};
        const action = failureForensics.recommendedAction && failureForensics.recommendedAction.id || 'review';
        failureForensicsSection = `<h2>Failure forensics</h2>
            <p>Earliest upstream failure: <b>${esc(root.sampler || '')}</b> recorded ${esc(root.recordedStatus ?? root.expected ?? '')}, observed ${esc(root.observedStatus ?? root.observed ?? '')}.</p>
            <ul>
                <li>Session-cookie proof: ${missingCookies.length ? esc(`missing ${missingCookies.join(', ')}`) : 'no missing session cookie proven'}</li>
                <li>Redirect/auth wall proof: ${interactiveAuthWall ? 'interactive auth redirect wall detected' : 'not detected'}</li>
                <li>Downstream casualties: ${esc(downstreamDivergences.length)} later divergence(s), ${esc(downstreamGraphql.length)} GraphQL/API auth symptom(s)</li>
                <li>Body comparison: ${bodyComparison.ran ? esc(`${bodyComparison.compared || 0} sampler(s) compared`) : esc(`not run: ${bodyComparison.reason || 'no body evidence'}`)}</li>
                <li>Recommended action: <code>${esc(action)}</code></li>
            </ul>
            <p class="muted">Full evidence: <a href="${esc(name)}_failure_forensics.json">JSON</a> · <a href="${esc(name)}_failure_forensics.md">Markdown</a></p>`;
    }

    const requestAdjudicationSection = renderRequestAdjudicationSection(requestAdjudication, name, outDir);

    let learningSection = '';
    const matchRows = Array.isArray(memoryMatches) && memoryMatches.length
        ? memoryMatches.slice(0, 25).map(m => `<tr><td>${esc(m.lessonId)}</td><td>${esc(m.confidence)}</td><td>${esc(m.contextPattern && m.contextPattern.samplerPattern)}</td><td><code>${esc(m.fix && m.fix.kind)}</code></td></tr>`).join('')
        : '';
    const learned = learnedLessons && Array.isArray(learnedLessons.learned) ? learnedLessons.learned : [];
    if (matchRows || learned.length || learnedLessons) {
        const learnedRows = learned.slice(0, 25).map(l => `<tr><td>${esc(l.id)}</td><td>${esc(l.confidence)}</td><td>${esc(l.contextPattern && l.contextPattern.samplerPattern)}</td><td><code>${esc(l.fix && l.fix.kind)}</code></td></tr>`).join('');
        const emptyMessage = !learnedRows && learnedLessons
            ? `<p class="muted">No new verified fix memory was saved for this run. Failed runs do not create learning entries.</p>`
            : '';
        learningSection = `<h2>Verified fix memory</h2>
            ${matchRows ? `<p class="muted">Previously verified, redacted fixes considered before AI escalation.</p>
            <table><thead><tr><th>Lesson</th><th>Confidence</th><th>Pattern</th><th>Fix</th></tr></thead><tbody>${matchRows}</tbody></table>` : ''}
            ${learnedRows ? `<p class="muted">New verified fixes saved only after this run verified green.</p>
            <table><thead><tr><th>Lesson</th><th>Confidence</th><th>Pattern</th><th>Fix</th></tr></thead><tbody>${learnedRows}</tbody></table>` : ''}
            ${emptyMessage}`;
    }

    const transactionSummarySection = renderTransactionSummary(labelMap);

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

  ${performanceSummarySection}

  ${loadProfileSection}

  ${dashLink}

  ${businessSection}

  ${requestAdjudicationSection}

  <h2>Request results</h2>
  <table><thead><tr><th></th><th>Transaction</th><th>Sampler</th><th>Code</th><th>Decision</th><th>Message</th></tr></thead>
  <tbody>${reqRows}</tbody></table>

  ${failures.length ? `<h2>Failures (${failures.length})</h2><ul>${failures.map(f => `<li><b>${esc(f.label || f.name)}</b>${firstPresent(f.transactionName, f.transaction, f.parentTransaction, '') ? ` <span class="muted">in ${esc(firstPresent(f.transactionName, f.transaction, f.parentTransaction, ''))}</span>` : ''} — ${esc(f.responseCode || '')} ${esc(f.responseMessage || f.failureMessage || '')}</li>`).join('')}</ul>` : ''}

  ${dualHarSection}

  ${correlationSection}

  ${reasoningSection}

  ${failureForensicsSection}

  ${driftSection}

  ${learningSection}

  ${transactionSummarySection}

  <h2>Artifacts</h2>
  <ul>${artifactItems || '<li class="muted">none</li>'}</ul>
</body></html>`;

    const out = path.join(outDir, `${name}_report.html`);
    fs.writeFileSync(out, html);
    return out;
}

function renderBusinessSamplerList(protectedSamplers) {
    const business = protectedSamplers.filter(s => s.category !== 'dependency');
    const dependencies = protectedSamplers.filter(s => s.category === 'dependency');
    const renderGroup = (title, items) => {
        if (!items.length) return '';
        const rows = items.slice(0, 12).map(s => `<li>${esc(s.name)} <span class="muted">(${esc(s.reason || 'required')})</span></li>`).join('');
        const more = items.length > 12 ? `<li class="muted">Showing first 12 of ${esc(items.length)}.</li>` : '';
        return `<p class="muted">${esc(title)} (${esc(items.length)})</p><ul>${rows}${more}</ul>`;
    };
    return renderGroup('Business-critical samplers', business) +
        renderGroup('Required dependency samplers', dependencies);
}

function renderTransactionSummary(labelMap) {
    const transactions = labelMap && Array.isArray(labelMap.transactions) ? labelMap.transactions : [];
    if (!transactions.length) return '';
    const rows = transactions.slice(0, 50).map(tx => `
        <tr>
            <td>${esc(tx.transactionCode || '')}</td>
            <td>${esc(tx.transactionLabel || tx.transactionName || '')}</td>
            <td>${esc(tx.semanticTransactionLabel || '')}</td>
            <td>${esc(tx.requestCount || 0)}</td>
        </tr>`).join('');
    const note = transactions.length > 50 ? `<p class="muted">Showing first 50 of ${esc(transactions.length)} transaction group(s).</p>` : '';
    return `<h2>Transaction summary</h2>
      <table><thead><tr><th>Code</th><th>PE transaction name</th><th>Semantic role</th><th>Requests</th></tr></thead>
      <tbody>${rows}</tbody></table>${note}
      <p class="muted">Child HTTP samplers remain visible in JTL results; use the label map to trace SC/T labels back to original Step NN recording order.</p>`;
}

function renderRequestAdjudicationSection(requestAdjudication, name, outDir) {
    const iterations = requestAdjudication && Array.isArray(requestAdjudication.iterations) ? requestAdjudication.iterations : [];
    if (!iterations.length) return '';
    const last = iterations[iterations.length - 1] || {};
    const summary = last.summary || {};
    const decisions = requestAdjudicationRows(requestAdjudication).slice(0, 12);
    const rows = decisions.map(d => `
        <tr>
            <td>${esc(d.samplerLabel || d.sampler || '')}</td>
            <td>${esc(decisionLabel(d.category || d.decision || d.sourceDecision || ''))}</td>
            <td>${esc(d.action || '')}</td>
            <td>${esc(d.reason || '')}</td>
        </tr>`).join('');
    const more = requestAdjudicationRows(requestAdjudication).length > 12
        ? `<p class="muted">Showing first 12 of ${esc(requestAdjudicationRows(requestAdjudication).length)} decision(s).</p>`
        : '';
    const artifact = `${name}_request_adjudication.json`;
    const artifactLink = fs.existsSync(path.join(outDir, artifact))
        ? `<p class="muted">Full evidence: <a href="${esc(artifact)}">${esc(artifact)}</a></p>`
        : '';
    return `<h2>Request adjudication</h2>
        <p>Disabled ${esc(summary.disable || 0)} dead/safe plumbing sampler(s), protected ${esc(summary.protect || 0)} session/business sampler(s), ignored ${esc(summary.ignore || 0)} downstream casualty sampler(s), blocked ${esc(summary.blocked || 0)} unsafe disable(s).</p>
        <table><thead><tr><th>Sampler</th><th>Category</th><th>Action</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No sampler-level adjudication rows.</td></tr>'}</tbody></table>
        ${more}${artifactLink}`;
}

function buildDecisionMap(disableDecisions) {
    const map = new Map();
    if (!disableDecisions) return map;
    const rows = requestAdjudicationRows(disableDecisions);
    for (const row of rows.filter(Boolean)) {
        const label = row.samplerLabel || row.sampler || row.label;
        const decision = row.category || row.decision || row.sourceDecision || '';
        if (label) {
            const normalized = String(label).trim();
            map.set(normalized, decision);
            const step = peNaming.stepNumberFromLabel(normalized);
            if (step) map.set(`step:${step}`, decision);
        }
    }
    return map;
}

function requestAdjudicationRows(value) {
    if (!value) return [];
    if (Array.isArray(value.iterations)) {
        const rows = [];
        for (const iter of value.iterations) {
            if (Array.isArray(iter.decisions)) rows.push(...iter.decisions);
            for (const list of Object.values(iter.actions || {})) {
                if (Array.isArray(list)) rows.push(...list);
            }
        }
        return dedupeRows(rows);
    }
    if (value.bySampler) return Object.values(value.bySampler);
    if (Array.isArray(value.byIndex)) return value.byIndex;
    return Object.values(value.byIndex || {});
}

function dedupeRows(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows.filter(Boolean)) {
        const key = `${row.samplerLabel || row.sampler || row.label || ''}|${row.category || row.decision || ''}|${row.action || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

function decisionForSampler(decisionBySampler, label) {
    const normalized = String(label || '').trim();
    const direct = decisionBySampler.get(normalized);
    if (direct) return decisionLabel(direct);
    const step = peNaming.stepNumberFromLabel(normalized);
    return decisionLabel(step ? decisionBySampler.get(`step:${step}`) : '');
}

function decisionLabel(decision) {
    switch (decision) {
        case 'must_fix':
            return 'Business request';
        case 'foldable_plumbing':
        case 'disposable_plumbing':
            return 'Safe to fold';
        case 'unsafe_to_disable':
            return 'Protected';
        case 'session_producer':
            return 'Session producer';
        case 'business_request':
            return 'Business request';
        case 'redirect_hop':
            return 'Redirect hop';
        case 'dead_plumbing':
            return 'Dead plumbing';
        case 'safe_browser_plumbing':
            return 'Safe browser plumbing';
        case 'downstream_casualty':
            return 'Downstream casualty';
        case 'blocked_disable':
            return 'Blocked disable';
        case 'auth_wall':
            return 'Auth wall';
        case 'unknown':
            return 'Unclassified';
        default:
            return decision || '';
    }
}

function readJsonIfExists(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

module.exports = { writeHtmlReport, _internal: { buildDecisionMap, decisionForSampler, decisionLabel } };
