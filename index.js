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
const { HarParser, orchestrator, jmeterDetector, recordingXml } = require('./src/engine');

const ROOT = __dirname;
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');

const args = process.argv.slice(2);
const DO_RUN = args.includes('--run');
const WATCH = args.includes('--watch');

// Optional local config (gitignored). Holds machine/run settings + secrets
// so nothing has to be passed on the command line. See
// perfscript.config.example.json. Secrets can also come from the environment.
function loadConfig() {
    const p = path.join(ROOT, 'perfscript.config.json');
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { log(`WARNING: perfscript.config.json is not valid JSON (${e.message}) — ignoring it.`); return {}; }
}
const CONFIG = loadConfig();

// JMeter location: config wins, then existing env. Set it for the engine's
// detector before it runs.
if (CONFIG.jmeterHome && !process.env.JMETER_HOME) process.env.JMETER_HOME = CONFIG.jmeterHome;
// Gemini key for Phase 4 escalation (read by the engine's ai-service).
if (CONFIG.gemini && CONFIG.gemini.apiKey && !process.env.GOOGLE_API_KEY) {
    process.env.GOOGLE_API_KEY = CONFIG.gemini.apiKey;
}

const iterFlag = args.indexOf('--iterations');
const MAX_ITER = iterFlag >= 0
    ? Math.min(5, Math.max(1, Number(args[iterFlag + 1]) || 3))
    : Math.min(5, Math.max(1, Number(CONFIG.maxIterations) || 3));

const processed = new Set();

function log(line) { process.stdout.write(`${line}\n`); }
function safeName(file) {
    return path.basename(file).replace(/\.har$/i, '').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60);
}

async function processHar(file) {
    const name = safeName(file);
    const outDir = path.join(OUTPUT, name);
    fs.mkdirSync(outDir, { recursive: true });
    const lines = [];
    const rec = (s) => { lines.push(s); log(`   ${s}`); };

    log(`\n▶ ${path.basename(file)}`);
    let har;
    try {
        har = new HarParser().parseFromBuffer(fs.readFileSync(file));
    } catch (e) {
        rec(`PARSE FAILED: ${e.message}`);
        fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
        return;
    }
    const entries = (har.log && har.log.entries) || [];
    const pages = (har.log && har.log.pages) || [];
    rec(`parsed ${entries.length} entries, ${pages.length} pages`);

    // Recording XML sidecar (full request/response bodies for reference).
    try {
        fs.writeFileSync(
            path.join(outDir, `${name}.recording.xml`),
            recordingXml.generate(entries, { sourceFile: name })
        );
        rec('wrote recording.xml');
    } catch (e) { rec(`recording.xml skipped: ${e.message}`); }

    if (DO_RUN) {
        const jmeterBinPath = jmeterDetector.detect();
        if (!jmeterBinPath) {
            rec('JMeter not found — set JMETER_HOME or add jmeter to PATH. Falling back to generate-only.');
        } else {
            rec(`JMeter: ${jmeterBinPath} — running bounded feedback loop (max ${MAX_ITER})…`);
            try {
                const result = await orchestrator.runAgent({
                    entries, pages, jmeterBinPath, maxIterations: MAX_ITER,
                    outputDir: outDir, sourceName: name,
                    onIteration: (s) => rec(`  [iter] ${JSON.stringify(s).slice(0, 200)}`),
                });
                fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(result, null, 2));
                rec(`DONE — success=${result.success} iterations=${result.iterationsRun} ` +
                    `passed/failed not shown here; see report.json`);
                fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
                return;
            } catch (e) {
                rec(`feedback loop error: ${e.message} — falling back to generate-only.`);
            }
        }
    }

    // Generate-only path.
    try {
        const gen = orchestrator.generateCorrelatedJmx(entries, pages, outDir, name);
        fs.writeFileSync(path.join(outDir, `${name}_report.json`), JSON.stringify(gen.stats, null, 2));
        rec(`generated JMX — ${gen.stats.samplers} samplers, ${gen.stats.correlations} correlations, ` +
            `${gen.stats.orphans} orphan(s)`);
    } catch (e) {
        rec(`GENERATE FAILED: ${e.message}`);
    }
    fs.writeFileSync(path.join(outDir, 'log.txt'), lines.join('\n'));
}

async function scanOnce() {
    const files = fs.readdirSync(INPUT).filter(f => /\.har$/i.test(f)).map(f => path.join(INPUT, f));
    const fresh = files.filter(f => !processed.has(f));
    if (fresh.length === 0 && !WATCH) {
        log(`No .har files in ${INPUT}. Drop recordings there and re-run.`);
    }
    for (const f of fresh) { processed.add(f); await processHar(f); }
}

(async () => {
    fs.mkdirSync(INPUT, { recursive: true });
    fs.mkdirSync(OUTPUT, { recursive: true });
    log(`perfscript-local — mode: ${DO_RUN ? 'generate + run/validate' : 'generate only'}${WATCH ? ' (watch)' : ''}`);
    log(`engine: ${require('./src/engine').ENGINE_ROOT}`);
    await scanOnce();
    if (WATCH) {
        log(`\nWatching ${INPUT} … (Ctrl+C to stop)`);
        setInterval(scanOnce, 3000);
    } else {
        log('\nDone.');
    }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
