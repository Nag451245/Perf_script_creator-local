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
 *   --input NAME    process only the selected logical input unit/file
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
// AI assist is OFF unless explicitly enabled — LLM calls cost money, so the
// default run is deterministic-only (generation, correlation, fold-safety,
// validation, self-repair, learned-lesson replay all run WITHOUT any AI). The
// UI's "AI assist" control (or the CLI --ai flag) turns paid escalation on;
// when off we never even load the API keys, guaranteeing zero LLM calls.
const AI_ON = args.includes('--ai') && !args.includes('--no-ai');
if (AI_ON) {
    if (CONFIG.gemini && CONFIG.gemini.apiKey && !process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = CONFIG.gemini.apiKey;
    if (!process.env.GOOGLE_MODEL) process.env.GOOGLE_MODEL = resolveGeminiModel(args, CONFIG, process.env);
    if (CONFIG.openai && CONFIG.openai.apiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = CONFIG.openai.apiKey;
    if (CONFIG.openai && CONFIG.openai.model && !process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = CONFIG.openai.model;
} else {
    // Belt-and-suspenders: strip any keys the environment already carries so
    // the engine's ai-service singleton initializes disabled.
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Also zero the LLM rounds so the agent never attempts escalation.
    if (CONFIG.agent && typeof CONFIG.agent === 'object') CONFIG.agent = { ...CONFIG.agent, maxLlmRounds: 0 };
}

const { recordingXml } = require('./src/engine');
const { generate } = require('./src/generate');
const { runValidate } = require('./src/runner');
const { writeHtmlReport } = require('./src/report');
const { analyzeInputFiles, loadUnit, writeIntakeArtifacts } = require('./src/ingest');
const { scrubRecordingXml } = require('./src/scrubber');
const { replayAll } = require('./src/fast-replay');
const { resolveAgentOptions, labelForAgentOptions } = require('./src/agent-config');
const learningStore = require('./src/learning-store');
const inputState = require('./src/input-state');
const { archiveSuccessfulRun } = require('./src/success-archive');
const { writeFinalJmxPointer } = require('./src/final-artifact');
const runProgress = require('./src/run-progress');
const outputOrganizer = require('./src/output-organizer');
const { selectUnits } = require('./src/ui-inputs');

const AGENT_OPTS = resolveAgentOptions(args, CONFIG);
const DO_RUN = AGENT_OPTS.doRun;
const DO_AGENT = AGENT_OPTS.doAgent;
const WATCH = args.includes('--watch');
const FAST_LOOP = args.includes('--fast-loop');
const FORCE = args.includes('--force');
const SELECTED_INPUTS = valuesAfterRepeatedFlag('--input');
const LEARNING_CFG = CONFIG.learning || {};
const INPUT_STATE_CFG = CONFIG.inputState || {};
const SUCCESS_ARCHIVE_CFG = CONFIG.successArchive || {};
const USE_INPUT_STATE = INPUT_STATE_CFG.enabled !== false;

const iterFlag = args.indexOf('--iterations');
const MAX_ITER = iterFlag >= 0
    ? Math.min(6, Math.max(1, Number(args[iterFlag + 1]) || 3))
    : Math.min(6, Math.max(1, Number(CONFIG.maxIterations) || 3));

const processed = new Set();
let lastIdleScanMessageKey = '';
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
function valuesAfterRepeatedFlag(flag) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === flag && args[i + 1]) {
            values.push(args[i + 1]);
            i += 1;
            continue;
        }
        if (String(args[i]).startsWith(`${flag}=`)) values.push(String(args[i]).slice(flag.length + 1));
    }
    return values.map(v => String(v || '').trim()).filter(Boolean);
}
function inputRetryOptions() {
    const retryFlag = valueAfterFlag('--retry-failed');
    return {
        retryFailed: INPUT_STATE_CFG.retryFailed !== false,
        maxFailedAttempts: Math.max(1, Number(retryFlag || INPUT_STATE_CFG.maxFailedAttempts || 3) || 3),
        reprocessLegacy: DO_RUN || DO_AGENT,
    };
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

function startRunProgressHeartbeat(outDir, rec) {
    const ms = Math.max(5000, Number(CONFIG.run && CONFIG.run.progressIntervalMs || 10000) || 10000);
    rec(`validation progress heartbeat every ${Math.round(ms / 1000)}s while JMeter is running`);
    let lastProgressKey = '';
    let unchangedMs = 0;
    let lastUnchangedNoticeMs = 0;
    const timer = setInterval(() => {
        const progress = runProgress.snapshotRunProgress(outDir);
        if (progress.key === lastProgressKey) {
            unchangedMs += ms;
            if (unchangedMs - lastUnchangedNoticeMs >= 60000) {
                lastUnchangedNoticeMs = unchangedMs;
                rec(`progress: no new JMeter samples for ${Math.round(unchangedMs / 1000)}s; still waiting on the current validation step`);
            }
        } else {
            unchangedMs = 0;
            lastUnchangedNoticeMs = 0;
            lastProgressKey = progress.key;
            rec(`progress: ${progress.summary}`);
        }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
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
        return { success: false, verdict: 'parse failed' };
    }
    const { entries, secondaryEntries, pages, mode, notes } = loaded;
    rec(`mode=${mode} · parsed ${entries.length} entries, ${pages.length} pages`);

    // Flow & domain understanding — say what the agent SEES before it acts,
    // so the operator can catch a misread instantly instead of after a run.
    try {
        const { summarizeFlow } = require('./src/flow-understanding');
        const understanding = summarizeFlow({ entries, pages, runCfg: CONFIG.run || {} });
        for (const line of understanding.lines) rec(line);
        fs.writeFileSync(path.join(outDir, `${name}_understanding.json`), JSON.stringify(understanding.summary, null, 2));
    } catch (e) { rec(`flow understanding skipped: ${e.message}`); }

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

    // Human-fixed working script for this flow (input/<flow>__golden.jmx):
    // its proven extractors / enable judgments are merged into generation.
    if (unit.golden) {
        try {
            genOpts.goldenXml = fs.readFileSync(unit.golden, 'utf8');
            rec(`golden script attached: ${path.basename(unit.golden)} — proven fixes will be merged`);
        } catch (e) { rec(`golden script unreadable (${e.message}) — ignored`); }
    }

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
        let progressTimer = null;
        try {
            rec(`running bounded feedback loop (max ${MAX_ITER})…`);
            if (DO_AGENT) rec(`agent mode enabled · max LLM rounds=${AGENT_OPTS.agent.maxLlmRounds} · java-safe=${AGENT_OPTS.agent.javaSafeMode ? 'on' : 'off'}`);
            progressTimer = startRunProgressHeartbeat(outDir, rec);
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
                    currentJtlPath: path.join(outDir, 'final.jtl'),
                    labelMapPath: path.join(outDir, `${name}_label_map.json`),
                });
                rec(`DONE — verdict=${verdict} · ` +
                    `${passed}/${reqs.length} requests passed · ${out.result.iterationsRun} iteration(s) · see report.json`);
                rec(`USE THIS JMX -> ${path.basename(finalMarker.finalCopyPath)}`);
                const reportPath = writeHtmlReport(outDir, name, {
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
                    disableDecisions: out.disableDecisions || null,
                    failureForensics: out.failureForensics || null,
                });
                rec(`open ${name}_report.html for a summary`);
                fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
                outputOrganizer.organizeOutput({
                    outDir,
                    name,
                    verdict,
                    finalJmxPath: finalMarker.finalCopyPath,
                    reportPath,
                    currentJtlPath: path.join(outDir, 'final.jtl'),
                });
                if (out.result.success) archiveGreenRun({ outDir, name, rec });
                return { success: !!out.result.success, verdict };
            }
        } catch (e) {
            runAttemptError = e.message;
            rec(`feedback loop error: ${e.message} — falling back to generate-only.`);
            fs.writeFileSync(path.join(outDir, `${name}_run_status.json`), JSON.stringify({ ok: false, error: e.message, verified: false }, null, 2));
        } finally {
            if (progressTimer) clearInterval(progressTimer);
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
            labelMapPath: path.join(outDir, `${name}_label_map.json`),
        });
        rec(`generated JMX — ${gen.stats.samplers} samplers, ${gen.stats.correlations} correlations` +
            `${gen.stats.bodyCorrelations ? ` (+${gen.stats.bodyCorrelations} body/session)` : ''}, ` +
            `${gen.stats.parameterized} parameterized field(s)${gen.csvFile ? ` → ${gen.csvFile}` : ''}, ` +
            `${gen.stats.clientSideGhosts} client-side value(s) regenerated, ` +
            `${gen.stats.pollingLoops} polling loop(s), ${gen.stats.orphans} orphan(s)`);
        rec(`USE THIS JMX -> ${path.basename(finalMarker.finalCopyPath)}`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        const verdict = runAttemptError ? 'not verified' : 'generated';
        const reportPath = writeHtmlReport(outDir, name, {
            mode: runAttemptError ? `${DO_AGENT ? 'agent validate' : 'generate + validate'} attempted (${mode})` : `generate only (${mode})`,
            verdict,
            stats: gen.stats, samples: [],
            correlations: gen.correlations || [],
            dualHar: notes.dualHar || null,
            loadProfile: gen.loadProfile || null,
            reasoning: gen.reasoning || [],
        });
        outputOrganizer.organizeOutput({
            outDir,
            name,
            verdict,
            finalJmxPath: finalMarker.finalCopyPath,
            reportPath,
        });
        rec(`open ${name}_report.html for a summary`);
        return { success: !runAttemptError, verdict };
    } catch (e) {
        rec(`GENERATE FAILED: ${e.message}`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        return { success: false, verdict: 'generate failed' };
    }
    fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
    return { success: false, verdict: 'failed' };
}

