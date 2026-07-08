'use strict';

const DEFAULT_FLASH_MODEL = 'gemini-3.5-flash';
const DEFAULT_PRO_MODEL = 'gemini-3.1-pro-preview';

function resolveGeminiModel(args = [], config = {}, env = process.env) {
    if (env && env.GOOGLE_MODEL) return env.GOOGLE_MODEL;

    const flags = new Set(Array.isArray(args) ? args : []);
    const gemini = config.gemini && typeof config.gemini === 'object' ? config.gemini : {};
    if (flags.has('--gemini-pro')) return gemini.proModel || DEFAULT_PRO_MODEL;
    return gemini.model || DEFAULT_FLASH_MODEL;
}

module.exports = {
    DEFAULT_FLASH_MODEL,
    DEFAULT_PRO_MODEL,
    resolveGeminiModel,
};
