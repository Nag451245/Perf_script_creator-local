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
 * source JSR223 synthesis, elastic polling blocks, safe AI escalation) are
 * specced in ARCHITECTURE.md and layer on top of this front door.
 *
 * Flags:
 *   --run           also execute + auto-fix via local JMeter (default: generate only)
 *   --agent         run + bounded OpenAI/Gemini diagnose/patch/re-verify loop
 *   --watch         keep running; process files as they appear in input/
 *   --force         reprocess unchanged input files once
 *   --iterations N  max feedback-loop iterations (default 3, cap 5)
 */
const fs = require('fs');
const path = require('path');

const { resolveGeminiModel } = require('./src/gemini-model');

const ROOT = __dirname;
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');
const args = process.argv.slice(2);

// Load optional local config (gitignored) and apply secrets to the environment
// BEFORE requiring the engine: the ai-service singleton reads GOOGLE_API_KEY at
// construction time (transitively constructed by the engine require below), so
// this must run first or the Gemini fallback key is never picked up.
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
if (!process.env.GOOGLE_MODEL) process.env.GOOGLE_MODEL = resolveGeminiModel(args, CONFIG, process.env);
if (CONFIG.openai && CONFIG.openai.apiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = CONFIG.openai.apiKey;
if (CONFIG.openai && CONFIG.openai.model && !process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = CONFIG.openai.model;

const { recordingXml } = require('./src/engine');
const { generate } = require('./src/generate');
const { runValidate } = require('./src/runner');
const { writeHtmlReport } = require('./src/report');
const { groupInputs, loadUnit } = require('./src/ingest');
const { scrubRecordingXml } = require('./src/scrubber');
const { replayAll } = require('./src/fast-replay');
const { resolveAgentOptions, labelForAgentOptions } = require('./src/agent-config');
const learningStore = require('./src/learning-store');
const inputState = require('./src/input-state');
const { archiveSuccessfulRun } = require('./src/success-archive');
const { writeFinalJmxPointer } = require('./src/final-artifact');

const AGENT_OPTS = resolveAgentOptions(args, CONFIG);
const DO_RUN = AGENT_OPTS.doRun;
const DO_AGENT = AGENT_OPTS.doAgent;
const WATCH = args.includes('--watch');
const FAST_LOOP = args.includes('--fast-loop');
const FORCE = args.includes('--force');
const LEARNING_CFG = CONFIG.learning || {};
const INPUT_STATE_CFG = CONFIG.inputState || {};
const SUCCESS_ARCHIVE_CFG = CONFIG.successArchive || {};
const USE_INPUT_STATE = INPUT_STATE_CFG.enabled !== false;

const iterFlag = args.indexOf('--iterations');
const MAX_ITER = iterFlag >= 0
    ? Math.min(5, Math.max(1, Number(args[iterFlag + 1]) || 3))
    : Math.min(5, Math.max(1, Number(CONFIG.maxIterations) || 3));

const processed = new Set();
const processedStatePath = INPUT_STATE_CFG.storePath
    ? resolveFromRoot(INPUT_STATE_CFG.storePath)
    : inputState.defaultStatePath(ROOT);
const processedState = inputState.loadProcessedState(processedStatePath);

function log(line) { process.stdout.write(`${line}\n`); }
function safeName(name) {
    return String(name || '').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60);
}
function valueAfterFlag(flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
}
function resolveFromRoot(file) {
    return path.isAbsolute(file) ? file : path.join(ROOT, file);
}
function learningStorePath() {
    return LEARNING_CFG.storePath ? resolveFromRoot(LEARNING_CFG.storePath) : learningStore.defaultStorePath(ROOT);
}
function archiveGreenRun({ outDir, name, rec }) {
    if (SUCCESS_ARCHIVE_CFG.enabled === false) return;
    const res = archiveSuccessfulRun({
        outputRoot: OUTPUT,
        outDir,
        name,
        keepOriginals: SUCCESS_ARCHIVE_CFG.keepOriginals !== false,
        archiveDir: SUCCESS_ARCHIVE_CFG.folder ? resolveFromRoot(SUCCESS_ARCHIVE_CFG.folder) : undefined,
    });
    if (res.ok) rec(`archived GREEN run -> ${path.relative(ROOT, res.zipPath)}`);
    else rec(`archive skipped: ${res.error}`);
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

    // runCfg reaches generate() on BOTH paths: runValidate overrides it with
    // the enriched copy (auto host-rewrite), and the generate-only fallback
    // below needs it for config-driven disableCalls / oauth gate / loadProfile.
    const genOpts = { dualHarHints: notes, secondaryEntries, runCfg: CONFIG.run || {} };

    // Pre-flight: replay the recording against the target with our Node-only
    // fast-replay engine BEFORE booting JMeter. Catches the obvious "doesn't even
    // respond / wrong host" class in <1s. Runs automatically in --run mode (and
    // via --fast-loop for generate-only), whenever a target is configured — this
    // is the Phase-2 localization the architecture calls for. The full --run
    // still owns "is this script good enough to ship."
    if (FAST_LOOP || DO_RUN) {
        const runCfg = CONFIG.run || {};
        const targetBase = (runCfg.targetBaseUrlOverride || '').trim() || null;
        if (!targetBase) {
            if (FAST_LOOP) rec('fast-replay pre-flight skipped: set run.targetBaseUrlOverride to enable it.');
        } else {
            rec(`fast-replay → ${targetBase} (Node, no JMeter)`);
            try {
                const fr = await replayAll({ entries, targetBaseUrl: targetBase, insecure: !!(runCfg.fastReplay && runCfg.fastReplay.insecure), onLog: rec });
                fs.writeFileSync(path.join(outDir, `${name}_fast_replay.json`), JSON.stringify(fr, null, 2));
                rec(`fast-replay: ${fr.samples.filter(s => s.success).length}/${fr.samples.length} ok · drift=${fr.drift.length} · errors=${fr.errors.length} · ${fr.durationMs}ms`);
            } catch (e) { rec(`fast-replay error: ${e.message}`); }
        }
    }

    let runAttemptError = null;
    if (DO_RUN) {
        try {
            rec(`running bounded feedback loop (max ${MAX_ITER})…`);
            if (DO_AGENT) rec(`agent mode enabled · max LLM rounds=${AGENT_OPTS.agent.maxLlmRounds} · java-safe=${AGENT_OPTS.agent.javaSafeMode ? 'on' : 'off'}`);
            const out = await runValidate({
                entries, pages, outDir, name,
                runCfg: CONFIG.run || {},
                maxIterations: MAX_ITER,
                onLog: rec,
                genOpts,
                agentCfg: AGENT_OPTS.agent,
                learningCfg: { ...LEARNING_CFG, storePath: learningStorePath() },
            });
            if (!out.ok) {
                runAttemptError = out.error;
                rec(`cannot run: ${out.error} — falling back to generate-only.`);
                fs.writeFileSync(path.join(outDir, `${name}_run_status.json`), JSON.stringify({ ok: false, error: out.error, verified: false }, null, 2));
            } else {
                fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(out.result, null, 2));
                const reqs = (out.result.samples || []).filter(s => !s.isTransaction);
                const passed = reqs.filter(s => s.success).length;
                const verdict = out.result.success ? 'GREEN' : 'needs attention';
                const finalMarker = writeFinalJmxPointer({
                    outDir,
                    name,
                    finalJmxPath: out.result.finalJmxPath || path.join(outDir, `${name}.jmx`),
                    verdict,
                    validated: true,
                    businessVerified: !!(out.businessVerification && out.businessVerification.ok),
                });
                rec(`DONE — verdict=${verdict} · ` +
                    `${passed}/${reqs.length} requests passed · ${out.result.iterationsRun} iteration(s) · see report.json`);
                rec(`USE THIS JMX -> ${path.basename(finalMarker.finalCopyPath)}`);
                writeHtmlReport(outDir, name, {
                    mode: `generate + run (${mode})`, verdict,
                    stats: out.stats, samples: out.result.samples || [],
                    baselineDiff: out.baselineDiff,
                    memoryMatches: out.memoryMatches || [],
                    learnedLessons: out.learnedLessons || null,
                    correlations: out.correlations || [],
                    dualHar: notes.dualHar || null,
                    loadProfile: (out.stats && out.stats.loadProfile) || null,
                    reasoning: out.reasoning || [],
                    businessVerification: out.businessVerification || null,
                });
                rec(`open ${name}_report.html for a summary`);
                if (out.result.success) archiveGreenRun({ outDir, name, rec });
                fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
                return;
            }
        } catch (e) {
            runAttemptError = e.message;
            rec(`feedback loop error: ${e.message} — falling back to generate-only.`);
            fs.writeFileSync(path.join(outDir, `${name}_run_status.json`), JSON.stringify({ ok: false, error: e.message, verified: false }, null, 2));
        }
    }

    // Generate-only path.
    try {
        const gen = generate(entries, pages, outDir, name, genOpts);
        fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(gen.stats, null, 2));
        const finalMarker = writeFinalJmxPointer({
            outDir,
            name,
            finalJmxPath: gen.jmxPath,
            verdict: runAttemptError ? 'not verified' : 'generated',
            validated: false,
            businessVerified: false,
        });
        rec(`generated JMX — ${gen.stats.samplers} samplers, ${gen.stats.correlations} correlations` +
            `${gen.stats.bodyCorrelations ? ` (+${gen.stats.bodyCorrelations} body/session)` : ''}, ` +
            `${gen.stats.parameterized} parameterized field(s)${gen.csvFile ? ` → ${gen.csvFile}` : ''}, ` +
            `${gen.stats.clientSideGhosts} client-side value(s) regenerated, ` +
            `${gen.stats.pollingLoops} polling loop(s), ${gen.stats.orphans} orphan(s)`);
        rec(`USE THIS JMX -> ${path.basename(finalMarker.finalCopyPath)}`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        writeHtmlReport(outDir, name, {
            mode: runAttemptError ? `${DO_AGENT ? 'agent validate' : 'generate + validate'} attempted (${mode})` : `generate only (${mode})`,
            verdict: runAttemptError ? 'not verified' : 'generated',
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
    const fresh = units.filter(u => !processed.has(u.primary) && (FORCE || !USE_INPUT_STATE || inputState.shouldProcessUnit(u, processedState)));
    if (fresh.length === 0 && !WATCH) {
        log(all.length ? `No new HAR / JMX files in ${INPUT}. Drop changed recordings there and re-run, or use --force to reprocess unchanged inputs.` : `No HAR / JMX files in ${INPUT}. Drop recordings there and re-run.`);
    }
    for (const u of fresh) {
        processed.add(u.primary);
        if (u.secondary) processed.add(u.secondary);
        if (u.sidecars?.primary) processed.add(u.sidecars.primary);
        if (u.sidecars?.secondary) processed.add(u.sidecars.secondary);
        await processUnit(u);
        if (USE_INPUT_STATE) inputState.markUnitProcessed(u, processedState, processedStatePath);
    }
}

(async () => {
    fs.mkdirSync(INPUT, { recursive: true });
    fs.mkdirSync(OUTPUT, { recursive: true });
    const memoryImport = valueAfterFlag('--memory-import');
    const memoryExport = valueAfterFlag('--memory-export');
    if (memoryImport) {
        const res = learningStore.importLessons({ storePath: learningStorePath(), importPath: resolveFromRoot(memoryImport) });
        log(`Imported ${res.imported} verified lesson(s) into ${res.storePath} (total ${res.total}).`);
    }
    if (memoryExport) {
        const res = learningStore.exportLessons({ storePath: learningStorePath(), exportPath: resolveFromRoot(memoryExport) });
        log(`Exported ${res.count} verified lesson(s) to ${res.exportPath}.`);
    }
    if ((memoryImport || memoryExport) && !WATCH && !DO_RUN && !FAST_LOOP) return;
    log(`perfscript-local — mode: ${labelForAgentOptions(AGENT_OPTS, WATCH)}`);
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
