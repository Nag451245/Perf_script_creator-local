#!/usr/bin/env node
'use strict';
/**
 * eval.js — regression corpus for the AGENT's judgment, not just its code.
 *
 * Unit tests pin functions; this pins OUTCOMES: for each corpus flow, does
 * generation still produce the expected number of samplers, correlations,
 * form-input wirings, zero orphans, the outcome probe, the playbook hits?
 * Every correlator tweak in this repo's history that later regressed
 * (`git log --grep=revert`) would have been caught here.
 *
 * Layout:  eval-corpus/<flow>/
 *            *.har | *__run1.har + *__run2.har   (inputs)
 *            expected.json                        ({ runCfg?, stats: {...} })
 *
 * expected.stats values: a number → exact match; {min,max} → inclusive range.
 * Real customer recordings must stay OUT of git — commit only synthetic
 * fixtures; local-only corpora go in "eval-corpus/local-..." dirs (gitignored).
 *
 * Usage: npm run eval
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'eval-corpus');
const { groupInputs, loadUnit } = require('../src/ingest');
const { generate } = require('../src/generate');

async function main() {
    if (!fs.existsSync(CORPUS)) {
        console.log('No eval-corpus/ directory — nothing to evaluate.');
        return 0;
    }
    const flows = fs.readdirSync(CORPUS).filter(d => {
        try { return fs.statSync(path.join(CORPUS, d)).isDirectory() && fs.existsSync(path.join(CORPUS, d, 'expected.json')); }
        catch { return false; }
    });
    if (!flows.length) {
        console.log('eval-corpus/ has no flows with expected.json — nothing to evaluate.');
        return 0;
    }

    let failures = 0;
    for (const flow of flows) {
        const dir = path.join(CORPUS, flow);
        const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
        const files = fs.readdirSync(dir)
            .filter(f => /\.(har|jmx|xml|jtl)$/i.test(f))
            .map(f => path.join(dir, f));
        const units = groupInputs(files);
        if (!units.length) { console.error(`✖ ${flow}: no ingestible inputs`); failures++; continue; }

        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `psl-eval-${flow}-`));
        try {
            const { entries, secondaryEntries, pages, notes } = await loadUnit(units[0]);
            const gen = generate(entries, pages, outDir, flow, {
                dualHarHints: notes, secondaryEntries,
                runCfg: expected.runCfg || {},
            });
            const problems = compareStats(expected.stats || {}, gen.stats);
            if (problems.length) {
                failures++;
                console.error(`✖ ${flow}:`);
                for (const p of problems) console.error(`    ${p}`);
            } else {
                console.log(`✔ ${flow} — ${Object.keys(expected.stats || {}).length} expectation(s) hold`);
            }
        } catch (e) {
            failures++;
            console.error(`✖ ${flow}: generation threw — ${e.message}`);
        } finally {
            try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }

    console.log(failures ? `\nEVAL FAILED — ${failures}/${flows.length} flow(s) regressed.` : `\nEVAL PASSED — ${flows.length} flow(s).`);
    return failures ? 1 : 0;
}

function compareStats(expected, actual) {
    const problems = [];
    for (const [key, want] of Object.entries(expected)) {
        const got = valueAt(actual, key);
        if (typeof want === 'number') {
            if (got !== want) problems.push(`${key}: expected ${want}, got ${got}`);
        } else if (want && typeof want === 'object' && ('min' in want || 'max' in want)) {
            if ('min' in want && !(got >= want.min)) problems.push(`${key}: expected >= ${want.min}, got ${got}`);
            if ('max' in want && !(got <= want.max)) problems.push(`${key}: expected <= ${want.max}, got ${got}`);
        } else if (typeof want === 'boolean') {
            if (!!got !== want) problems.push(`${key}: expected ${want}, got ${!!got} (${JSON.stringify(got)})`);
        }
    }
    return problems;
}

function valueAt(obj, dottedKey) {
    return dottedKey.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

main().then(code => process.exit(code)).catch(e => { console.error('EVAL FATAL:', e.stack); process.exit(1); });
