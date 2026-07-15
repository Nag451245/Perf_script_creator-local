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
const uploadFiles = require('./upload-files');

// File-extension recognition. Recording sidecars for JMX are JMeter-style JTLs
// (or our own recording.xml, which uses the same testResults schema), so we
// treat both as the same "response side" input.
const HAR_RE = /\.har$/i;
const JMX_RE = /\.jmx$/i;
const JTL_SIDECAR_SUFFIXES = ['.recording.xml', '.jtl', '.xml'];

function baseName(file) {
    return path.basename(file).replace(/\.(har|jmx)$/i, '').replace(/\.recording$/i, '');
}

function pathKey(file) {
    return path.normalize(String(file || '')).replace(/\\/g, '/').toLowerCase();
}

/** Path-keys already claimed, so no sidecar is handed to two scripts. */
function takenKeys(consumed, ...extra) {
    const set = new Set([...(consumed || [])].map(pathKey));
    for (const e of extra) if (e) set.add(pathKey(e));
    return set;
}

function findSidecarFor(jmxFile, allFiles, taken = new Set()) {
    const dir = path.dirname(jmxFile);
    const stem = path.basename(jmxFile).replace(/\.jmx$/i, '');
    for (const suf of JTL_SIDECAR_SUFFIXES) {
        const candidate = path.join(dir, stem + suf);
        if (fs.existsSync(candidate) && !taken.has(pathKey(candidate))) return candidate;
    }
    // Also accept any same-stem .xml/.jtl uploaded into the SAME folder even
    // if naming differs slightly (case-insensitive prefix match).
    const stemLc = stem.toLowerCase();
    return allFiles.find(f =>
        path.dirname(f) === dir &&
        /\.(xml|jtl)$/i.test(f) &&
        !taken.has(pathKey(f)) &&
        path.basename(f).toLowerCase().startsWith(stemLc)
    ) || findSidecarByContent(jmxFile, allFiles, taken) || null;
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

    // 0) Golden scripts: foo__golden.jmx is a human-fixed WORKING script for
    //    flow "foo" — never a standalone input. Consumed here, attached to
    //    the matching unit below so the pipeline can learn from it.
    const goldenByStem = new Map();
    const goldenRe = /^(.+?)[_]{1,2}golden\.jmx$/i;
    for (const f of files) {
        const m = path.basename(f).match(goldenRe);
        if (!m) continue;
        goldenByStem.set(m[1].toLowerCase(), f);
        consumed.add(f);
    }

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

    const contentHarPair = inferContentHarPair(files.filter(f => !consumed.has(f) && HAR_RE.test(f)));
    if (contentHarPair) {
        units.push({
            name: contentHarPair.stem,
            kind: 'dual-har',
            primary: contentHarPair.primary,
            secondary: contentHarPair.secondary,
        });
        consumed.add(contentHarPair.primary);
        consumed.add(contentHarPair.secondary);
    }

    // 1b) Friendly fallback: if the folder contains exactly two remaining HARs
    // that look like the same flow recorded twice (for example
    // Batch_Print_Recording1_May15_Filtered.har +
    // Batch_Print_Recording2_May15_Filtered.har), treat them as a dual
    // recording only when readable content does not contradict the filename
    // match. This preserves deterministic pairing without requiring the user
    // to rename files to __run1/__run2.
    const looseHarPair = inferLooseHarPair(files.filter(f => !consumed.has(f) && HAR_RE.test(f)));
    if (looseHarPair) {
        units.push({
            name: looseHarPair.stem,
            kind: 'dual-har',
            primary: looseHarPair.primary,
            secondary: looseHarPair.secondary,
        });
        consumed.add(looseHarPair.primary);
        consumed.add(looseHarPair.secondary);
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
        // run2 must not claim run1's sidecar: content matching alone cannot tell
        // two captures of the same journey apart, so each claim is exclusive.
        const s1 = findSidecarFor(p.run1, files, takenKeys(consumed));
        const s2 = findSidecarFor(p.run2, files, takenKeys(consumed, s1));
        units.push({
            name: stem, kind: 'dual-jmx',
            primary: p.run1, secondary: p.run2,
            sidecars: { primary: s1 || undefined, secondary: s2 || undefined },
        });
        consumed.add(p.run1); consumed.add(p.run2);
        if (s1) consumed.add(s1);
        if (s2) consumed.add(s2);
    }

    const contentJmxPair = inferContentJmxPair(files.filter(f => !consumed.has(f) && JMX_RE.test(f)));
    if (contentJmxPair) {
        const s1 = findSidecarFor(contentJmxPair.primary, files, takenKeys(consumed));
        const s2 = findSidecarFor(contentJmxPair.secondary, files, takenKeys(consumed, s1));
        units.push({
            name: contentJmxPair.stem,
            kind: 'dual-jmx',
            primary: contentJmxPair.primary,
            secondary: contentJmxPair.secondary,
            sidecars: { primary: s1 || undefined, secondary: s2 || undefined },
        });
        consumed.add(contentJmxPair.primary);
        consumed.add(contentJmxPair.secondary);
        if (s1) consumed.add(s1);
        if (s2) consumed.add(s2);
    }

    // 3) Single JMX (+ optional response-side sidecar). JTL/XML sidecars are
    //    consumed so they don't also surface as standalone inputs.
    for (const f of files) {
        if (consumed.has(f) || !JMX_RE.test(f)) continue;
        const sidecar = findSidecarFor(f, files, takenKeys(consumed));
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

    // Attach goldens to their units by stem (exact stem, else the unit whose
    // stem is a prefix — "createtask__golden.jmx" pairs with unit "createtask").
    if (goldenByStem.size) {
        for (const u of units) {
            const stem = String(u.name || '').toLowerCase();
            const golden = goldenByStem.get(stem) ||
                [...goldenByStem.entries()].find(([g]) => stem.startsWith(g) || g.startsWith(stem))?.[1];
            if (golden) u.golden = golden;
        }
    }

    return units;
}

function inferLooseHarPair(hars) {
    if (!Array.isArray(hars) || hars.length !== 2) return null;
    const [a, b] = hars;
    if (!hasLooseNameSimilarity(a, b)) return null;
    const readable = fs.existsSync(a) && fs.existsSync(b);
    if (readable && !inferContentHarPair(hars)) return null;
    const common = commonTokens(stemTokens(a), stemTokens(b));
    return {
        stem: common.join('_'),
        primary: sortRecordingPair(a, b)[0],
        secondary: sortRecordingPair(a, b)[1],
    };
}

function hasLooseNameSimilarity(a, b) {
    const ta = stemTokens(a);
    const tb = stemTokens(b);
    const common = commonTokens(ta, tb);
    if (common.length < 2) return null;
    const score = common.length / Math.max(ta.length, tb.length, 1);
    return score >= 0.5;
}

function commonLooseNameStem(a, b) {
    if (!hasLooseNameSimilarity(a, b)) return '';
    return commonTokens(stemTokens(a), stemTokens(b)).join('_');
}

function stemTokens(file) {
    return path.basename(file, path.extname(file))
        .toLowerCase()
        .replace(/recording\s*\d+/g, 'recording')
        .replace(/\brun\s*\d+\b/g, 'run')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .filter(t => !/^\d+$/.test(t));
}

function commonTokens(a, b) {
    const bset = new Set(b);
    return [...new Set(a.filter(t => bset.has(t)))];
}

function sortRecordingPair(a, b) {
    const rank = f => {
        const s = path.basename(f).toLowerCase();
        const m = s.match(/(?:recording|run)[_-]?([12])\b/);
        return m ? Number(m[1]) : 99;
    };
    return [a, b].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
}

function inferContentHarPair(hars) {
    if (!Array.isArray(hars) || hars.length !== 2 || hars.some(f => !fs.existsSync(f))) return null;
    const a = readHarFingerprint(hars[0]);
    const b = readHarFingerprint(hars[1]);
    if (!a.ok || !b.ok) return null;
    if (a.sequence.length < 2 || b.sequence.length < 2) return null;
    if (!fingerprintsLookSameFlow(a, b)) return null;
    const sorted = sortRecordingPair(hars[0], hars[1]);
    return {
        stem: commonLooseNameStem(hars[0], hars[1]) || commonContentStem(a, b) || path.basename(sorted[0], path.extname(sorted[0])),
        primary: sorted[0],
        secondary: sorted[1],
    };
}

function sequenceSimilarity(a, b) {
    const len = Math.max(a.length, b.length, 1);
    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) matches++;
    }
    return Math.max(matches / len, longestCommonSubsequenceRatio(a, b));
}

