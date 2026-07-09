'use strict';
/**
 * scenario.js — turn a business objective into a load model, with the math
 * shown. This is the part of a senior engineer's deliverable that is pure
 * arithmetic and almost always done by hand: Little's Law from
 * "N transactions/hour, p95 under X" to threads + pacing + data-pool size.
 *
 * Config (perfscript.config.json → run.scenario):
 *   {
 *     "transactionsPerHour": 500,   // OR "concurrentUsers": 25
 *     "durationMin": 60,            // steady-state length (default 60)
 *     "rampUpPercent": 10,          // of duration (default 10)
 *     "pacing": true                // emit a Precise Throughput Timer (default true when tph given)
 *   }
 *
 * Derivations (R = recorded session length):
 *   threads  = ceil(tph × R / 3600)            (Little's Law, N = X·R)
 *   pacing   = threads × 3600 / tph  seconds/iteration/thread
 *   dataPool = ceil(tph × duration/60 × 1.1)   unique rows (10% headroom)
 *
 * Explicit run.loadProfile in config still wins — the scenario only fills a
 * load profile the operator left unset.
 */

function designScenario({ entries = [], runCfg = {} } = {}) {
    const sc = runCfg.scenario;
    if (!sc || typeof sc !== 'object') return null;

    const sessionSeconds = recordedSessionSeconds(entries);
    const durationMin = clamp(Number(sc.durationMin) || 60, 1, 24 * 60);
    const durationSec = durationMin * 60;
    const rampUpPercent = clamp(Number(sc.rampUpPercent) || 10, 1, 50);

    let threads;
    let tph = Number(sc.transactionsPerHour) || 0;
    const lines = [];
    lines.push(`Recorded session length R = ${sessionSeconds.toFixed(1)}s (first→last request timestamp).`);

    if (tph > 0) {
        threads = Math.max(1, Math.ceil((tph * sessionSeconds) / 3600));
        lines.push(`Objective: ${tph} transactions/hour.`);
        lines.push(`Little's Law: threads = ceil(X·R) = ceil(${tph} × ${sessionSeconds.toFixed(1)}s / 3600) = **${threads}**.`);
    } else if (Number(sc.concurrentUsers) > 0) {
        threads = Math.ceil(Number(sc.concurrentUsers));
        tph = Math.round((threads * 3600) / Math.max(sessionSeconds, 1));
        lines.push(`Objective: ${threads} concurrent users.`);
        lines.push(`Achievable throughput ≈ N/R = ${threads} × 3600 / ${sessionSeconds.toFixed(1)}s ≈ **${tph} transactions/hour** (unpaced ceiling).`);
    } else {
        return null; // scenario block present but no objective — nothing to design
    }

    const pacingSeconds = tph > 0 ? (threads * 3600) / tph : 0;
    if (pacingSeconds > 0) {
        lines.push(`Pacing: each thread starts an iteration every threads×3600/X = ${pacingSeconds.toFixed(1)}s ` +
            `(idle ≈ ${(Math.max(0, pacingSeconds - sessionSeconds)).toFixed(1)}s/iteration — negative would mean threads can't keep up).`);
    }

    const iterationsTotal = Math.ceil((tph * durationMin) / 60);
    const uniqueRows = Math.ceil(iterationsTotal * 1.1);
    lines.push(`Data pool: ${tph}/h × ${durationMin}min = ${iterationsTotal} iterations → **${uniqueRows} unique rows** (10% headroom) so data never repeats inside the test.`);

    const rampUpSec = Math.max(threads, Math.round(durationSec * (rampUpPercent / 100)));
    lines.push(`Ramp-up: max(1s/thread, ${rampUpPercent}% of duration) = ${rampUpSec}s; steady state ${durationMin}min.`);

    const wantPacingTimer = sc.pacing !== false && Number(sc.transactionsPerHour) > 0;
    if (wantPacingTimer) {
        lines.push(`A Precise Throughput Timer pins the rate to ${tph}/h so the achieved load doesn't drift with response times.`);
    }

    return {
        objective: { transactionsPerHour: tph, durationMin },
        sessionSeconds,
        threads,
        pacingSeconds,
        uniqueRows: clamp(uniqueRows, 10, 100000),
        loadProfile: { users: threads, rampUpSec, holdSec: durationSec },
        pacing: wantPacingTimer ? { perHour: tph, durationSec: durationSec + rampUpSec } : null,
        mathLines: lines,
    };
}

