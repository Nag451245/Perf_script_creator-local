'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nextAction } = require('./run-summary');

/** Soft-wrap a sentence so a plain-text file stays readable in Notepad. */
function wrap(text, width = 78) {
    const words = String(text || '').split(/\s+/);
    const out = []; let line = '';
    for (const w of words) {
        if (line && (line + ' ' + w).length > width) { out.push(line); line = w; }
        else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(line);
    return out.join('\n');
}

/**
 * Last-line-of-defence sanitizer, applied to the EXACT bytes shipped as
 * 00_USE_THIS_FINAL. Repair/patch rounds (including engine-internal ones we
 * cannot modify) have re-introduced two defect classes into the final even
 * when the generated base was clean:
 *   1. parameter-substring corruption — a short recorded value substituted
 *      globally (userName "AshtonK" -> "Asht${includeDailyNoteClick}K");
 *      detected by a ${var} appearing grossly more often than its field's
 *      recorded occurrences, reverted by restoring the literal (exactly
 *      reverses the substitution).
 *   2. re-enabled folded samplers — beacons/noise/redirect hops the generation
 *      pass disabled coming back enabled; re-asserted from the base JMX
 *      (anything generation disabled must stay disabled).
 * Inputs are read from outDir artifacts so EVERY ship path is covered.
 */
function sanitizeFinalXml(xml, { outDir, name }) {
    let out = String(xml || '');
    const notes = [];
    // 1. parameter corruption revert (same rule as generate's detector).
    try {
        const paramsPath = path.join(outDir, `${name}_parameters.json`);
        if (fs.existsSync(paramsPath)) {
            const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
            for (const p of Array.isArray(params) ? params : []) {
                const varName = p.variableName || p.name;
                const value = String(p.value == null ? '' : p.value);
                if (!varName || !value) continue;
                const ref = '${' + varName + '}';
                const refCount = out.split(ref).length - 1;
                if (refCount === 0) continue;
                const expected = Number(p.occurrences) || null;
                const suspicious = expected != null
                    ? refCount > Math.max(expected * 3, expected + 6)
                    : (value.length < 6 && refCount > 8);
                if (!suspicious) continue;
                out = out.split(ref).join(value);
                notes.push(`reverted \${${varName}} (${refCount} substitutions for a field recorded ~${expected ?? '?'}x — substring corruption)`);
            }
        }
        // Orphan/stale corruption: a ${var} present MANY times that neither an
        // extractor nor the CURRENT parameter set produces. Deliberately do NOT
        // trust the final's own CSVDataSet variableNames — a stale patch-round
        // CSV block can still list a parameter the current pipeline dropped
        // (includeDailyNoteClick), whose column no longer exists in the data
        // file, so every reference would resolve to nothing at runtime.
        const defined = new Set();
        for (const m of out.matchAll(/(?:refname|referenceNames)">([^<]+)</g)) {
            for (const c of m[1].split(/[,;]/)) if (c.trim()) defined.add(c.trim());
        }
        try {
            const pp = path.join(outDir, `${name}_parameters.json`);
            if (fs.existsSync(pp)) {
                for (const p of JSON.parse(fs.readFileSync(pp, 'utf8')) || []) {
                    const nm = p && (p.variableName || p.name);
                    if (nm) defined.add(nm);
                }
            }
        } catch { /* fall through to recording recovery */ }
        const counts = new Map();
        for (const m of out.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
            counts.set(m[1], (counts.get(m[1]) || 0) + 1);
        }
        // Orphan corruption: a ${var} substituted MANY times with NO producer
        // (no CSV column, no extractor) — an old/engine-side parameterization
        // whose value my filter later dropped. The recorded literal is still in
        // the recording (the form field "var=value"); recover it and revert.
        for (const [varName, n] of counts) {
            if (n <= 40 || defined.has(varName)) continue;
            const recovered = recordedLiteralFor(varName, outDir, name);
            if (recovered != null) {
                out = out.split('${' + varName + '}').join(recovered);
                notes.push(`reverted orphan \${${varName}} (${n} substitutions, no producer) to recorded literal "${recovered}"`);
            } else {
                notes.push(`WARNING: \${${varName}} appears ${n}x with no producer and no recoverable literal — inspect manually`);
            }
        }
    } catch { /* sanitation is best-effort; never block shipping */ }
    // 2. re-assert generation's disables from the base JMX.
    try {
        const basePath = path.join(outDir, `${name}.jmx`);
        if (fs.existsSync(basePath)) {
            const base = fs.readFileSync(basePath, 'utf8');
            const disabled = new Set();
            for (const m of base.matchAll(/<HTTPSamplerProxy\b([^>]*)>/g)) {
                const attrs = m[1] || '';
                if (!/enabled="false"/.test(attrs)) continue;
                const nm = (attrs.match(/testname="([^"]*)"/) || [])[1];
                if (nm) disabled.add(nm.trim());
            }
            let reasserted = 0;
            out = out.replace(/<HTTPSamplerProxy\b([^>]*)>/g, (whole, attrs) => {
                const nm = ((attrs.match(/testname="([^"]*)"/) || [])[1] || '').trim();
                if (nm && disabled.has(nm) && /enabled="true"/.test(attrs)) {
                    reasserted++;
                    return whole.replace('enabled="true"', 'enabled="false"');
                }
                return whole;
            });
            if (reasserted) notes.push(`re-disabled ${reasserted} sampler(s) generation had folded (noise/beacons/hops re-enabled by a patch round)`);
        }
    } catch { /* best effort */ }
    return { xml: out, notes };
}

/** Most common recorded value of a form field, from the flow's recording.xml. */
function recordedLiteralFor(varName, outDir, name) {
    try {
        const rec = path.join(outDir, `${name}.recording.xml`);
        if (!fs.existsSync(rec)) return null;
        const text = fs.readFileSync(rec, 'utf8');
        const safe = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(safe + '=([^&"<\\s]{1,64})', 'g');
        const tally = new Map();
        let m;
        while ((m = re.exec(text)) !== null) {
            const v = m[1];
            if (v.includes('${')) continue;
            tally.set(v, (tally.get(v) || 0) + 1);
        }
        let best = null, bestN = 0;
        for (const [v, c] of tally) if (c > bestN) { best = v; bestN = c; }
        return best;
    } catch { return null; }
}

function fingerprintOf(xml) {
    return crypto.createHash('sha256').update(String(xml || ''), 'utf8').digest('hex');
}

/**
 * Was the final we shipped last time rewritten by something other than us?
 * The tell is a file whose hash no longer matches the fingerprint we recorded.
 * JMeter's serializer also leaves a mark: it emits HTTPSampler.postBodyRaw for
 * EVERY sampler, while generation only writes it where a raw body exists.
 * @returns {{external:boolean, byJMeter:boolean, previousHash:string}|null}
 */
function detectExternalEdit({ finalCopyPath, outDir, safeName }) {
    try {
        const fpPath = path.join(outDir, `${safeName}_final_fingerprint.json`);
        if (!fs.existsSync(finalCopyPath) || !fs.existsSync(fpPath)) return null;
        const prev = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
        const onDisk = fs.readFileSync(finalCopyPath, 'utf8');
        const hash = fingerprintOf(onDisk);
        if (!prev.sha256 || hash === prev.sha256) return null;
        const samplers = (onDisk.match(/<HTTPSamplerProxy\b/g) || []).length;
        const rawBodyProps = (onDisk.match(/HTTPSampler\.postBodyRaw/g) || []).length;
        return {
            external: true,
            byJMeter: samplers > 0 && rawBodyProps >= samplers,
            previousHash: prev.sha256,
            writtenAt: prev.writtenAt || '',
        };
    } catch { return null; }
}

function writeFinalJmxPointer({
    outDir,
    name,
    finalJmxPath,
    verdict = 'generated',
    validated = false,
    businessVerified = false,
    reportPath = '',
    currentJtlPath = '',
    labelMapPath = '',
    manifestPath = '',
    greenGate = null,
    blockers = [],
    continuation = null,
    changeSummary = '',
} = {}) {
    if (!outDir || !name || !finalJmxPath) {
        throw new Error('outDir, name, and finalJmxPath are required');
    }
    if (!fs.existsSync(finalJmxPath)) {
        throw new Error(`final JMX not found: ${finalJmxPath}`);
    }

    fs.mkdirSync(outDir, { recursive: true });
    const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
    // ONE STABLE NAME. The old name baked the verdict and the flow into the
    // filename — 75 characters that CHANGED between runs, so a folder ended up
    // with several near-identical scripts and an editor could sit on a stale
    // one. The status belongs in the report, not in the thing you double-click.
    const finalName = '00_RUN_THIS_SCRIPT.jmx';
    const finalCopyPath = path.join(outDir, finalName);
    // Sanitize the exact shipped bytes (corruption revert + re-assert folds) —
    // repair rounds can hand back a re-substituted / re-enabled JMX even when
    // the generated base was clean.
    const sanitized = sanitizeFinalXml(fs.readFileSync(finalJmxPath, 'utf8'), { outDir, name });
    // Clear any leftover read-only flag (an earlier build locked finals; the
    // lock blocked the USER's own JMeter saves, so protection now rests on the
    // patchAbortRef kill-switch that halts the abandoned engine loop instead).
    try { if (fs.existsSync(finalCopyPath)) fs.chmodSync(finalCopyPath, 0o666); } catch { /* first write */ }

    // STALE-EDITOR DETECTION. The deliverable keeps a stable name, so JMeter is
    // usually holding the PREVIOUS run's version of this exact path in memory —
    // and JMeter never reloads a file changed on disk. Saving from that stale
    // buffer silently writes the old plan (hardcoded tokens and all) back over
    // a freshly corrected script; the user then sees "the script did not get
    // updated" and blames the agent. We cannot stop an external editor and must
    // not lock the file (that blocks the user's own saves), so: fingerprint
    // what we ship, and notice when what is on disk is not it.
    const shipped = fingerprintOf(sanitized.xml);
    const stale = detectExternalEdit({ finalCopyPath, outDir, safeName });
    fs.writeFileSync(finalCopyPath, sanitized.xml);
    fs.writeFileSync(path.join(outDir, `${safeName}_final_fingerprint.json`), JSON.stringify({
        file: finalName,
        sha256: shipped,
        bytes: Buffer.byteLength(sanitized.xml),
        writtenAt: new Date().toISOString(),
        note: 'If the file no longer matches this hash, something outside the agent rewrote it (most often a JMeter save from a buffer opened before this run). Reopen the file in JMeter before trusting what you see.',
    }, null, 2));
    if (sanitized.notes.length) {
        fs.writeFileSync(path.join(outDir, `${safeName}_final_sanitizer.json`), JSON.stringify(sanitized.notes, null, 2));
    }

    // The first thing anyone reads should answer "what do I do now?", not make
    // them interpret a status word. Action first, then why, then the details.
    const guidePath = path.join(outDir, '00_OPEN_THIS_FIRST.txt');
    const action = nextAction({ verdict, gate: greenGate, blockers, continuation, validated });
    const lines = [
        action.headline.toUpperCase(),
        '',
        ...(action.detail ? [wrap(action.detail), ''] : []),
        ...(changeSummary ? [wrap(changeSummary), ''] : []),
        ...(stale && stale.external ? [
            stale.byJMeter
                ? wrap('!! JMeter rewrote the previous version of this file after the agent produced it (a save from a buffer opened before that run). If it is still open in JMeter, close it WITHOUT saving and reopen it — otherwise saving will put the OLD script back.')
                : wrap('!! The previous version of this file was modified outside the agent. It has been replaced; reopen it wherever it is still open.'),
            '',
        ] : []),
        'WHAT TO OPEN',
        `  The script .......... ${finalName}`,
        `  Everything else ..... ${path.basename(reportPath || `${safeName}_report.html`)}  (open in a browser)`,
        // Only name the CSV when there is one — pointing at a file that was
        // never generated reads as a missing file, not as "this flow has no
        // data pool".
        ...(fs.existsSync(path.join(outDir, `${safeName}_data.csv`))
            ? [`  Test data ........... ${safeName}_data.csv  (keep it beside the script)`]
            : []),
        '',
        `Verdict: ${verdict}   ·   JMeter validation: ${validated ? 'RAN' : 'NOT RUN'}`,
        '',
        businessVerified
            ? 'Business check: confirmed by an explicit business assertion.'
            : wrap('Business check: a green HTTP result only means the enabled requests answered. It does not prove the business record was created unless an explicit assertion checked it, or you confirm the record in the app.'),
        '',
        'If you need to dig:',
        '  reports/   gate verdicts',
        '  evidence/  label map, recording, parameters',
        '  results/   JTL data JMeter reads',
        '  scripts/   a backup copy of the script, and the pre-repair original',
        '  log.txt    the full run log',
    ];
    fs.writeFileSync(guidePath, lines.join('\n') + '\n');

    return { finalCopyPath, guidePath, staleEditorWarning: stale, action };
}

module.exports = { writeFinalJmxPointer, _internal: { sanitizeFinalXml } };
