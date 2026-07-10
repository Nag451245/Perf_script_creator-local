'use strict';
/**
 * rendered-request-check.js — GATE 0: verify what the script will actually
 * SEND, before trusting any response-side reasoning.
 *
 * The #1 blind spot a senior engineer never has: they read the request they
 * sent, not just the response. This agent read only responses, so a data
 * defect (a shifted CSV column feeding `${username}` a neighbouring value)
 * looked like an auth wall. Gate 0 closes that: it statically resolves every
 * `${var}` a sampler will transmit and proves it will render to a real,
 * correct value — deterministically, no live run required.
 *
 * Two failure classes, both proven from the JMX + CSV alone:
 *   1. UNDEFINED variable — a `${var}` in a path / arg / header with no
 *      producer (extractor refname, CSV column, UDV, or JMeter function). It
 *      will transmit the literal string `${var}`.
 *   2. CSV COLUMN SHIFT — the data CSV, parsed the way JMeter WILL parse it
 *      (its emitted delimiter + quotedData flag), yields a row whose column
 *      count ≠ the CSVDataSet's variableNames count. Every variable past the
 *      offending field then reads the wrong column — the exact class that
 *      made `${username}`/`${password}` send garbage and 400 every login.
 *
 * Findings are structured so the triage layer can classify a Gate-0 hit as a
 * DATA DEFECT (fixable, keep going) rather than an auth/session wall.
 */
const fs = require('fs');
const path = require('path');
const { knownDefinedVars } = require('./extractors');

const SENDABLE_PROP = /<stringProp\s+name="(HTTPSampler\.path|Argument\.value|Header\.value)">([^<]*)<\/stringProp>/g;
const VAR_REF = /\$\{([^}]+)\}/g;

/**
 * @param {Object} args
 * @param {string} args.xml     the generated JMX
 * @param {string} args.outDir  directory holding the CSV data files
 * @returns {{ ok: boolean, findings: Array, definedVars: string[] }}
 */
function checkRenderedRequests({ xml = '', outDir = '' } = {}) {
    const findings = [];
    // Defined = CSV columns + UDVs (knownDefinedVars) UNION every extractor's
    // refname. knownDefinedVars intentionally omits extractor outputs (it's a
    // "supplements the validator" helper), so Gate 0 must add them or it
    // false-flags every correlated ${var} (state, token, csrf, …) as literal.
    const defined = knownDefinedVars(xml, extractorRefNames(xml));

    // ── Class 2: CSV column-shift simulation ───────────────────────────
    for (const cds of matchAll(xml, /<CSVDataSet\b[\s\S]*?<\/CSVDataSet>/g)) {
        const block = cds[0];
        const filename = prop(block, 'filename');
        const delimiter = prop(block, 'delimiter') || ',';
        const quoted = /<boolProp name="quotedData">true<\/boolProp>/.test(block);
        const varNames = (prop(block, 'variableNames') || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
        if (!filename || !varNames.length) continue;
        const csvPath = resolveCsvPath(filename, outDir);
        if (!csvPath || !fs.existsSync(csvPath)) {
            findings.push({
                severity: 'error', kind: 'csv-missing', dataDefect: true,
                message: `CSV Data Set references "${filename}" which is not present next to the JMX — ${varNames.length} variable(s) will be empty at runtime.`,
                fix: 'Stage the CSV file next to the JMX (run.dataFiles) or regenerate.',
            });
            continue;
        }
        const rows = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.length);
        // Header row exists (we write it); JMeter reads it as data unless
        // ignoreFirstLine — but variableNames is set, so JMeter treats row 0 as
        // DATA. Either way the column count must equal variableNames on every row.
        for (let r = 0; r < rows.length; r++) {
            const cols = parseCsvLine(rows[r], delimiter, quoted);
            if (cols.length !== varNames.length) {
                findings.push({
                    severity: 'error', kind: 'csv-column-shift', dataDefect: true,
                    file: path.basename(csvPath), row: r,
                    message: `CSV row ${r} parses to ${cols.length} column(s) but the CSV Data Set declares ${varNames.length} variable(s) (delimiter="${delimiter}", quotedData=${quoted}). Columns will shift — variables read a neighbouring column's value.`,
                    fix: quoted
                        ? `A field contains an unescaped delimiter/newline; re-quote the data or change the delimiter.`
                        : `Set quotedData=true on the CSV Data Set (a field is RFC-4180-quoted but JMeter is reading the quotes literally).`,
                });
                break; // one finding per data set is enough
            }
        }
    }

    // ── Class 1: undefined variables in what an ENABLED sampler will SEND ─
    // Only enabled samplers transmit — a literal ${var} inside a DISABLED
    // plumbing sampler (e.g. a folded /oauth/token carrying ${access_token})
    // is never sent, so it is not a defect and must not block. A sampler's
    // send-fields (path, Argument.value inside it; Header.value in its
    // hashTree) all appear AFTER its open tag and before the NEXT sampler's,
    // so each send-field is attributed to the nearest preceding sampler.
    const samplerTags = [];
    for (const m of matchAll(xml, /<HTTPSamplerProxy\b([^>]*)>/g)) {
        samplerTags.push({ index: m.index, disabled: /enabled="false"/.test(m[1] || '') });
    }
    const nearestSamplerDisabled = (pos) => {
        let disabled = false;
        for (const t of samplerTags) { if (t.index > pos) break; disabled = t.disabled; }
        return disabled;
    };
    const undefinedRefs = new Map(); // varName -> sample of where it's used
    for (const m of matchAll(xml, SENDABLE_PROP)) {
        if (nearestSamplerDisabled(m.index)) continue;
        const text = m[2];
        for (const ref of matchAll(text, VAR_REF)) {
            const raw = ref[1].trim();
            if (isFunctionOrExpr(raw)) continue;         // ${__UUID}, ${__time(...)} etc.
            const name = raw.split(/[.,|]/)[0].trim();    // ${var,default} / ${var}
            if (!name || defined.has(name)) continue;
            if (!undefinedRefs.has(name)) undefinedRefs.set(name, snippet(text));
        }
    }
    for (const [name, where] of undefinedRefs) {
        findings.push({
            severity: 'error', kind: 'undefined-variable', dataDefect: true,
            variable: name,
            message: `\${${name}} is referenced in a request but has no producer (no extractor, CSV column, or UDV). It will transmit the literal string "\${${name}}".`,
            evidence: where,
            fix: `Correlate \${${name}} from its producing response, add it as a CSV column / UDV, or replace it with the recorded literal.`,
        });
    }

    return { ok: findings.length === 0, findings, definedVars: [...defined] };
}

