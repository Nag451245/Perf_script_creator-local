'use strict';

const fs = require('fs');
const path = require('path');

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
} = {}) {
    if (!outDir || !name || !finalJmxPath) {
        throw new Error('outDir, name, and finalJmxPath are required');
    }
    if (!fs.existsSync(finalJmxPath)) {
        throw new Error(`final JMX not found: ${finalJmxPath}`);
    }

    fs.mkdirSync(outDir, { recursive: true });
    const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
    const status = validated
        ? (verdict === 'GREEN' ? 'FINAL_VALIDATED' : 'FINAL_NEEDS_ATTENTION')
        : 'FINAL_GENERATED_NOT_VALIDATED';
    const finalName = `00_USE_THIS_${status}_${safeName}.jmx`;
    const finalCopyPath = path.join(outDir, finalName);
    // Sanitize the exact shipped bytes (corruption revert + re-assert folds) —
    // repair rounds can hand back a re-substituted / re-enabled JMX even when
    // the generated base was clean.
    const sanitized = sanitizeFinalXml(fs.readFileSync(finalJmxPath, 'utf8'), { outDir, name });
    // Clear any leftover read-only flag (an earlier build locked finals; the
    // lock blocked the USER's own JMeter saves, so protection now rests on the
    // patchAbortRef kill-switch that halts the abandoned engine loop instead).
    try { if (fs.existsSync(finalCopyPath)) fs.chmodSync(finalCopyPath, 0o666); } catch { /* first write */ }
    fs.writeFileSync(finalCopyPath, sanitized.xml);
    if (sanitized.notes.length) {
        fs.writeFileSync(path.join(outDir, `${safeName}_final_sanitizer.json`), JSON.stringify(sanitized.notes, null, 2));
    }

    const guidePath = path.join(outDir, '00_OPEN_THIS_FIRST.txt');
    const lines = [
        `USE THIS JMX: ${finalName}`,
        '',
        `Verdict: ${verdict}`,
        `JMeter validation: ${validated ? 'RAN' : 'NOT RUN'}`,
        `Source JMX: ${path.basename(finalJmxPath)}`,
        `Report: ${path.basename(reportPath || `${safeName}_report.html`)}`,
        `Current JTL: ${currentJtlPath ? path.basename(currentJtlPath) : 'final.jtl'}`,
        `PE label map: ${labelMapPath ? path.basename(labelMapPath) : `${safeName}_label_map.json`}`,
        `Output manifest: ${manifestPath ? path.basename(manifestPath) : 'output_manifest.json'}`,
        'Run log: log.txt',
        '',
        validated
            ? 'This JMX is the final file selected by the agent after the JMeter feedback loop.'
            : 'This JMX was generated but not proven by a JMeter validation run.',
        '',
        businessVerified
            ? 'Business check: confirmed by an explicit business assertion.'
            : 'Business check: HTTP GREEN only means enabled HTTP requests passed. It does not prove the business record was created unless the report/recording contains an explicit create assertion or you confirm the record in the app.',
        '',
        'Folder guide:',
        '- scripts/  final and generated JMX copies',
        '- reports/  HTML, markdown, and gate summaries',
        '- results/  JTL and runtime result artifacts',
        '- evidence/ label map, forensics, lineage, and reasoning evidence',
        '- data/     CSV data pools and upload staging references',
        '',
        'Keep the root-level files for compatibility/debugging; open the 00_USE_THIS... file in JMeter first.',
    ];
    fs.writeFileSync(guidePath, lines.join('\n') + '\n');

    return { finalCopyPath, guidePath };
}

module.exports = { writeFinalJmxPointer, _internal: { sanitizeFinalXml } };
