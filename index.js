#!/usr/bin/env node
'use strict';
/**
 * perfscript-local — folder-driven autonomous JMeter scripting agent.
 *
 *   input/   ← drop .har (and later .jmx + recording .xml) files here
 *   output/  ← one folder per input: .jmx, .recording.xml, report.json, log.txt
 *
 * PHASE 1 (this file): the unattended front door over the existing engine.
 *   parse HAR → correlate + generate JMX → write outputs.
 *   With --run AND local JMeter present: also run the bounded
 *   run→diagnose→disable→re-run feedback loop and emit a validated JMX.
 *
 * The advanced verification phases (segment-replay state isolation, ghost-
 * source JSR223 synthesis, elastic polling blocks, Gemini escalation) are
 * specced in ARCHITECTURE.md and layer on top of this front door.
 *
 * Flags:
 *   --run           also execute + auto-fix via local JMeter (default: generate only)
 *   --watch         keep running; process files as they appear in input/
 *   --iterations N  max feedback-loop iterations (default 3, cap 5)
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');

// Load optional local config (gitignored) and apply secrets to the environment
// BEFORE requiring the engine: the ai-service singleton reads GOOGLE_API_KEY at
// construction time (transitively constructed by the engine require below), so
// this must run first or the Gemini key is never picked up.
function loadConfig() {
    const p = path.join(ROOT, 'perfscript.config.json');
    if (!fs.existsSync(p)) return {};
    // Strip a leading UTF-8 BOM — Windows editors / PowerShell Out-File add one
    // and it makes JSON.parse throw, silently dropping the whole config.
    try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
    catch (e) { console.warn(`WARNING: perfscript.config.json is not valid JSON (${e.message}) — ignoring it.`); return {}; }
}
const CONFIG = loadConfig();
if (CONFIG.jmeterHome && !process.env.JMETER_HOME) process.env.JMETER_HOME = CONFIG.jmeterHome;
// Pin the Java that JMeter uses. JMeter 5.6.3's bundled Groovy can't compile
// JSR223 under Java 22+ (class major >= 66) — it silently produces ZERO samples.
// IMPORTANT: jmeter.bat does NOT honor JAVA_HOME; it launches `java.exe` from
// PATH. So pinning a JDK 8-21 means PREPENDING its bin to PATH (we also set
// JAVA_HOME for tools that do respect it).
if (CONFIG.javaHome) {
    process.env.JAVA_HOME = CONFIG.javaHome;
    process.env.PATH = path.join(CONFIG.javaHome, 'bin') + path.delimiter + (process.env.PATH || '');
}
if (CONFIG.gemini && CONFIG.gemini.apiKey && !process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = CONFIG.gemini.apiKey;

const { recordingXml } = require('./src/engine');
const { generate } = require('./src/generate');
const { runValidate } = require('./src/runner');
const { writeHtmlReport } = require('./src/report');
const { groupInputs, loadUnit } = require('./src/ingest');
const { scrubRecordingXml } = require('./src/scrubber');
const { replayAll } = require('./src/fast-replay');

const args = process.argv.slice(2);
const DO_RUN = args.includes('--run');
const WATCH = args.includes('--watch');
const FAST_LOOP = args.includes('--fast-loop');

const iterFlag = args.indexOf('--iterations');
const MAX_ITER = iterFlag >= 0
    ? Math.min(5, Math.max(1, Number(args[iterFlag + 1]) || 3))
    : Math.min(5, Math.max(1, Number(CONFIG.maxIterations) || 3));

const processed = new Set();

function log(line) { process.stdout.write(`${line}\n`); }
function safeName(name) {
    return String(name || '').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60);
}

async function processUnit(unit) {
    const name = safeName(unit.name);
    const outDir = path.join(OUTPUT, name);
    fs.mkdirSync(outDir, { recursive: true });
    const lines = [];
    const rec = (s) => { lines.push(s); log(`   ${s}`); };

    let inputLabel;
    if (unit.kind === 'dual-har') {
        inputLabel = `${path.basename(unit.primary)} + ${path.basename(unit.secondary)} (dual-recording, HAR)`;
    } else if (unit.kind === 'dual-jmx') {
        const sc1 = unit.sidecars?.primary ? ` (+${path.basename(unit.sidecars.primary)})` : '';
        const sc2 = unit.sidecars?.secondary ? ` (+${path.basename(unit.sidecars.secondary)})` : '';
        inputLabel = `${path.basename(unit.primary)}${sc1} + ${path.basename(unit.secondary)}${sc2} (dual-recording, JMX)`;
    } else if (unit.secondary) {
        inputLabel = `${path.basename(unit.primary)} + ${path.basename(unit.secondary)} (JMX + response side)`;
    } else {
        inputLabel = path.basename(unit.primary);
    }
    log(`\n▶ ${inputLabel}`);

    let loaded;
    try {
        loaded = await loadUnit(unit);
    } catch (e) {
        rec(`PARSE FAILED: ${e.message}`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        return;
    }
    const { entries, secondaryEntries, pages, mode, notes } = loaded;
    rec(`mode=${mode} · parsed ${entries.length} entries, ${pages.length} pages`);
    if (notes.dualHar) rec(`dual-recording variance: ${notes.dualHar.dynamicValueCount} dynamic values across the two runs`);
    if (notes.dualHarError) rec(`dual-recording comparison failed (${notes.dualHarError}) — continuing with first recording only`);
    if (notes.jmxJtl) rec(`JMX paired with ${notes.jmxJtl.sidecar}: ${notes.jmxJtl.paired}/${entries.length} response sides matched`);
    if (notes.jmxJtlError) rec(notes.jmxJtlError);

    // Recording XML sidecar (full request/response bodies for reference).
    // Scrub obvious secrets (password / Authorization / *token*) so the
    // artifact is shareable; originals to a gitignored sibling for replay.
    try {
        const raw = recordingXml.generate(entries, { sourceFile: name });
        const { xml: scrubbed, hits } = scrubRecordingXml(raw);
        fs.writeFileSync(path.join(outDir, `${name}.recording.xml`), scrubbed);
        if (hits.length) {
            fs.writeFileSync(
                path.join(outDir, `${name}_secrets.json`),
                JSON.stringify({ note: 'gitignored — original values redacted from recording.xml', hits }, null, 2)
            );
            rec(`wrote recording.xml · scrubbed ${hits.length} secret field(s) -> ${name}_secrets.json`);
        } else {
            rec('wrote recording.xml');
        }
    } catch (e) { rec(`recording.xml skipped: ${e.message}`); }

    const genOpts = { dualHarHints: notes, secondaryEntries };

    // Optional pre-flight: replay the recording against the target with our
    // Node-only fast-replay engine. Catches the obvious "doesn't even respond"
    // class of failures in <1s without booting JMeter. Honest pre-flight only;
    // the full --run still owns "is this script good enough to ship."
    if (FAST_LOOP) {
        const runCfg = CONFIG.run || {};
        const targetBase = (runCfg.targetBaseUrlOverride || '').trim() || null;
        if (!targetBase) {
            rec('--fast-loop skipped: run.targetBaseUrlOverride is required to pick a target.');
        } else {
            rec(`fast-replay → ${targetBase} (Node, no JMeter)`);
            try {
                const fr = await replayAll({ entries, targetBaseUrl: targetBase, insecure: !!(runCfg.fastReplay && runCfg.fastReplay.insecure), onLog: rec });
                fs.writeFileSync(path.join(outDir, `${name}_fast_replay.json`), JSON.stringify(fr, null, 2));
                rec(`fast-replay: ${fr.samples.filter(s => s.success).length}/${fr.samples.length} ok · drift=${fr.drift.length} · errors=${fr.errors.length} · ${fr.durationMs}ms`);
            } catch (e) { rec(`fast-replay error: ${e.message}`); }
        }
    }

    if (DO_RUN) {
        try {
            rec(`running bounded feedback loop (max ${MAX_ITER})…`);
            const out = await runValidate({
                entries, pages, outDir, name,
                runCfg: CONFIG.run || {},
                maxIterations: MAX_ITER,
                onLog: rec,
                genOpts,
            });
            if (!out.ok) {
                rec(`cannot run: ${out.error} — falling back to generate-only.`);
            } else {
                fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(out.result, null, 2));
                const reqs = (out.result.samples || []).filter(s => !s.isTransaction);
                const passed = reqs.filter(s => s.success).length;
                const verdict = out.result.success ? 'GREEN' : 'needs attention';
                rec(`DONE — verdict=${verdict} · ` +
                    `${passed}/${reqs.length} requests passed · ${out.result.iterationsRun} iteration(s) · see report.json`);
                fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
                writeHtmlReport(outDir, name, {
                    mode: `generate + run (${mode})`, verdict,
                    stats: out.stats, samples: out.result.samples || [],
                    baselineDiff: out.baselineDiff,
                    correlations: out.correlations || [],
                    dualHar: notes.dualHar || null,
                    loadProfile: (out.stats && out.stats.loadProfile) || null,
                    reasoning: out.reasoning || [],
                });
                rec(`open ${name}_report.html for a summary`);
                return;
            }
        } catch (e) {
            rec(`feedback loop error: ${e.message} — falling back to generate-only.`);
        }
    }

    // Generate-only path.
    try {
        const gen = generate(entries, pages, outDir, name, genOpts);
        fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(gen.stats, null, 2));
        rec(`generated JMX — ${gen.stats.samplers} samplers, ${gen.stats.correlations} correlations` +
            `${gen.stats.bodyCorrelations ? ` (+${gen.stats.bodyCorrelations} body/session)` : ''}, ` +
            `${gen.stats.parameterized} parameterized field(s)${gen.csvFile ? ` → ${gen.csvFile}` : ''}, ` +
            `${gen.stats.clientSideGhosts} client-side value(s) regenerated, ` +
            `${gen.stats.pollingLoops} polling loop(s), ${gen.stats.orphans} orphan(s)`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        writeHtmlReport(outDir, name, {
            mode: `generate only (${mode})`, verdict: 'generated',
            stats: gen.stats, samples: [],
            correlations: gen.correlations || [],
            dualHar: notes.dualHar || null,
            loadProfile: gen.loadProfile || null,
            reasoning: gen.reasoning || [],
        });
        rec(`open ${name}_report.html for a summary`);
    } catch (e) {
        rec(`GENERATE FAILED: ${e.message}`);
    }
    fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
}

async function scanOnce() {
    const all = fs.readdirSync(INPUT)
        .filter(f => /\.(har|jmx|xml|jtl)$/i.test(f))
        .map(f => path.join(INPUT, f));
    const units = groupInputs(all);
    const fresh = units.filter(u => !processed.has(u.primary));
    if (fresh.length === 0 && !WATCH) {
        log(`No HAR / JMX files in ${INPUT}. Drop recordings there and re-run.`);
    }
    for (const u of fresh) {
        processed.add(u.primary);
        if (u.secondary) processed.add(u.secondary);
        if (u.sidecars?.primary) processed.add(u.sidecars.primary);
        if (u.sidecars?.secondary) processed.add(u.sidecars.secondary);
        await processUnit(u);
    }
}

(async () => {
    fs.mkdirSync(INPUT, { recursive: true });
    fs.mkdirSync(OUTPUT, { recursive: true });
    log(`perfscript-local — mode: ${DO_RUN ? 'generate + run/validate' : 'generate only'}${WATCH ? ' (watch)' : ''}`);
    log(`engine: ${require('./src/engine').ENGINE_ROOT}`);
    await scanOnce();
    if (WATCH) {
        log(`\nWatching ${INPUT} … (Ctrl+C to stop)`);
        // Serialized poll loop: the next scan only schedules AFTER the
        // current one settles. setInterval would re-enter if a scan took
        // longer than the interval (large HAR + --run + --fast-loop can
        // easily exceed 3s), racing on `processed` and double-writing
        // outputs. Chained setTimeout is the right primitive here.
        const tick = async () => {
            try { await scanOnce(); }
            catch (e) { log(`watch scan error: ${e.message}`); }
            setTimeout(tick, 3000);
        };
        setTimeout(tick, 3000);
    } else {
        log('\nDone.');
    }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
