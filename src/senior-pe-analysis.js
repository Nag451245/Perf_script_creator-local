'use strict';

const fs = require('fs');
const path = require('path');

function analyzeSeniorPeFailure({
    name = '',
    seniorPeDebrief = null,
    result = {},
    blueprintEvidence = null,
    domainProfile = null,
    stackProfile = null,
} = {}) {
    const debrief = seniorPeDebrief || {};
    const effectiveDomainProfile = domainProfile || debrief.domainProfile || null;
    const effectiveStackProfile = stackProfile || effectiveDomainProfile && effectiveDomainProfile.stackProfile || null;
    const flow = debrief.flow || {};
    const firstFailure = firstFailureEvidence(result, blueprintEvidence);
    const brokenBusinessStep = locateBusinessStep(flow.businessSteps || [], firstFailure);
    const failureClass = classifyFailure(firstFailure, brokenBusinessStep);
    const upstreamCause = upstreamCauseFrom(result, firstFailure);
    const riskGaps = riskGapsFrom(debrief, effectiveDomainProfile);
    const recommendedNextStrategy = recommendStrategy({ failureClass, upstreamCause, debrief, result });
    const criticalSteps = criticalStepsFrom(flow.businessSteps || [], debrief, effectiveDomainProfile);

    return {
        name,
        businessJourney: flow.narrative || 'No business flow could be reconstructed from available evidence.',
        objective: debrief.objective || null,
        criticalSteps,
        brokenBusinessStep,
        failureClass,
        upstreamCause,
        techStackSignals: [
            ...((debrief.stackFingerprint && debrief.stackFingerprint.signals) || []),
            ...((effectiveStackProfile && effectiveStackProfile.signals) || []),
        ],
        nativeManagerFindings: debrief.nativeManagers || [],
        validityGates: debrief.validityGates || [],
        riskGaps,
        recommendedNextStrategy,
        seniorPeVerdict: buildSeniorPeVerdict({ result, flow, brokenBusinessStep, riskGaps }),
        domainProfile: effectiveDomainProfile,
        stackProfile: effectiveStackProfile,
        generatedAt: new Date().toISOString(),
    };
}

function firstFailureEvidence(result = {}, blueprintEvidence = null) {
    const forensics = result.failureForensics || blueprintEvidence && blueprintEvidence.failureForensics || null;
    if (forensics && forensics.rootCause) {
        const root = forensics.rootCause;
        return {
            sampler: root.sampler || '',
            index: root.index,
            responseCode: String(root.observedStatus ?? root.observed ?? ''),
            expectedCode: String(root.recordedStatus ?? root.expected ?? ''),
            category: root.category || 'failure_forensics',
            message: forensics.summary || forensics.recommendedAction && forensics.recommendedAction.reason || root.repairHint || '',
            recommendedAction: forensics.recommendedAction || null,
            source: 'failure_forensics',
        };
    }
    if (result.statusRootCause && result.statusRootCause.rootCause) {
        const root = result.statusRootCause.rootCause;
        return {
            sampler: root.sampler || '',
            index: result.statusRootCause.rootCauseIndex,
            responseCode: String(root.observed || ''),
            expectedCode: String(root.expected || ''),
            category: root.category || 'status_drift',
            message: result.statusRootCause.summary || root.repairHint || '',
        };
    }
    const blueprintFailure = blueprintEvidence && blueprintEvidence.firstFailure;
    if (blueprintFailure) {
        return {
            sampler: blueprintFailure.sampler || blueprintFailure.samplerName || blueprintFailure.label || '',
            index: blueprintFailure.index || blueprintFailure.samplerIndex,
            responseCode: String(blueprintFailure.responseCode || ''),
            category: blueprintFailure.category || blueprintFailure.type || '',
            message: blueprintFailure.message || blueprintFailure.failureMessage || '',
        };
    }
    const sample = (result.samples || []).find(s => !s.isTransaction && s.success === false);
    if (sample) {
        return {
            sampler: sample.label || sample.name || '',
            index: sample.index,
            responseCode: String(sample.responseCode || sample.code || ''),
            category: sample.rootCause || sample.category || sample.failureMessage || '',
            message: sample.failureMessage || sample.responseMessage || sample.assertionMessage || '',
        };
    }
    return null;
}