async function scanOnce() {
    const allInputFiles = fs.readdirSync(INPUT)
        .filter(f => !f.startsWith('.'))
        .map(f => path.join(INPUT, f));
    const processable = allInputFiles.filter(f => /\.(har|jmx|xml|jtl)$/i.test(f));
    const analysis = analyzeInputFiles(allInputFiles);
    if (analysis.inventory.length || analysis.issues.length) {
        fs.writeFileSync(path.join(OUTPUT, 'input_inventory.json'), JSON.stringify({
            generatedAt: new Date().toISOString(),
            inventory: analysis.inventory,
            issues: analysis.issues,
            units: analysis.units.map(u => ({
                name: u.name,
                kind: u.kind,
                primary: path.basename(u.primary || ''),
                secondary: u.secondary ? path.basename(u.secondary) : undefined,
                sidecars: u.sidecars,
            })),
        }, null, 2));
        writeIntakeArtifacts(OUTPUT, analysis);
    }
    for (const issue of analysis.issues) {
        log(`INPUT ISSUE [${issue.severity || 'info'}] ${issue.code}: ${issue.message}`);
    }
    const selection = selectUnits(analysis.units, SELECTED_INPUTS);
    for (const missing of selection.missing) {
        log(`INPUT ISSUE [warning] selected_input_not_found: ${missing} did not match any logical input unit or file.`);
    }
    let units = SELECTED_INPUTS.length ? selection.selected : analysis.units;
    // Manual dual-recording pairing (--pair): merge exactly two selected
    // single-recording units into one variance unit (for recordings not named
    // __run1/__run2). Two JMX → dual-jmx (sidecars carried); two HAR → dual-har.
    if (args.includes('--pair')) {
        if (units.length === 2) {
            try {
                const { mergeUnitsAsDual } = require('./src/ingest');
                units = [mergeUnitsAsDual(units[0], units[1])];
                log(`paired 2 recordings as a dual-recording variance run: ${units[0].name}`);
            } catch (e) { log(`INPUT ISSUE [warning] pair_failed: ${e.message}`); }
        } else {
            log(`INPUT ISSUE [warning] pair_needs_two: --pair requires exactly two selected recordings (got ${units.length}).`);
        }
    }
    const retryOptions = inputRetryOptions();
    // The processed-input skip / failed-run retry cap exists ONLY to keep
    // WATCH mode from reprocessing an unchanged file on every poll. An
    // explicit one-shot run — the UI's "Run selected", or any CLI run that
    // isn't --watch, or any run that names --input — is a deliberate request
    // to run NOW, so it must never be capped or skipped. (Marking still
    // happens below so watch mode stays correct.)
    const explicitRun = !WATCH || SELECTED_INPUTS.length > 0 || FORCE;
    const enforceInputState = USE_INPUT_STATE && !explicitRun;
    const fresh = units.filter(u => !processed.has(u.primary) && (!enforceInputState || inputState.shouldProcessUnit(u, processedState, retryOptions)));
    if (fresh.length === 0) {
        const idleMessage = buildIdleScanMessage({ processable, units, retryOptions, selectedInputs: SELECTED_INPUTS, missingInputs: selection.missing });
        const idleMessageKey = idleMessage.join('\n');
        if (!WATCH || idleMessageKey !== lastIdleScanMessageKey) {
            for (const line of idleMessage) log(line);
            lastIdleScanMessageKey = idleMessageKey;
        }
    }
    for (const u of fresh) {
        processed.add(u.primary);
        if (u.secondary) processed.add(u.secondary);
        if (u.sidecars?.primary) processed.add(u.sidecars.primary);
        if (u.sidecars?.secondary) processed.add(u.sidecars.secondary);
        const outcome = await processUnit(u);
        if (USE_INPUT_STATE) inputState.markUnitProcessed(u, processedState, processedStatePath, outcome || { success: false, verdict: 'failed' });
    }
}