function longestCommonSubsequenceRatio(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
    let prev = Array(b.length + 1).fill(0);
    for (const item of a) {
        const cur = Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            cur[j] = item === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[b.length] / Math.max(a.length, b.length, 1);
}

function commonContentStem(a, b) {
    const bHosts = new Set(b.hosts || []);
    const hosts = [...new Set([...(a.hosts || [])].filter(h => bHosts.has(h)))];
    return hosts[0] ? hosts[0].replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') : '';
}

function readHarFingerprint(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        const entries = raw && raw.log && Array.isArray(raw.log.entries) ? raw.log.entries : [];
        if (!entries.length) return { ok: false, reason: 'HAR has no log.entries[] requests' };
        const sequence = [];
        const hosts = new Set();
        const urls = [];
        const uploadEndpoints = [];
        const downloadEndpoints = [];
        const referencedFilenames = new Set();
        const timestamps = entries.map(e => e && e.startedDateTime).filter(Boolean);
        for (const e of entries) {
            const req = e.request || {};
            const method = String(req.method || 'GET').toUpperCase();
            let u;
            try { u = new URL(req.url || ''); } catch { u = null; }
            if (u) hosts.add(u.hostname);
            if (u) urls.push(u.toString());
            const pathPart = u ? u.pathname : req.url || '';
            sequence.push(`${method} ${pathPart}`);
            const uploads = uploadFilesFromHarEntry(e);
            if (uploads.length) {
                for (const name of uploads) referencedFilenames.add(name);
                uploadEndpoints.push({ method, path: pathPart, url: req.url || '', filenames: uploads });
            }
            const downloads = downloadFilesFromHarEntry(e);
            if (downloads.length) {
                for (const name of downloads) referencedFilenames.add(name);
                downloadEndpoints.push({ method, path: pathPart, url: req.url || '', filenames: downloads });
            }
        }
        return {
            ok: true,
            type: 'har',
            requestCount: entries.length,
            entries: entries.length,
            sequence,
            hosts: [...hosts].sort(),
            firstBusinessUrl: urls[0] || '',
            lastBusinessUrl: urls[urls.length - 1] || '',
            uploadEndpoints,
            downloadEndpoints,
            referencedFilenames: [...referencedFilenames].sort(),
            timestamps: { first: timestamps[0] || '', last: timestamps[timestamps.length - 1] || '' },
        };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function readJmxFingerprint(file) {
    try {
        const xml = fs.readFileSync(file, 'utf8');
        if (!/<jmeterTestPlan\b/i.test(xml)) return { ok: false, reason: 'missing jmeterTestPlan root' };
        const samplers = parseJmxSamplers(xml);
        if (!samplers.length) return { ok: false, reason: 'no HTTP samplers found' };
        return fingerprintFromSamplers(samplers, 'jmx');
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function readSidecarFingerprint(file) {
    try {
        const xml = fs.readFileSync(file, 'utf8');
        if (!/<testResults\b/i.test(xml)) return { ok: false, reason: 'missing testResults root' };
        const samplers = parseJtlSamples(xml);
        return fingerprintFromSamplers(samplers, 'sidecar');
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function fingerprintFromSamplers(samplers, type) {
    const sequence = [];
    const hosts = new Set();
    const urls = [];
    const uploadEndpoints = [];
    const downloadEndpoints = [];
    const referencedFilenames = new Set();
    const timestamps = samplers.map(s => s.timestamp).filter(Boolean);
    for (const s of samplers) {
        const method = String(s.method || 'GET').toUpperCase();
        const pathPart = s.path || '/';
        sequence.push(`${method} ${pathPart}`);
        if (s.host) hosts.add(s.host);
        if (s.url) urls.push(s.url);
        if (s.files && s.files.length) {
            for (const name of s.files) referencedFilenames.add(path.basename(name));
            uploadEndpoints.push({ method, path: pathPart, url: s.url || '', filenames: s.files.map(path.basename) });
        }
        if (s.downloads && s.downloads.length) {
            for (const name of s.downloads) referencedFilenames.add(path.basename(name));
            downloadEndpoints.push({ method, path: pathPart, url: s.url || '', filenames: s.downloads.map(path.basename) });
        }
    }
    return {
        ok: true,
        type,
        requestCount: samplers.length,
        entries: samplers.length,
        sequence,
        hosts: [...hosts].sort(),
        firstBusinessUrl: urls[0] || '',
        lastBusinessUrl: urls[urls.length - 1] || '',
        uploadEndpoints,
        downloadEndpoints,
        referencedFilenames: [...referencedFilenames].sort(),
        timestamps: { first: timestamps[0] || '', last: timestamps[timestamps.length - 1] || '' },
    };
}

function parseJmxSamplers(xml) {
    const samplers = [];
    for (const m of xml.matchAll(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g)) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const label = attrValue(attrs, 'testname');
        const method = propValue(body, 'HTTPSampler.method') || methodFromLabel(label) || 'GET';
        const rawPath = propValue(body, 'HTTPSampler.path') || pathFromLabel(label) || '/';
        const domain = propValue(body, 'HTTPSampler.domain');
        const protocol = propValue(body, 'HTTPSampler.protocol') || 'https';
        const url = domain ? `${protocol}://${domain}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}` : '';
        const files = [...body.matchAll(/<stringProp\s+name="File\.path">([\s\S]*?)<\/stringProp>/g)]
            .map(x => xmlText(x[1])).filter(Boolean);
        samplers.push({
            method,
            path: normalizePathOnly(rawPath),
            host: domain,
            url,
            files,
        });
    }
    return samplers;
}

function parseJtlSamples(xml) {
    const samples = [];
    for (const m of xml.matchAll(/<(?:httpSample|sample)\b([^>]*)>([\s\S]*?)<\/(?:httpSample|sample)>/g)) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const label = attrValue(attrs, 'lb');
        const urlText = xmlText((body.match(/<java\.net\.URL>([\s\S]*?)<\/java\.net\.URL>/) || [])[1] || '');
        let u = null;
        try { u = urlText ? new URL(urlText) : null; } catch { u = null; }
        const method = methodFromLabel(label) || 'GET';
        const pathPart = u ? u.pathname : pathFromLabel(label) || '/';
        samples.push({
            method,
            path: normalizePathOnly(pathPart),
            host: u ? u.hostname : '',
            url: u ? u.toString() : '',
            timestamp: attrValue(attrs, 'ts'),
        });
    }
    return samples;
}

function uploadFilesFromHarEntry(entry) {
    return uploadFiles.detectUploadFiles([entry])
        .map(upload => path.basename(String(upload.fileName || '')))
        .filter(Boolean);
}

function downloadFilesFromHarEntry(entry) {
    const headers = (entry.response && entry.response.headers) || [];
    const out = [];
    for (const h of headers) {
        if (!/^content-disposition$/i.test(h.name || '')) continue;
        const m = String(h.value || '').match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        if (m) out.push(path.basename(decodeURIComponent(m[1].replace(/^"|"$/g, ''))));
    }
    return out;
}

function attrValue(attrs, name) {
    const re = new RegExp(`${name}="([^"]*)"`);
    const m = String(attrs || '').match(re);
    return m ? xmlText(m[1]) : '';
}

function propValue(body, name) {
    const re = new RegExp(`<stringProp\\s+name="${escapeRegExp(name)}">([\\s\\S]*?)<\\/stringProp>`);
    const m = String(body || '').match(re);
    return m ? xmlText(m[1]) : '';
}

function xmlText(s) {
    return String(s || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function methodFromLabel(label) {
    const m = String(label || '').match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
    return m ? m[1].toUpperCase() : '';
}

function pathFromLabel(label) {
    const m = String(label || '').match(/\s(\/[^\s?]*)/);
    return m ? m[1] : '';
}

function normalizePathOnly(value) {
    const s = String(value || '/');
    try { return new URL(s).pathname || '/'; } catch { /* not absolute */ }
    const noQuery = s.split('?')[0] || '/';
    return noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferContentJmxPair(jmxs) {
    if (!Array.isArray(jmxs) || jmxs.length !== 2 || jmxs.some(f => !fs.existsSync(f))) return null;
    const a = readJmxFingerprint(jmxs[0]);
    const b = readJmxFingerprint(jmxs[1]);
    if (!a.ok || !b.ok || !fingerprintsLookSameFlow(a, b)) return null;
    const sorted = sortRecordingPair(jmxs[0], jmxs[1]);
    return {
        stem: commonLooseNameStem(jmxs[0], jmxs[1]) || commonContentStem(a, b) || path.basename(sorted[0], path.extname(sorted[0])),
        primary: sorted[0],
        secondary: sorted[1],
    };
}

/**
 * The recording ordinal a file name carries: Rec1/R1/run1/_1 -> 1. The whole
 * point of a dual recording is two captures of the SAME flow, so the ordinal —
 * not the stem — is what says which sidecar belongs to which script
 * (Smart_Text_Rec1_14July.jmx <-> Smart_Text_R1_14July.xml).
 */
function recordingOrdinal(file) {
    const stem = path.basename(String(file || '')).replace(/\.(jmx|xml|jtl)$/i, '');
    const m = stem.match(/(?:^|[_\-\s])(?:rec|run|r)\s*[_\-]?(\d{1,2})(?:[_\-\s]|$)/i);
    return m ? Number(m[1]) : null;
}

/**
 * Content-based sidecar match. RANKS candidates instead of demanding a unique
 * one: two recordings of the same journey both fingerprint-match every script
 * of that journey, so "exactly one match" is precisely the case that never
 * happens for a dual recording — and returning null there left the JMX with no
 * responses at all, which silently produces a script with every dynamic token
 * hardcoded. Rank by matching recording ordinal first, then by sequence
 * similarity (a script's own capture matches its own request sequence best).
 */
function findSidecarByContent(jmxFile, allFiles, taken = new Set()) {
    if (!fs.existsSync(jmxFile)) return null;
    const jmx = readJmxFingerprint(jmxFile);
    if (!jmx.ok) return null;
    const wantOrdinal = recordingOrdinal(jmxFile);
    const scored = [];
    for (const file of allFiles) {
        if (!/\.(xml|jtl)$/i.test(file) || !fs.existsSync(file)) continue;
        if (taken.has(pathKey(file))) continue;
        const fp = readSidecarFingerprint(file);
        if (!fp.ok || !fingerprintsLookSameFlow(jmx, fp)) continue;
        const ordinal = recordingOrdinal(file);
        scored.push({
            file,
            ordinalMatch: wantOrdinal != null && ordinal === wantOrdinal ? 1 : 0,
            similarity: sequenceSimilarity(jmx.sequence, fp.sequence),
        });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => (b.ordinalMatch - a.ordinalMatch) || (b.similarity - a.similarity));
    return scored[0].file;
}

function fingerprintsLookSameFlow(a, b) {
    if (!a || !b || !a.sequence || !b.sequence) return false;
    if (Math.min(a.sequence.length, b.sequence.length) < 1) return false;
    if (!hostsOverlap(a.hosts, b.hosts)) return false;
    if (sequenceSimilarity(a.sequence, b.sequence) >= 0.7) return true;
    // METHOD-BLIND retry. A proxy recording labels samples by raw path
    // ("/log?format=json"), so the JTL carries no method and every sample reads
    // as GET — comparing "POST /log" to "GET /log" then fails a script against
    // its OWN capture (measured live: 0.53 with methods, 0.99 on paths alone).
    // Paths in order are identity enough; demand a higher bar to compensate.
    if (!methodsAreKnown(a) || !methodsAreKnown(b)) {
        return sequenceSimilarity(pathsOf(a.sequence), pathsOf(b.sequence)) >= 0.85;
    }
    return false;
}

/** A fingerprint whose samples are ALL GET almost certainly never knew any. */
function methodsAreKnown(fp) {
    const seq = (fp && fp.sequence) || [];
    if (seq.length < 3) return true;
    return !seq.every(s => String(s).startsWith('GET '));
}

function pathsOf(sequence) {
    return (sequence || []).map(s => String(s).replace(/^[A-Z]+\s+/, ''));
}

function hostsOverlap(a = [], b = []) {
    if (!a.length || !b.length) return true;
    const bset = new Set(b);
    return a.some(host => bset.has(host));
}

function analyzeInputFiles(files) {
    const inventory = files.map(inspectInputFile);
    const validRecordingFiles = inventory
        .filter(item => !item.issue && ['har', 'jmx', 'sidecar'].includes(item.kind))
        .map(item => item.file);
    const units = groupInputs(validRecordingFiles);
    const consumed = new Set();
    for (const u of units) {
        consumed.add(pathKey(u.primary));
        if (u.secondary) consumed.add(pathKey(u.secondary));
        if (u.sidecars?.primary) consumed.add(pathKey(u.sidecars.primary));
        if (u.sidecars?.secondary) consumed.add(pathKey(u.sidecars.secondary));
    }
    const issues = [];
    issues.push(...detectAmbiguousRecordingPairs(inventory, units));
    issues.push(...detectMismatchedTwoRecordingRuns(inventory, units));
    for (const item of inventory) {
        const file = item.file;
        if (item.issue) issues.push(item.issue);
        if (item.kind === 'sidecar' && !consumed.has(pathKey(file))) {
            issues.push({
                code: 'orphan_sidecar',
                file,
                severity: 'warning',
                message: `${path.basename(file)} looks like a JMeter recording/JTL response log but is not paired with any JMX.`,
            });
        }
    }
    for (const u of units) {
        if (u.kind === 'jmx' && !u.secondary) {
            issues.push({
                code: 'jmx_missing_sidecar',
                file: u.primary,
                // NOT a warning: without responses, correlation is not merely
                // degraded, it is IMPOSSIBLE — every dynamic token ships as the
                // recorded literal and the script cannot work on any replay.
                // Shipping that quietly is worse than refusing to ship.
                severity: 'error',
                message: `${path.basename(u.primary)} has no response sidecar (recording.xml/JTL): a JMX carries only REQUESTS, so there is nothing to correlate FROM and every dynamic value (tokens, session ids) would ship hardcoded. Upload the recording XML/JTL captured with this script.`,
            });
        }
    }
    return { units: expandWithIndividuals(units), inventory, issues };
}

// Expose the individual members of each dual (variance) unit as their own
// selectable single units, so an operator can run ONE recording on its own —
// the merged pair stays for the variance run. Flagged `individual` so a
// "run everything" pass skips them and executes only the canonical grouping
// (otherwise a paired flow would run three times: the pair + each half).
function expandWithIndividuals(units) {
    const out = [];
    for (const u of units) {
        out.push(u);
        if (u.kind === 'dual-jmx') {
            out.push({ name: baseName(u.primary), kind: 'jmx', primary: u.primary, secondary: (u.sidecars && u.sidecars.primary) || undefined, individual: true, derivedFrom: u.name });
            out.push({ name: baseName(u.secondary), kind: 'jmx', primary: u.secondary, secondary: (u.sidecars && u.sidecars.secondary) || undefined, individual: true, derivedFrom: u.name });
        } else if (u.kind === 'dual-har') {
            out.push({ name: baseName(u.primary), kind: 'har', primary: u.primary, individual: true, derivedFrom: u.name });
            out.push({ name: baseName(u.secondary), kind: 'har', primary: u.secondary, individual: true, derivedFrom: u.name });
        }
    }
    return out;
}

function inspectInputFile(file) {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);
    if (ext === '.har') {
        const fp = readHarFingerprint(file);
        return fp.ok
            ? { file, kind: 'har', entries: fp.entries, fingerprint: publicFingerprint(fp) }
            : { file, kind: 'har', issue: { code: 'invalid_har', file, severity: 'error', message: `${base} is not a usable HAR: ${fp.reason}` } };
    }
    if (ext === '.jmx') {
        const fp = readJmxFingerprint(file);
        return fp.ok
            ? { file, kind: 'jmx', samplers: fp.entries, fingerprint: publicFingerprint(fp) }
            : { file, kind: 'jmx', issue: { code: 'invalid_jmx', file, severity: 'error', message: `${base} is not a usable JMX test plan with HTTP samplers: ${fp.reason}` } };
    }
    if (/\.(xml|jtl)$/i.test(file)) {
        const fp = readSidecarFingerprint(file);
        if (fp.ok) return { file, kind: 'sidecar', fingerprint: publicFingerprint(fp) };
        if (fp.reason === 'missing testResults root') return { file, kind: 'xml', issue: { code: 'unsupported_xml', file, severity: 'warning', message: `${base} is XML, but not a JMeter recording/JTL testResults file.` } };
        return { file, kind: 'xml', issue: { code: 'invalid_xml', file, severity: 'error', message: `${base} could not be read as XML/JTL: ${fp.reason}` } };
    }
    return { file, kind: 'support', supportType: supportTypeFor(file) };
}

function publicFingerprint(fp) {
    return {
        type: fp.type,
        requestCount: fp.requestCount,
        sequence: fp.sequence,
        hosts: fp.hosts,
        firstBusinessUrl: fp.firstBusinessUrl,
        lastBusinessUrl: fp.lastBusinessUrl,
        uploadEndpoints: fp.uploadEndpoints,
        downloadEndpoints: fp.downloadEndpoints,
        referencedFilenames: fp.referencedFilenames,
        timestamps: fp.timestamps,
    };
}

function supportTypeFor(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf') return 'pdf';
    if (['.doc', '.docx'].includes(ext)) return 'document';
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'spreadsheet';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
    return ext ? ext.slice(1) : 'file';
}

function detectAmbiguousRecordingPairs(inventory, units) {
    const issues = [];
    const paired = new Set(units.filter(u => /^dual-/.test(u.kind)).flatMap(u => [u.primary, u.secondary]).map(pathKey));
    for (const kind of ['har', 'jmx']) {
        const items = inventory.filter(i => i.kind === kind && i.fingerprint && !paired.has(pathKey(i.file)));
        const groups = new Map();
        for (const item of items) {
            const key = fingerprintGroupKey(item.fingerprint);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        for (const group of groups.values()) {
            if (group.length <= 2) continue;
            issues.push({
                code: 'ambiguous_recording_pair',
                severity: 'error',
                files: group.map(i => i.file),
                message: `Found ${group.length} similar ${kind.toUpperCase()}s for this flow. I need exactly two runs or a clear selection: ${group.map(i => path.basename(i.file)).join(', ')}.`,
            });
        }
    }
    return issues;
}

function detectMismatchedTwoRecordingRuns(inventory, units) {
    const issues = [];
    const paired = new Set(units.filter(u => /^dual-/.test(u.kind)).flatMap(u => [u.primary, u.secondary]).map(pathKey));
    for (const kind of ['har', 'jmx']) {
        const items = inventory.filter(i => i.kind === kind && i.fingerprint && !paired.has(pathKey(i.file)));
        if (items.length !== 2) continue;
        if (fingerprintsLookSameFlow(items[0].fingerprint, items[1].fingerprint)) continue;
        if (kind === 'har' && hasLooseNameSimilarity(items[0].file, items[1].file)) {
            issues.push({
                code: 'unpaired_similar_recordings',
                severity: 'warning',
                files: items.map(i => i.file),
                message: `These HARs have similar file names but different request flows, so I will not pair them as dual recordings: ${items.map(i => path.basename(i.file)).join(', ')}.`,
            });
            continue;
        }
        issues.push({
            code: 'recording_flow_mismatch',
            severity: 'warning',
            files: items.map(i => i.file),
            message: `These two ${kind.toUpperCase()}s do not look like the same business flow: ${items.map(i => path.basename(i.file)).join(', ')}.`,
        });
    }
    return issues;
}

function fingerprintGroupKey(fp) {
    return `${(fp.hosts || []).join(',')}|${(fp.sequence || []).join('|')}`;
}

function writeIntakeArtifacts(outDir, analysis) {
    fs.mkdirSync(outDir, { recursive: true });
    const artifacts = [];
    for (const unit of analysis.units || []) {
        const flow = safeFlowName(unit.name || baseName(unit.primary || 'input'));
        const unitFiles = new Set([unit.primary, unit.secondary, unit.sidecars?.primary, unit.sidecars?.secondary].filter(Boolean).map(pathKey));
        const inventory = (analysis.inventory || []).filter(i => unitFiles.has(pathKey(i.file)));
        const issues = (analysis.issues || []).filter(i => !i.file && !i.files || i.file && unitFiles.has(pathKey(i.file)) || Array.isArray(i.files) && i.files.some(f => unitFiles.has(pathKey(f))));
        const jsonPath = path.join(outDir, `${flow}_input_inventory.json`);
        const mdPath = path.join(outDir, `${flow}_intake_report.md`);
        fs.writeFileSync(jsonPath, JSON.stringify({ unit, inventory, issues }, null, 2));
        fs.writeFileSync(mdPath, renderIntakeReport(flow, unit, inventory, issues));
        artifacts.push({ flow, inventory: jsonPath, report: mdPath });
    }
    return artifacts;
}

function renderIntakeReport(flow, unit, inventory, issues) {
    const lines = [`# Intake Report: ${flow}`, '', `Mode: ${unit.kind}`, ''];
    for (const item of inventory) {
        lines.push(`## ${path.basename(item.file)}`, '');
        lines.push(`Kind: ${item.kind}`);
        if (item.fingerprint) {
            lines.push(`Requests: ${item.fingerprint.requestCount}`);
            lines.push(`Hosts: ${(item.fingerprint.hosts || []).join(', ') || '(none)'}`);
            lines.push('Sequence:');
            for (const step of item.fingerprint.sequence || []) lines.push(`- ${step}`);
            if ((item.fingerprint.referencedFilenames || []).length) {
                lines.push(`Referenced files: ${item.fingerprint.referencedFilenames.join(', ')}`);
            }
        }
        lines.push('');
    }
    if (issues.length) {
        lines.push('## Issues', '');
        for (const issue of issues) lines.push(`- [${issue.severity || 'info'}] ${issue.message}`);
    } else {
        lines.push('## Issues', '', '- None');
    }
    lines.push('');
    return lines.join('\n');
}

function safeFlowName(name) {
    return String(name || 'input').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
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
            secondaryEntries: har2.log?.entries || [],
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
            secondaryEntries: b.har.log.entries,
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

/**
 * Manually pair two single-recording units into ONE dual-recording variance
 * unit — the UI feature for recordings that aren't named __run1/__run2 (e.g.
 * LOGI_..._0004User + LOGI_..._0006User). Two JMX units → dual-jmx (sidecars
 * carried); two HAR units → dual-har. Order is preserved: A is canonical.
 */
function mergeUnitsAsDual(unitA, unitB) {
    if (!unitA || !unitB) throw new Error('two units are required to pair');
    const bothJmx = /\.jmx$/i.test(unitA.primary) && /\.jmx$/i.test(unitB.primary);
    const bothHar = /\.har$/i.test(unitA.primary) && /\.har$/i.test(unitB.primary);
    if (!bothJmx && !bothHar) {
        throw new Error('pairing requires two recordings of the same type (two JMX or two HAR)');
    }
    const name = `${unitA.name}__paired`;
    if (bothHar) {
        return { name, kind: 'dual-har', primary: unitA.primary, secondary: unitB.primary, golden: unitA.golden || unitB.golden };
    }
    return {
        name,
        kind: 'dual-jmx',
        primary: unitA.primary,
        secondary: unitB.primary,
        sidecars: { primary: unitA.secondary || undefined, secondary: unitB.secondary || undefined },
        golden: unitA.golden || unitB.golden,
    };
}

module.exports = { groupInputs, loadUnit, analyzeInputFiles, writeIntakeArtifacts, mergeUnitsAsDual };