/** JMeter-faithful CSV line split. quoted=true → RFC-4180; else naive split. */
function parseCsvLine(line, delimiter, quoted) {
    if (!quoted) return line.split(delimiter);
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === delimiter) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

/** Every variable an extractor produces (its refname / referenceNames). */
function extractorRefNames(xml) {
    const names = [];
    const patterns = [
        /<stringProp\s+name="RegexExtractor\.refname">([^<]+)<\/stringProp>/g,
        /<stringProp\s+name="HtmlExtractor\.refname">([^<]+)<\/stringProp>/g,
        /<stringProp\s+name="BoundaryExtractor\.refname">([^<]+)<\/stringProp>/g,
        /<stringProp\s+name="XPath2Extractor\.refname">([^<]+)<\/stringProp>/g,
        /<stringProp\s+name="XPathExtractor\.refname">([^<]+)<\/stringProp>/g,
        /<stringProp\s+name="JSONPostProcessor\.referenceNames">([^<]+)<\/stringProp>/g,
    ];
    for (const re of patterns) {
        for (const m of matchAll(xml, re)) {
            for (const n of m[1].split(/[;,]/).map(s => s.trim()).filter(Boolean)) names.push(n);
        }
    }
    // JSR223 vars.put('name', …) — rare, usually stripped, but count it.
    for (const m of matchAll(xml, /vars\.put\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) names.push(m[1]);
    return names;
}

function isFunctionOrExpr(raw) {
    return raw.startsWith('__') || raw.includes('(') || raw.includes('${');
}
function resolveCsvPath(filename, outDir) {
    const base = path.basename(String(filename).replace(/\\\\/g, '/'));
    return outDir ? path.join(outDir, base) : base;
}
function prop(block, name) {
    const m = block.match(new RegExp(`<stringProp\\s+name="${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}">([\\s\\S]*?)<\\/stringProp>`));
    return m ? m[1] : '';
}
function snippet(s) { return String(s).slice(0, 80); }
function* matchAll(str, re) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m; while ((m = r.exec(str)) !== null) yield m;
}

module.exports = { checkRenderedRequests, _internal: { parseCsvLine, isFunctionOrExpr } };