function locateBusinessStep(steps = [], failure = null) {
    if (!failure) return null;
    const idx = Number(failure.index);
    if (Number.isInteger(idx)) {
        const byIndex = steps.find(s => idx >= Number(s.startIndex) && idx <= Number(s.endIndex));
        if (byIndex) return summarizeStep(byIndex);
    }
    const sampler = String(failure.sampler || '').toLowerCase();
    const bySampler = steps.find(s => (s.samplers || []).some(label => String(label || '').toLowerCase() === sampler));
    return bySampler ? summarizeStep(bySampler) : null;
}

function summarizeStep(step) {
    return {
        name: step.name,
        startIndex: step.startIndex,
        endIndex: step.endIndex,
        samplers: step.samplers || [],
    };
}

function classifyFailure(failure = null, brokenStep = null) {
    const hay = `${failure && failure.category || ''} ${failure && failure.sampler || ''} ${failure && failure.message || ''}`.toLowerCase();
    const code = String(failure && failure.responseCode || '');
    if (/auth|login|session|saml|oauth|csrf|xsrf|cookie|token/.test(hay) || /^(401|403)$/.test(code)) return 'auth/session';
    if (/status_drift|recording_drift|semantic|false 200|graphql/.test(hay)) return 'recording-drift';
    if (brokenStep && /submit|update|create|business|checkout|order|record|detail|case/.test(String(brokenStep.name || '').toLowerCase())) return 'business-endpoint';
    if (/\/(case|record|order|checkout|task|claim|submit|save)\b/.test(hay)) return 'business-endpoint';
    if (/5\d\d/.test(code)) return 'environment-or-server';
    return failure ? 'script-or-data' : 'no-failure';
}

function upstreamCauseFrom(result = {}, failure = null) {
    const forensics = result.failureForensics || null;
    if (forensics && forensics.rootCause) {
        const root = forensics.rootCause;
        return {
            category: root.category || 'failure_forensics',
            sampler: root.sampler || failure && failure.sampler || '',
            expected: root.recordedStatus ?? root.expected,
            observed: root.observedStatus ?? root.observed,
            summary: forensics.summary || forensics.recommendedAction && forensics.recommendedAction.reason || root.repairHint || '',
            recommendedAction: forensics.recommendedAction || null,
            source: 'failure_forensics',
        };
    }
    if (result.statusRootCause && result.statusRootCause.rootCause) {
        const root = result.statusRootCause.rootCause;
        return {
            category: root.category || 'status_drift',
            sampler: root.sampler || failure && failure.sampler || '',
            expected: root.expected,
            observed: root.observed,
            summary: result.statusRootCause.summary || root.repairHint || '',
        };
    }
    if (!failure) return null;
    return {
        category: failure.category || 'first_failure',
        sampler: failure.sampler,
        observed: failure.responseCode,
        summary: failure.message || '',
    };
}

function riskGapsFrom(debrief = {}, domainProfile = null) {
    const gaps = [...(debrief.negativeSpace || [])];
    for (const gate of debrief.validityGates || []) {
        if (['review', 'partially_covered'].includes(gate.status)) {
            gaps.push({
                gap: gate.gate,
                severity: gate.required ? 'high' : 'medium',
                action: gate.rationale || 'Review this validity gate before treating the script as production-ready.',
            });
        }
    }
    for (const risk of (domainProfile && domainProfile.risks) || []) {
        gaps.push({ gap: risk.gap || risk.name || 'domain risk', severity: risk.severity || 'medium', action: risk.action || risk.evidence || '' });
    }
    return dedupeBy(gaps, g => `${g.gap}:${g.action}`);
}

