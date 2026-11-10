import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function getModelStatus(env = process.env) {
    if (env.JINGJING_ALLOW_MOCK === '1') {
        return { mode: 'demo', ready: true, model: 'mock-in-character' };
    }
    if (!env.DEEPSEEK_API_KEY?.trim()) {
        return { mode: 'unconfigured', ready: false, model: null, reason: 'missing-key' };
    }
    try {
        const endpoint = new URL(env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com');
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
            throw new Error('Invalid model endpoint');
        }
    } catch {
        return { mode: 'unconfigured', ready: false, model: null, reason: 'invalid-endpoint' };
    }
    return { mode: 'model', ready: true, model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const status = getModelStatus();
    console.log(JSON.stringify(status));
    process.exitCode = status.ready ? 0 : 2;
}
