'use strict';

const fs = require('fs');
const path = require('path');

const FOLDERS = ['scripts', 'reports', 'results', 'evidence', 'data'];

function organizeOutput({
    outDir,
    name,
    verdict = '',
    finalJmxPath = '',
    reportPath = '',
    currentJtlPath = '',
    diagnostics = 'summary',
} = {}) {
    if (!outDir || !name) throw new Error('outDir and name are required');
    fs.mkdirSync(outDir, { recursive: true });
    for (const folder of FOLDERS) fs.mkdirSync(path.join(outDir, folder), { recursive: true });

    const copied = [];
    const copiedPaths = new Set();
    cleanStaleScriptPointers(outDir, finalJmxPath);
    dropRedundantFinals(outDir, finalJmxPath);

    /**
     * Place a file in its folder. Diagnostics MOVE — the old behaviour copied
     * everything and left the original, so a folder held two of each file and
     * ~23MB of the same script six times over. Only the files a human opens
     * from the folder root (and the final-JMX archive copy, which has already
     * rescued a script an editor clobbered) are duplicated on purpose.
     * The long flow-name prefix is stripped inside subfolders: the folder is
     * already named for the flow, so repeating it 40 times is pure noise.
     */
    const place = (source, folder, { keepAtRoot = false, archive = true } = {}) => {
        if (!source || !fs.existsSync(source)) return '';
        // A file that stays at the root AND is copied into a folder is simply
        // the same file twice. Only the deliverable earns a second copy (that
        // archive is what restored a script an editor had clobbered).
        if (keepAtRoot && !archive) {
            // An earlier build DID copy this one; that copy is a duplicate of a
            // file sitting at the root, so clear it rather than leave the pair.
            for (const candidate of [path.basename(source), shortName(path.basename(source), name)]) {
                const stale = path.join(outDir, folder, candidate);
                if (fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch { /* locked */ } }
            }
            return path.basename(source);
        }
        const original = path.basename(source);
        const basename = shortName(original, name);
        const relative = `${folder}/${basename}`.replace(/\\/g, '/');
        if (copiedPaths.has(relative)) return relative;
        const target = path.join(outDir, folder, basename);
        if (path.resolve(source) !== path.resolve(target)) {
            fs.copyFileSync(source, target);
            // An earlier run filed this same artifact under its long prefixed
            // name; leaving it behind means the folder accumulates two of
            // everything, run after run.
            if (basename !== original) {
                const stale = path.join(outDir, folder, original);
                if (fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch { /* locked */ } }
            }
            if (!keepAtRoot && path.dirname(path.resolve(source)) === path.resolve(outDir)) {
                try { fs.unlinkSync(source); } catch { /* locked — the copy still exists */ }
            }
        }
        copied.push({ source: original, folder, path: relative, moved: !keepAtRoot });
        copiedPaths.add(relative);
        return relative;
    };
    const copy = place;

    const rootFiles = fs.readdirSync(outDir)
        .filter(file => fs.statSync(path.join(outDir, file)).isFile());
    const byName = file => path.join(outDir, file);

    // The deliverable stays where the user was told to find it, and is ALSO
    // archived — that archive copy is what restored a script after an editor
    // saved a stale buffer over it.
    const finalJmxRelative = place(finalJmxPath, 'scripts', { keepAtRoot: true });
    for (const file of rootFiles.filter(file => /\.jmx$/i.test(file) && shouldCopyScriptFile(outDir, file, finalJmxPath))) {
        copy(byName(file), 'scripts');
    }
    // The report is what a human opens — it stays at the root AND is archived.
    const reportRelative = place(reportPath || path.join(outDir, `${name}_report.html`), 'reports', { keepAtRoot: true, archive: false });
    for (const file of rootFiles.filter(file => isReportArtifact(name, file))) {
        place(byName(file), 'reports', { keepAtRoot: mustStayAtRoot(name, file), archive: !mustStayAtRoot(name, file) });
    }
    const currentJtlRelative = place(currentJtlPath || path.join(outDir, 'final.jtl'), 'results', { keepAtRoot: true, archive: false });
    for (const file of rootFiles.filter(file => isResultArtifact(file))) {
        place(byName(file), 'results', { keepAtRoot: mustStayAtRoot(name, file), archive: !mustStayAtRoot(name, file) });
    }
    for (const file of rootFiles.filter(file => isEvidenceArtifact(name, file))) place(byName(file), 'evidence');
    let dataCsvRelative = '';
    for (const file of rootFiles.filter(file => isDataArtifact(name, file))) {
        // The CSV must sit beside the script that reads it: the CSVDataSet
        // holds a RELATIVE filename, so a data file tidied into data/ is a
        // script that starts up with no data at all.
        const relative = place(byName(file), 'data', { keepAtRoot: mustStayAtRoot(name, file), archive: !mustStayAtRoot(name, file) });
        if (!dataCsvRelative && file === `${name}_data.csv`) dataCsvRelative = relative;
    }
    // Everything still loose at the root that nobody opens by hand is
    // diagnostic detail — file it away rather than leaving 50 siblings around
    // the one file the user actually wants.
    for (const file of fs.readdirSync(outDir)) {
        const full = path.join(outDir, file);
        if (!fs.statSync(full).isFile() || mustStayAtRoot(name, file)) continue;
        place(full, 'evidence');
    }

    const manifest = {
        name,
        verdict,
        generatedAt: new Date().toISOString(),
        folders: {
            scripts: 'Generated and final JMX files.',
            reports: 'HTML, markdown, gate, blocker, and summary artifacts.',
            results: 'JTL, dashboard, and runtime result artifacts.',
            evidence: 'Correlation, label-map, forensics, lineage, reasoning, and learning evidence.',
            data: 'CSV data pools and upload staging references.',
        },
        whatToOpen: {
            // Point at the copy AT THE ROOT, not the archive under scripts/.
            // "Open first: scripts/00_RUN_THIS_SCRIPT.jmx" sent people to the
            // backup while the deliverable sat at the top of the folder.
            finalJmx: relativeIfExists(outDir, path.join(outDir, path.basename(finalJmxPath || ''))) ||
                finalJmxRelative || relativeIfExists(outDir, finalJmxPath),
            report: reportRelative || relativeIfExists(outDir, reportPath || path.join(outDir, `${name}_report.html`)),
            currentJtl: currentJtlRelative || relativeIfExists(outDir, currentJtlPath || path.join(outDir, 'final.jtl')),
            dataCsv: dataCsvRelative || relativeIfExists(outDir, path.join(outDir, 'data', `${name}_data.csv`)) ||
                relativeIfExists(outDir, path.join(outDir, `${name}_data.csv`)),
            // The flow prefix is stripped when a file moves into a subfolder, so
            // look for the short name first — otherwise the index reported
            // "Label map: not available" with the file sitting right there.
            labelMap: relativeIfExists(outDir, path.join(outDir, 'evidence', 'label_map.json')) ||
                relativeIfExists(outDir, path.join(outDir, 'evidence', `${name}_label_map.json`)) ||
                relativeIfExists(outDir, path.join(outDir, `${name}_label_map.json`)),
        },
        compatibility: {
            rootFilesPreserved: false,
            note: 'The root holds only the deliverable, what a human opens, the data the script needs beside it, and the small files the next run reads. Everything else is filed under the folders above — moved, not copied, so there is exactly one of each.',
        },
        copied,
    };

    dropPrefixedTwins(outDir, FOLDERS, name);
    manifest.pruned = pruneDiagnostics(outDir, diagnostics);
    fs.writeFileSync(path.join(outDir, 'output_manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, '00_OUTPUT_INDEX.txt'), renderOutputIndex(manifest));
    return manifest;
}

/**
 * Machine-only artifacts a person never opens. Each is either the JSON twin of
 * something already written in readable form, or an internal dump the agent
 * produced for itself mid-run. They are written during the run (things read
 * them while it is happening) and cleared afterwards unless the operator asks
 * to keep everything with run.diagnostics = "full".
 */
const MACHINE_ONLY = new Set([
    // JSON twins of a human-readable file that survives
    'reports/report.json',              // report.html says the same thing
    'evidence/reasoning.json',          // reports/reasoning.md
    'evidence/senior_pe_debrief.json',  // reports/senior_pe_debrief.md
    'evidence/pe_analysis.json',        // reports/pe_analysis.md
    'evidence/blockers.json',           // reports/blockers.md
    'evidence/failure_forensics.json',  // reports/failure_forensics.md
    // rendered into report.html by report-docs.js — a loose .md opens in
    // nothing on Windows, so the copy is noise once the report carries it
    'reports/blockers.md',
    'reports/human_questions.md',
    'reports/failure_forensics.md',
    'reports/pe_analysis.md',
    'reports/senior_pe_debrief.md',
    'reports/reasoning.md',
    // internal dumps the agent writes for itself
    'evidence/blueprint_context.json',
    'evidence/lineage.json',
    'evidence/ghosts.json',
    'evidence/ai_strategy.json',
    'evidence/evidence_citations.json',
    'evidence/understanding.json',
    'evidence/java_safe_generate.json',
    'evidence/repair_rounds.json',
]);

/**
 * Clear the machine-only artifacts. "summary" (the default) leaves every file
 * a person reads, everything the next run needs, and the newer diagnostics
 * worth a look when something goes wrong — the knowledge review, the live
 * probe, the diagnosis, the green gate. "full" keeps the lot.
 */
function pruneDiagnostics(outDir, level = 'summary') {
    if (String(level).toLowerCase() === 'full') return [];
    const removed = [];
    for (const rel of MACHINE_ONLY) {
        const full = path.join(outDir, ...rel.split('/'));
        if (!fs.existsSync(full)) continue;
        try { fs.unlinkSync(full); removed.push(rel); } catch { /* locked */ }
    }
    return removed;
}

/**
 * The short list that stays at the folder root: the deliverable, the things a
 * human opens, the data the script needs beside it, and the small files the
 * NEXT run reads (the fingerprint that catches an editor clobbering the final).
 */
function mustStayAtRoot(name, file) {
    if (file === '00_OPEN_THIS_FIRST.txt' || file === '00_OUTPUT_INDEX.txt') return true;
    if (file === 'output_manifest.json' || file === 'log.txt') return true;
    if (/^00_(RUN_THIS_SCRIPT|USE_THIS_.*)\.jmx$/i.test(file)) return true;
    // An aborted run parks its unverified regenerate beside the verified
    // deliverable, and the guide tells the operator to look for it there.
    if (file === 'UNVERIFIED_REGENERATE.jmx') return true;
    if (file === `${name}_report.html`) return true;
    if (file === `${name}_data.csv`) return true;          // JMeter reads it relative to the script
    if (file === 'final.jtl') return true;                 // the next run looks for it here
    if (/_final_fingerprint\.json$/i.test(file)) return true;
    return false;
}

/** Inside a folder already named for the flow, repeating the flow name on
 *  every file is noise. `<flow>_senior_pe_debrief.json` -> `senior_pe_debrief.json`. */
function shortName(file, name) {
    if (!name) return file;
    let out = file;
    for (const prefix of [`${name}_`, `${name}.`]) {
        if (out.startsWith(prefix)) { out = out.slice(prefix.length); break; }
    }
    if (!out) return file;
    // Stripping "<flow>." off "<flow>.jmx" leaves the bare extension "jmx" —
    // a file with no name and no type. Give those a real one.
    if (!out.includes('.')) return `base.${out}`;
    return out;
}

/**
 * Remove a stale long-prefixed twin of a file already filed under its short
 * name. Without this, folders organized by an older build keep both forever.
 */
function dropPrefixedTwins(outDir, folders, name) {
    if (!name) return 0;
    let removed = 0;
    for (const folder of folders) {
        const dir = path.join(outDir, folder);
        if (!fs.existsSync(dir)) continue;
        const present = new Set(fs.readdirSync(dir));
        for (const file of present) {
            const short = shortName(file, name);
            if (short === file) continue;
            try {
                if (present.has(short)) {
                    fs.unlinkSync(path.join(dir, file));           // a short twin already exists
                } else {
                    fs.renameSync(path.join(dir, file), path.join(dir, short)); // legacy long name
                }
                removed++;
            } catch { /* locked — leave it rather than lose it */ }
        }
    }
    return removed;
}

/**
 * One deliverable, not four. A run leaves behind the legacy `final_validated`
 * name and a stale `00_USE_THIS_FINAL_GENERATED_NOT_VALIDATED` beside the real
 * one — three identical multi-MB scripts, and a genuine question for the user
 * about which to open.
 */
function dropRedundantFinals(outDir, finalJmxPath) {
    const keep = finalJmxPath ? path.basename(finalJmxPath) : '';
    for (const file of fs.readdirSync(outDir)) {
        if (!/\.jmx$/i.test(file) || file === keep) continue;
        const isPointer = /^00_(RUN_THIS_SCRIPT|USE_THIS_.*)\.jmx$/i.test(file);
        const isLegacyFinal = /^final_validated\.jmx$/i.test(file);
        if (!isPointer && !isLegacyFinal) continue;
        try { fs.unlinkSync(path.join(outDir, file)); } catch { /* in use — harmless */ }
    }
}

function shouldCopyScriptFile(outDir, file, finalJmxPath) {
    if (!/^00_(RUN_THIS_SCRIPT|USE_THIS_)/i.test(file)) return true;
    return !!finalJmxPath && path.resolve(path.join(outDir, file)) === path.resolve(finalJmxPath);
}

function cleanStaleScriptPointers(outDir, finalJmxPath) {
    const scriptsDir = path.join(outDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) return;
    const keep = finalJmxPath ? path.basename(finalJmxPath) : '';
    for (const file of fs.readdirSync(scriptsDir)) {
        if (!/^00_(RUN_THIS_SCRIPT|USE_THIS_.*)\.jmx$/i.test(file)) continue;
        if (file === keep) continue;
        fs.unlinkSync(path.join(scriptsDir, file));
    }
}

function isReportArtifact(name, file) {
    return file === `${name}_report.html` ||
        file === `${name}_report.json` ||
        file === `${name}_final_green_gate.json` ||
        file === `${name}_failure_forensics.md` ||
        file === `${name}_senior_pe_debrief.md` ||
        file === `${name}_pe_analysis.md` ||
        file === `${name}_blockers.md` ||
        file === `${name}_human_questions.md` ||
        file === `${name}_reasoning.md` ||
        file === '00_OPEN_THIS_FIRST.txt';
}

function isResultArtifact(file) {
    return /\.jtl$/i.test(file) || file === 'final.jtl' || /_run_status\.json$/i.test(file);
}

function isEvidenceArtifact(name, file) {
    if (file === `${name}_label_map.json`) return true;
    if (/_secrets\.json$/i.test(file)) return false;
    return /_(parameters|ghosts|polling|file_uploads|baseline_diff|failure_forensics|request_adjudication|senior_pe_debrief|domain_profile|pe_analysis|ai_strategy|evidence_citations|blockers|blueprint_context|lineage|repair_rounds|correlation_|fast_repair|memory_|learned_lessons|reasoning|java_safe_generate|golden_deltas|scenario)\.(json|md)$/i.test(file);
}

function isDataArtifact(name, file) {
    return file === `${name}_data.csv` || /_file_uploads\.json$/i.test(file);
}

function relativeIfExists(outDir, file) {
    if (!file || !fs.existsSync(file)) return '';
    return path.relative(outDir, file).replace(/\\/g, '/');
}

function renderOutputIndex(manifest) {
    const lines = [
        `# ${manifest.name} Output Index`,
        '',
        `Verdict: ${manifest.verdict || 'unknown'}`,
        '',
        'Open first:',
        `- Final JMX: ${manifest.whatToOpen.finalJmx || 'not available'}`,
        `- HTML report: ${manifest.whatToOpen.report || 'not available'}`,
        `- Current JTL: ${manifest.whatToOpen.currentJtl || 'not available'}`,
        `- Data CSV: ${manifest.whatToOpen.dataCsv || 'not available'}`,
        `- Label map: ${manifest.whatToOpen.labelMap || 'not available'}`,
        '',
        'Folders:',
    ];
    for (const [folder, desc] of Object.entries(manifest.folders)) {
        lines.push(`- ${folder}/ - ${desc}`);
    }
    lines.push('', manifest.compatibility.note, '');
    return lines.join('\n');
}

module.exports = { organizeOutput, _internal: { isReportArtifact, isResultArtifact, isEvidenceArtifact, isDataArtifact } };