function recommendStrategy({ failureClass, upstreamCause, debrief, result }) {
    if (upstreamCause && upstreamCause.recommendedAction && upstreamCause.recommendedAction.id) {
        return {
            id: upstreamCause.recommendedAction.id,
            reason: upstreamCause.recommendedAction.reason || 'Failure forensics identified the safest next action.',
            evidence: upstreamCause.summary || upstreamCause.sampler || '',
        };
    }
    if (upstreamCause && /status|drift/i.test(upstreamCause.category || '')) {
        return {
            id: 'repair-earliest-upstream-drift',
            reason: 'The earliest recording-vs-live divergence is the safest repair target.',
            evidence: upstreamCause.summary || upstreamCause.sampler || '',
        };
    }
    if (failureClass === 'auth/session') {
        return {
            id: 'auth-session-correlation',
            reason: 'Authentication/session evidence failed; repair login/session producers before downstream samplers.',
            evidence: upstreamCause && upstreamCause.sampler || '',
        };
    }
    if (needsNativeManagers(debrief)) {
        return {
            id: 'native-manager-correction',
            reason: 'Recording shows native HTTP state that should be handled by JMeter managers.',
            evidence: (debrief.nativeManagers || []).map(m => `${m.manager}:${m.decision}`).join(', '),
        };
    }
    if (failureClass === 'business-endpoint' || failureClass === 'environment-or-server') {
        return {
            id: 'environment-or-payload-investigation',
            reason: 'The failure is on or near a business endpoint; separate environment health from payload/header drift.',
            evidence: upstreamCause && upstreamCause.sampler || '',
        };
    }
    if (result && result.success === true) {
        return {
            id: 'no-repair-needed-review-gaps',
            reason: 'Run is currently successful; review PE gaps before production load.',
            evidence: '',
        };
    }
    return {
        id: 'collect-more-evidence',
        reason: 'Evidence is insufficient for a safe automated repair strategy.',
        evidence: '',
    };
}

function needsNativeManagers(debrief = {}) {
    return (debrief.nativeManagers || []).some(m => ['required', 'recommended'].includes(m.decision));
}

function criticalStepsFrom(steps = [], debrief = {}, domainProfile = null) {
    const configured = new Set(((domainProfile && domainProfile.businessCriticalSteps) || []).map(s => String(s).toLowerCase()));
    return steps
        .filter(step => configured.has(String(step.name || '').toLowerCase()) || /authenticate|submit|update|create|checkout|order/.test(String(step.name || '').toLowerCase()))
        .map(summarizeStep);
}

function buildSeniorPeVerdict({ result = {}, flow = {}, brokenBusinessStep = null, riskGaps = [] }) {
    if (result.success === false || brokenBusinessStep) {
        return {
            status: 'not_ready',
            summary: brokenBusinessStep
                ? `Business step "${brokenBusinessStep.name}" is not proven.`
                : 'Run has unresolved failures; business flow is not proven.',
        };
    }
    return {
        status: 'review',
        summary: `Flow evidence: ${flow.narrative || 'unknown flow'}. Remaining PE gaps: ${riskGaps.length}.`,
    };
}