function recordedSessionSeconds(entries = []) {
    const times = entries
        .map(e => Date.parse(e.startedDateTime || (e.request && e.request.startedDateTime) || ''))
        .filter(Number.isFinite);
    if (times.length >= 2) {
        const span = (Math.max(...times) - Math.min(...times)) / 1000;
        if (span > 1) return span;
    }
    // No usable timestamps — estimate: browser flows average ~0.5s/request.
    return Math.max(30, entries.length * 0.5);
}

/**
 * Insert a pacing anchor (Flow Control Action + Precise Throughput Timer) as
 * the FIRST child of every enabled ThreadGroup, so each iteration is paced to
 * the target rate. Native elements only — survives the java-safe strip.
 */
function insertPacingTimers(xml, { perHour, durationSec }) {
    if (!perHour) return { xml, inserted: 0 };
    let inserted = 0;
    const block = `
        <TestAction guiclass="TestActionGui" testclass="TestAction" testname="Pacing anchor (scenario: ${Math.round(perHour)}/h)" enabled="true">
          <intProp name="ActionProcessor.action">1</intProp>
          <intProp name="ActionProcessor.target">0</intProp>
          <stringProp name="ActionProcessor.duration">0</stringProp>
        </TestAction>
        <hashTree/>
        <PreciseThroughputTimer guiclass="TestBeanGUI" testclass="PreciseThroughputTimer" testname="Pacing ${Math.round(perHour)}/hour (scenario)" enabled="true">
          <intProp name="exactLimit">0</intProp>
          <doubleProp>
            <name>allowedThroughputSurplus</name>
            <value>0.0</value>
            <savedValue>0.0</savedValue>
          </doubleProp>
          <intProp name="batchSize">1</intProp>
          <intProp name="batchThreadDelay">0</intProp>
          <longProp name="duration">${Math.max(60, Math.round(durationSec))}</longProp>
          <longProp name="randomSeed">0</longProp>
          <doubleProp>
            <name>throughput</name>
            <value>${(perHour / 3600).toFixed(6)}</value>
            <savedValue>0.0</savedValue>
          </doubleProp>
          <intProp name="throughputPeriod">1</intProp>
        </PreciseThroughputTimer>
        <hashTree/>`;
    const out = xml.replace(/(<ThreadGroup\b[^>]*enabled="true"[\s\S]*?<\/ThreadGroup>)(\s*<hashTree>)/g, (_m, tg, open) => {
        inserted++;
        return tg + open + block;
    });
    return { xml: out, inserted };
}

function renderScenarioMarkdown(name, scenario) {
    const s = scenario;
    return [
        `# ${name} — load scenario (the math)`,
        '',
        ...s.mathLines.map(l => `- ${l}`),
        '',
        `| threads | pacing/iter | ramp-up | steady state | data rows |`,
        `|---|---|---|---|---|`,
        `| ${s.threads} | ${s.pacingSeconds ? s.pacingSeconds.toFixed(1) + 's' : 'unpaced'} | ${s.loadProfile.rampUpSec}s | ${s.objective.durationMin}min | ${s.uniqueRows} |`,
        '',
        'Explicit `run.loadProfile` in config overrides all of this.',
    ].join('\n');
}

module.exports = { designScenario, insertPacingTimers, renderScenarioMarkdown, _internal: { recordedSessionSeconds } };

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
