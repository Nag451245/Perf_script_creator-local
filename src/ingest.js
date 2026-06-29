'use strict';
/**
 * ingest.js — polyglot input router (HAR / JMX+recording / dual-HAR / dual-JMX).
 *
 * Ponytail: every parser already exists in the engine. This file only DECIDES
 * which engine module to call based on what the user dropped, and pairs files
 * that belong together. It returns a uniform `{ entries, pages, mode, notes }`
 * tuple so the rest of the pipeline doesn't care how the bytes arrived.
 *
 * Pairing rules (deterministic; no config required):
 *   foo.jmx       + foo.recording.xml | foo.jtl    -> JMX + JTL response side
 *   foo__run1.har + foo__run2.har                  -> dual-recording variance run
 *                                                     (canonical entries = run1;
 *                                                      dynamics carried as `notes.dynamicsByValue`)
 *   foo__run1.jmx + foo__run2.jmx (+ sidecars)     -> dual-recording variance run,
 *                                                     JMX flavour. Each JMX is
 *                                                     parsed to HAR shape; its
 *                                                     sidecar fills in the
 *                                                     response side; we then
 *                                                     run the SAME HarComparator
 *                                                     used for dual-HAR.
 *   foo.har                                        -> single HAR (status quo)
 *
 * A second-recording is not used as a separate generation input — it feeds
 * HarComparator to enrich what we know about which values are dynamic vs static
 * (the Phase 1 contribution from ARCHITECTURE.md). Generation still proceeds
 * from the canonical (first) recording so the output is reproducible.
 */
const fs = require('fs');
const path = require('path');
const { HarParser, jmxSource, jtlParser, harComparator: HarComparator } = require('./engine');

// File-extension recognition. Recording sidecars for JMX are JMeter-style JTLs
// (or our own recording.xml, which uses the same testResults schema), so we
// treat both as the same "response side" input.
const HAR_RE = /\.har$/i;
const JMX_RE = /\.jmx$/i;
const JTL_SIDECAR_SUFFIXES = ['.recording.xml', '.jtl', '.xml'];

function baseName(file) {
    return path.basename(file).replace(/\.(har|jmx)$/i, '').replace(/\.recording$/i, '');
}

function findSidecarFor(jmxFile, allFiles) {
    const dir = path.dirname(jmxFile);
    const stem = path.basename(jmxFile).replace(/\.jmx$/i, '');
    for (const suf of JTL_SIDECAR_SUFFIXES) {
        const candidate = path.join(dir, stem + suf);
        if (fs.existsSync(candidate)) return candidate;
    }
    // Also accept any same-stem .xml/.jtl uploaded into the SAME folder even
    // if naming differs slightly (case-insensitive prefix match).
    const stemLc = stem.toLowerCase();
    return allFiles.find(f =>
        path.dirname(f) === dir &&
        /\.(xml|jtl)$/i.test(f) &&
        path.basename(f).toLowerCase().startsWith(stemLc)
    ) || null;
}

/**
 * Group files in a folder into logical ingest units. One call per logical unit
 * downstream. Files are CONSUMED only once.
 *
 * @returns {Array<{
 *   name: string,
 *   kind: 'har'|'jmx'|'dual-har'|'dual-jmx',
 *   primary: string, secondary?: string,
 *   sidecars?: { primary?: string, secondary?: string }
 * }>}
 */