function writeSeniorPeAnalysisArtifacts(outDir, name, analysis) {
    fs.mkdirSync(outDir, { recursive: true });
    const safe = safeName(name || analysis.name || 'flow');
    const jsonPath = path.join(outDir, `${safe}_pe_analysis.json`);
    const markdownPath = path.join(outDir, `${safe}_pe_analysis.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));
    fs.writeFileSync(markdownPath, renderSeniorPeAnalysisMarkdown(analysis));
    return { jsonPath, markdownPath };
}

function buildAiStrategy(analysis = {}) {
    const questions = [];
    for (const gap of analysis.riskGaps || []) {
        if (/workload|throughput|data|cleanup|SLO|model/i.test(`${gap.gap} ${gap.action}`)) {
            questions.push(`Confirm ${gap.gap}: ${gap.action}`);
        }
    }
    if (analysis.failureClass === 'auth/session') {
        questions.push('Confirm whether the test account has MFA disabled and whether session cookies/tokens are valid for replay.');
    }
    if (!questions.length && analysis.recommendedNextStrategy && analysis.recommendedNextStrategy.id === 'collect-more-evidence') {
        questions.push('Provide a second recording of the same flow or a working golden JMX so dynamic values can be proven.');
    }
    const evidenceCitations = [];
    if (analysis.upstreamCause) {
        evidenceCitations.push({ source: 'upstreamCause', sampler: analysis.upstreamCause.sampler, summary: analysis.upstreamCause.summary || analysis.upstreamCause.category || '' });
    }
    for (const gap of analysis.riskGaps || []) {
        evidenceCitations.push({ source: 'riskGap', gap: gap.gap, evidence: gap.action || '' });
    }
    return {
        flow: analysis.name || 'flow',
        proposedStrategy: analysis.recommendedNextStrategy || null,
        questions,
        evidenceCitations,
        allowedActions: {
            askQuestions: true,
            citeEvidence: true,
            proposeStrategy: true,
        },
        disallowedActions: ['patchJmxDirectly', 'markGreen', 'bypassBusinessGuard', 'bypassSchemaGate'],
    };
}

function writeAiStrategyArtifacts(outDir, name, strategy) {
    fs.mkdirSync(outDir, { recursive: true });
    const safe = safeName(name || strategy.flow || 'flow');
    const strategyPath = path.join(outDir, `${safe}_ai_strategy.json`);
    const questionsPath = path.join(outDir, `${safe}_human_questions.md`);
    const citationsPath = path.join(outDir, `${safe}_evidence_citations.json`);
    fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));
    fs.writeFileSync(questionsPath, renderHumanQuestions(strategy));
    fs.writeFileSync(citationsPath, JSON.stringify(strategy.evidenceCitations || [], null, 2));
    return { strategyPath, questionsPath, citationsPath };
}

function renderHumanQuestions(strategy = {}) {
    const lines = [`# Human Questions — ${strategy.flow || 'flow'}`, ''];
    const questions = strategy.questions || [];
    if (!questions.length) {
        lines.push('No human questions are required from current evidence.');
    } else {
        for (const q of questions) lines.push(`- ${q}`);
    }
    return lines.join('\n');
}

function renderSeniorPeAnalysisMarkdown(analysis = {}) {
    const lines = [`# Senior PE Analysis — ${analysis.name || 'flow'}`, ''];
    lines.push(`Business journey: ${analysis.businessJourney || 'unknown'}`);
    if (analysis.brokenBusinessStep) lines.push(`Broken business step: ${analysis.brokenBusinessStep.name}`);
    lines.push(`Failure class: ${analysis.failureClass || 'unknown'}`);
    lines.push(`Recommended next strategy: ${analysis.recommendedNextStrategy && analysis.recommendedNextStrategy.id || 'none'}`);
    lines.push('');
    lines.push('## Tech Stack Signals');
    if ((analysis.techStackSignals || []).length) {
        for (const s of analysis.techStackSignals) lines.push(`- ${s.stack || s.name}: ${s.evidence || s.confidence || ''}`);
    } else {
        lines.push('- No strong stack signal detected.');
    }
    lines.push('');
    lines.push('## Risk Gaps');
    if ((analysis.riskGaps || []).length) {
        for (const g of analysis.riskGaps) lines.push(`- ${g.gap} (${g.severity || 'review'}): ${g.action || ''}`);
    } else {
        lines.push('- No major gaps inferred.');
    }
    lines.push('');
    lines.push(`Verdict: ${analysis.seniorPeVerdict && analysis.seniorPeVerdict.summary || 'review required'}`);
    return lines.join('\n');
}

function dedupeBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function safeName(name) {
    return String(name || 'flow').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'flow';
}

module.exports = {
    analyzeSeniorPeFailure,
    writeSeniorPeAnalysisArtifacts,
    renderSeniorPeAnalysisMarkdown,
    buildAiStrategy,
    writeAiStrategyArtifacts,
    _internal: {
        firstFailureEvidence,
        locateBusinessStep,
        classifyFailure,
        recommendStrategy,
        riskGapsFrom,
        renderHumanQuestions,
    },
};
