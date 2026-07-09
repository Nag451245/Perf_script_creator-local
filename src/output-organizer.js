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
} = {}) {
    if (!outDir || !name) throw new Error('outDir and name are required');
    fs.mkdirSync(outDir, { recursive: true });
    for (const folder of FOLDERS) fs.mkdirSync(path.join(outDir, folder), { recursive: true });

    const copied = [];
    const copiedPaths = new Set();
    cleanStaleScriptPointers(outDir, finalJmxPath);
    const copy = (source, folder, explicitName = '') => {
        if (!source || !fs.existsSync(source)) return '';
        const basename = explicitName || path.basename(source);
        const relative = `${folder}/${basename}`.replace(/\\/g, '/');
        if (copiedPaths.has(relative)) return relative;
        const target = path.join(outDir, folder, basename);
        if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
        copied.push({ source: path.basename(source), folder, path: relative });
        copiedPaths.add(relative);
        return relative;
    };

    const rootFiles = fs.readdirSync(outDir)
        .filter(file => fs.statSync(path.join(outDir, file)).isFile());
    const byName = file => path.join(outDir, file);

    const finalJmxRelative = copy(finalJmxPath, 'scripts');
    for (const file of rootFiles.filter(file => /\.jmx$/i.test(file) && shouldCopyScriptFile(outDir, file, finalJmxPath))) {
        copy(byName(file), 'scripts');
    }
    const reportRelative = copy(reportPath || path.join(outDir, `${name}_report.html`), 'reports');
    for (const file of rootFiles.filter(file => isReportArtifact(name, file))) copy(byName(file), 'reports');
    const currentJtlRelative = copy(currentJtlPath || path.join(outDir, 'final.jtl'), 'results');
    for (const file of rootFiles.filter(file => isResultArtifact(file))) copy(byName(file), 'results');
    for (const file of rootFiles.filter(file => isEvidenceArtifact(name, file))) copy(byName(file), 'evidence');
    for (const file of rootFiles.filter(file => isDataArtifact(name, file))) copy(byName(file), 'data');

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
            finalJmx: finalJmxRelative || relativeIfExists(outDir, finalJmxPath),
            report: reportRelative || relativeIfExists(outDir, reportPath || path.join(outDir, `${name}_report.html`)),
            currentJtl: currentJtlRelative || relativeIfExists(outDir, currentJtlPath || path.join(outDir, 'final.jtl')),
            labelMap: relativeIfExists(outDir, path.join(outDir, 'evidence', `${name}_label_map.json`)) ||
                relativeIfExists(outDir, path.join(outDir, `${name}_label_map.json`)),
        },
        compatibility: {
            rootFilesPreserved: true,
            note: 'Root-level files remain for existing workflows; subfolders are compatibility copies for review.',
        },
        copied,
    };

    fs.writeFileSync(path.join(outDir, 'output_manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, '00_OUTPUT_INDEX.md'), renderOutputIndex(manifest));
    return manifest;
}

function shouldCopyScriptFile(outDir, file, finalJmxPath) {
    if (!/^00_USE_THIS_/i.test(file)) return true;
    return !!finalJmxPath && path.resolve(path.join(outDir, file)) === path.resolve(finalJmxPath);
}

function cleanStaleScriptPointers(outDir, finalJmxPath) {
    const scriptsDir = path.join(outDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) return;
    const keep = finalJmxPath ? path.basename(finalJmxPath) : '';
    for (const file of fs.readdirSync(scriptsDir)) {
        if (!/^00_USE_THIS_.*\.jmx$/i.test(file)) continue;
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