function groupInputs(files) {
    const units = [];
    const consumed = new Set();

    // 1) Dual-HAR pairs: foo__run1.har + foo__run2.har (or _run1 / _run2).
    const harPairRe = /^(.+?)[_]{1,2}run([12])\.har$/i;
    const harPairs = new Map();
    for (const f of files) {
        if (!HAR_RE.test(f)) continue;
        const m = path.basename(f).match(harPairRe);
        if (!m) continue;
        const cur = harPairs.get(m[1]) || {};
        cur[`run${m[2]}`] = f;
        harPairs.set(m[1], cur);
    }
    for (const [stem, p] of harPairs.entries()) {
        if (p.run1 && p.run2) {
            units.push({ name: stem, kind: 'dual-har', primary: p.run1, secondary: p.run2 });
            consumed.add(p.run1); consumed.add(p.run2);
        }
    }

    // 2) Dual-JMX pairs: foo__run1.jmx + foo__run2.jmx (each with its sidecar,
    //    if present). Mirrors the dual-HAR semantics so the comparator gets a
    //    full request+response side from BOTH runs. Sidecar lookup reuses
    //    `findSidecarFor` so the rules are identical to the single-JMX path.
    const jmxPairRe = /^(.+?)[_]{1,2}run([12])\.jmx$/i;
    const jmxPairs = new Map();
    for (const f of files) {
        if (!JMX_RE.test(f)) continue;
        const m = path.basename(f).match(jmxPairRe);
        if (!m) continue;
        const cur = jmxPairs.get(m[1]) || {};
        cur[`run${m[2]}`] = f;
        jmxPairs.set(m[1], cur);
    }
    for (const [stem, p] of jmxPairs.entries()) {
        if (!(p.run1 && p.run2)) continue;
        const s1 = findSidecarFor(p.run1, files);
        const s2 = findSidecarFor(p.run2, files);
        units.push({
            name: stem, kind: 'dual-jmx',
            primary: p.run1, secondary: p.run2,
            sidecars: { primary: s1 || undefined, secondary: s2 || undefined },
        });
        consumed.add(p.run1); consumed.add(p.run2);
        if (s1) consumed.add(s1);
        if (s2) consumed.add(s2);
    }

    // 3) Single JMX (+ optional response-side sidecar). JTL/XML sidecars are
    //    consumed so they don't also surface as standalone inputs.
    for (const f of files) {
        if (consumed.has(f) || !JMX_RE.test(f)) continue;
        const sidecar = findSidecarFor(f, files);
        units.push({ name: baseName(f), kind: 'jmx', primary: f, secondary: sidecar || undefined });
        consumed.add(f);
        if (sidecar) consumed.add(sidecar);
    }

    // 4) Single HAR — the original mode, still supported.
    for (const f of files) {
        if (consumed.has(f) || !HAR_RE.test(f)) continue;
        units.push({ name: baseName(f), kind: 'har', primary: f });
        consumed.add(f);
    }

    return units;
}

/**
 * Resolve one unit to canonical HAR-shape entries (+ optional companion data).
 *
 * @returns {Promise<{
 *   entries: Array, pages: Array, mode: string, notes: object, sourceFile: string
 * }>}
 */
