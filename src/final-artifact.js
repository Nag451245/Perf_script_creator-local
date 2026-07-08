'use strict';

const fs = require('fs');
const path = require('path');

function writeFinalJmxPointer({
    outDir,
    name,
    finalJmxPath,
    verdict = 'generated',
    validated = false,
    businessVerified = false,
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
    if (path.resolve(finalCopyPath) !== path.resolve(finalJmxPath)) {
        fs.copyFileSync(finalJmxPath, finalCopyPath);
    }

    const guidePath = path.join(outDir, '00_OPEN_THIS_FIRST.txt');
    const lines = [
        `USE THIS JMX: ${finalName}`,
        '',
        `Verdict: ${verdict}`,
        `JMeter validation: ${validated ? 'RAN' : 'NOT RUN'}`,
        `Source JMX: ${path.basename(finalJmxPath)}`,
        `Report: ${safeName}_report.html`,
        `Run log: log.txt`,
        '',
        validated
            ? 'This JMX is the final file selected by the agent after the JMeter feedback loop.'
            : 'This JMX was generated but not proven by a JMeter validation run.',
        '',
        businessVerified
            ? 'Business check: confirmed by an explicit business assertion.'
            : 'Business check: HTTP GREEN only means enabled HTTP requests passed. It does not prove the business record was created unless the report/recording contains an explicit create assertion or you confirm the record in the app.',
        '',
        'Keep the other JMX files for debugging/history; open the 00_USE_THIS... file in JMeter first.',
    ];
    fs.writeFileSync(guidePath, lines.join('\n') + '\n');

    return { finalCopyPath, guidePath };
}

module.exports = { writeFinalJmxPointer };
