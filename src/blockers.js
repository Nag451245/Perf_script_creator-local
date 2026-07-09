'use strict';
/**
 * blockers.js — when the agent is beaten, say EXACTLY what a human must
 * provide, instead of a generic "needs attention".
 *
 * A senior engineer's terminal state is never "it failed"; it is "give me a
 * test account without MFA", "the env is returning 500s to bare requests —
 * fix staging first", "I need a second recording". Each rule here is
 * evidence-gated: it only fires when the recording/run actually shows the
 * condition, and each blocker carries a one-line ask a human can act on
 * without reading the whole report.
 */

const LOGIN_LABEL_RE = /login|identifier|password|authenticate|signin|sign-in/i;
const MFA_RE = /\b(otp|totp|mfa|2fa|webauthn|authenticator)\b/i;

/**
 * @returns {Array<{id, blocker, ask, evidence}>}
 */
function deriveBlockers({
    result = {},
    runCfg = {},
    entries = [],
    hasSecondRecording = true,
    ghostsRefused = 0,
} = {}) {
    const blockers = [];
    const reqs = (result.samples || []).filter(s => !s.isTransaction);
    const failing = reqs.filter(s => s.success === false);
    const codeOf = (s) => String(s.responseCode || s.code || '');

    // 1. Login rejected and we have no operator credentials to try.
    const authFail = failing.find(s => LOGIN_LABEL_RE.test(String(s.label || s.name || '')) && /^(401|403)$/.test(codeOf(s)));
    if (authFail) {
        const noCreds = !(runCfg.credentials && runCfg.credentials.username);
        blockers.push({
            id: 'credentials',
            blocker: `${authFail.label || authFail.name} was rejected (${codeOf(authFail)})`,
            ask: noCreds
                ? 'Provide a valid test account in perfscript.config.json → run.credentials (username/password). The recorded account may be rotated or locked.'
                : 'The configured run.credentials were rejected — confirm the account is still valid on this environment.',
            evidence: `label="${authFail.label || authFail.name}" code=${codeOf(authFail)}`,
        });
    }

    // 2. The recorded flow contains an MFA/OTP step — unreplayable by design.
    const mfaEntry = entries.find(e => {
        const url = (e.request && e.request.url) || '';
        const body = (e.request && e.request.postData && e.request.postData.text) || '';
        const params = ((e.request && e.request.postData && e.request.postData.params) || []).map(p => p.name).join(' ');
        return MFA_RE.test(url) || MFA_RE.test(params) || /name=["']?(otp|totp|mfa|code_challenge_method_mfa)/i.test(body);
    });
    if (mfaEntry && failing.length) {
        blockers.push({
            id: 'mfa',
            blocker: 'the recorded flow contains an MFA/OTP step — single-use codes cannot be replayed or synthesized',
            ask: 'Use a test account with MFA disabled for this environment, or provide a TOTP seed the script may use.',
            evidence: (mfaEntry.request && mfaEntry.request.url || '').slice(0, 120),
        });
    }

    // 3. Environment health: a request that succeeded when recorded now 5xxs.
    const envFail = failing.find(s => /^5\d\d$/.test(codeOf(s)));
    if (envFail) {
        blockers.push({
            id: 'environment',
            blocker: `${envFail.label || envFail.name} returns ${codeOf(envFail)} — it succeeded when recorded`,
            ask: `Manually hit this endpoint once (browser/curl) to separate "environment is unhealthy" from "script is missing session state". If a logged-in browser also fails, fix staging before iterating on the script.`,
            evidence: `label="${envFail.label || envFail.name}" code=${codeOf(envFail)}`,
        });
    }

    // 4. Unresolved dynamics with only ONE recording — variance is the tool.
    if (!hasSecondRecording && failing.length) {
        blockers.push({
            id: 'second-recording',
            blocker: 'failures remain and only a single recording was provided — dynamic-vs-static is a guess without variance',
            ask: 'Record the SAME flow a second time and drop it in input/ as <flow>__run2 (JMX+recording or HAR). Two recordings turn correlation guesses into facts.',
            evidence: `${failing.length} failing sampler(s), single-recording mode`,
        });
    }

    // 5. Client-minted values that need a signing secret never present in traffic.
    if (ghostsRefused > 0) {
        blockers.push({
            id: 'signing-secret',
            blocker: `${ghostsRefused} client-minted value(s) look signed (HMAC/JWT-like) — the signing key never appears in traffic`,
            ask: 'Ask the dev team for the signing logic/key for these values, or confirm their consumers are safe to disable. See the ghosts section of the reasoning report for names.',
            evidence: `ghostsRefused=${ghostsRefused}`,
        });
    }

    return blockers;
}

function renderBlockersMarkdown(name, blockers) {
    const lines = [`# ${name} — blocked: what a human must provide`, ''];
    if (!blockers.length) { lines.push('No human-input blockers identified.'); return lines.join('\n'); }
    blockers.forEach((b, i) => {
        lines.push(`## ${i + 1}. ${b.blocker}`);
        lines.push('');
        lines.push(`**Ask:** ${b.ask}`);
        lines.push('');
        lines.push(`Evidence: \`${b.evidence}\``);
        lines.push('');
    });
    return lines.join('\n');
}

module.exports = { deriveBlockers, renderBlockersMarkdown };