async function loadUnit(unit) {
    const notes = {};
    if (unit.kind === 'har') {
        const har = new HarParser().parseFromBuffer(fs.readFileSync(unit.primary));
        return {
            entries: har.log?.entries || [],
            pages: har.log?.pages || [],
            mode: 'har', notes, sourceFile: unit.primary,
        };
    }

    if (unit.kind === 'dual-har') {
        const har1 = new HarParser().parseFromBuffer(fs.readFileSync(unit.primary));
        const har2 = new HarParser().parseFromBuffer(fs.readFileSync(unit.secondary));
        compareAndAnnotate(har1, har2, unit.secondary, notes, 'dualHar', 'dualHarError');
        return {
            entries: har1.log?.entries || [],
            pages: har1.log?.pages || [],
            mode: 'dual-har', notes, sourceFile: unit.primary,
        };
    }

    if (unit.kind === 'dual-jmx') {
        // Parse each JMX → HAR shape and stitch the response side from the
        // sidecar (recording.xml / .jtl) using the same engine helpers the
        // single-JMX path already uses. Then run HarComparator on the two
        // synthesized HARs. The first JMX is canonical so generation stays
        // reproducible (same rule as dual-har).
        const parseOne = (jmxPath, sidecarPath, label) => {
            const har = jmxSource.parseJmxToHar(
                fs.readFileSync(jmxPath), { sourceFilename: path.basename(jmxPath) }
            );
            let entries = har.log?.entries || [];
            const pages = har.log?.pages || [];
            let pairing = null;
            if (sidecarPath) {
                try {
                    const jtl = jtlParser.parseJtlBuffer(fs.readFileSync(sidecarPath));
                    const paired = jtlParser.pairJmxWithJtl(entries, jtl.byKey);
                    entries = paired.entries;
                    pairing = { paired: paired.paired, unmatched: paired.unmatched, sidecar: path.basename(sidecarPath) };
                } catch (e) {
                    notes[`${label}SidecarError`] = `failed to pair ${path.basename(sidecarPath)}: ${e.message}`;
                }
            }
            return { har: { log: { entries, pages } }, pairing };
        };

        const a = parseOne(unit.primary, unit.sidecars?.primary, 'jmx1');
        const b = parseOne(unit.secondary, unit.sidecars?.secondary, 'jmx2');
        if (a.pairing) notes.jmx1JtlPairing = a.pairing;
        if (b.pairing) notes.jmx2JtlPairing = b.pairing;

        compareAndAnnotate(a.har, b.har, unit.secondary, notes, 'dualJmx', 'dualJmxError');
        // Mirror under the dualHar key too so downstream code that only knows
        // dualHar (HTML report, hints) lights up automatically without growing
        // a parallel branch for the JMX flavour.
        if (notes.dualJmx) notes.dualHar = notes.dualJmx;
        if (notes.dualJmxError && !notes.dualHarError) notes.dualHarError = notes.dualJmxError;

        return {
            entries: a.har.log.entries,
            pages: a.har.log.pages,
            mode: 'dual-jmx', notes, sourceFile: unit.primary,
        };
    }

    if (unit.kind === 'jmx') {
        const jmxBuf = fs.readFileSync(unit.primary);
        const har = jmxSource.parseJmxToHar(jmxBuf, { sourceFilename: path.basename(unit.primary) });
        let entries = har.log?.entries || [];
        const pages = har.log?.pages || [];
        if (unit.secondary) {
            try {
                const jtlBuf = fs.readFileSync(unit.secondary);
                const jtl = jtlParser.parseJtlBuffer(jtlBuf);
                const paired = jtlParser.pairJmxWithJtl(entries, jtl.byKey);
                entries = paired.entries;
                notes.jmxJtl = { paired: paired.paired, unmatched: paired.unmatched, sidecar: path.basename(unit.secondary) };
            } catch (e) {
                notes.jmxJtlError = `failed to pair sidecar ${path.basename(unit.secondary)}: ${e.message}`;
            }
        }
        return { entries, pages, mode: 'jmx', notes, sourceFile: unit.primary };
    }

    throw new Error(`Unknown ingest kind: ${unit.kind}`);
}

/**
 * Run HarComparator on (har1, har2) and write the dynamic-value summary into
 * `notes[okKey]` (or `notes[errKey]` on failure). Shared by dual-HAR and
 * dual-JMX so they get the SAME enrichment without duplicating the
 * post-processing. Ponytail: comparator stays in the engine; we only normalize
 * its output shape for downstream phases.
 */
function compareAndAnnotate(har1, har2, secondaryPath, notes, okKey, errKey) {
    try {
        // HarComparator.compare() returns { matchedPairs, totalRequests,
        // dynamicValues, summary, … }. Accept the engine's current shape AND
        // a plain-array shape (for forward-compat / mocked inputs).
        const cmp = new HarComparator().compare(har1, har2);
        const dynamicList = Array.isArray(cmp)
            ? cmp
            : (cmp && Array.isArray(cmp.dynamicValues) ? cmp.dynamicValues : []);
        const dynamicValues = new Set();
        const dynamicsByName = new Map();
        for (const dv of dynamicList) {
            if (dv.value1) dynamicValues.add(String(dv.value1));
            if (dv.value2) dynamicValues.add(String(dv.value2));
            const name = dv.paramName || dv.name || dv.location || 'unknown';
            if (!dynamicsByName.has(name)) dynamicsByName.set(name, []);
            dynamicsByName.get(name).push({
                value1: dv.value1, value2: dv.value2,
                location: dv.location, classification: dv.classification,
                origin: dv.origin && {
                    sampler: dv.origin.sampler || dv.origin.label,
                    requestIndex: dv.origin.requestIndex,
                    location: dv.origin.location,
                },
            });
        }
        notes[okKey] = {
            run2File: path.basename(secondaryPath),
            matchedPairs: (cmp && cmp.matchedPairs) || undefined,
            dynamicValueCount: dynamicValues.size,
            dynamicsByName: Object.fromEntries(dynamicsByName),
        };
        notes.dynamicValueSet = dynamicValues;
    } catch (e) {
        notes[errKey] = e.message;
    }
}

module.exports = { groupInputs, loadUnit };