function buildIdleScanMessage({ processable, units, retryOptions, selectedInputs = [], missingInputs = [] }) {
    if (selectedInputs.length && !units.length) {
        const available = processable.length ? ` Available recording-like files: ${processable.map(f => path.basename(f)).join(', ')}.` : '';
        const missing = missingInputs.length ? ` Missing selection(s): ${missingInputs.join(', ')}.` : '';
        return [`No selected input units matched this run.${missing}${available}`];
    }
    if (!processable.length) {
        return [`No HAR / JMX files in ${INPUT}. Drop recordings there and re-run.`];
    }
    if (units.length) {
        const listed = units.map(u => `${u.kind}:${u.name}`).join(', ');
        return [
            `Detected ${units.length} logical input unit(s), but none need processing: ${listed}.`,
            `They are unchanged according to ${processedStatePath} and have either succeeded or reached the failed-run retry cap (${retryOptions.maxFailedAttempts}).`,
            'Use --force to reprocess unchanged inputs, --retry-failed N to raise the cap, or edit/replace the input files.',
        ];
    }
    return [`Found ${processable.length} recording-like file(s), but none formed a runnable input unit. Review INPUT ISSUE lines and output/input_inventory.json.`];
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
    log(AI_ON
        ? 'AI assist: ON — the LLM may be consulted for unresolved failures (this can incur cost).'
        : 'AI assist: OFF — deterministic only. No LLM calls, no AI cost this run.');
    if (SELECTED_INPUTS.length) log(`selected input(s): ${SELECTED_INPUTS.join(', ')}`);
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
