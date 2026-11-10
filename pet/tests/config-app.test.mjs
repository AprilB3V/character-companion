import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, normalizeModelInput, parseEnv, renderEnv, statusFromText, validateModelInput, maskSecret, TOKEN_KEY } from '../config-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'config-app.mjs');
const FAKE_KEY = 'test-key-0123456789abcdef';
const CL_AUTH = 'test-cl-auth-1234';
// Build env lines without literal NAME=value pairs so the repository secret scan stays clean.
const envLine = (name, value, prefix = '') => prefix + [name, value].join('=');

test('commented model lines are detected and recovered', () => {
    const text = [envLine(TOKEN_KEY, CL_AUTH), envLine('DEEPSEEK_API_KEY', FAKE_KEY, '# '),
        envLine('DEEPSEEK_BASE_URL', 'https://api.deepseek.com', '#'), envLine('DEEPSEEK_MODEL', 'deepseek-chat', '# '), ''].join('\n');
    assert.equal(statusFromText(text).ready, false);
    const result = diagnose({ exists: true, text });
    assert.deepEqual(result.fromComment, ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']);
    assert.equal(result.values.DEEPSEEK_API_KEY, FAKE_KEY);
    assert.ok(result.problems.some(problem => problem.code === 'commented'));
    const fixed = renderEnv(text, normalizeModelInput({ apiKey: result.values.DEEPSEEK_API_KEY, baseUrl: result.values.DEEPSEEK_BASE_URL, model: result.values.DEEPSEEK_MODEL }));
    assert.equal(statusFromText(fixed).ready, true);
    assert.ok(!/^#\s*DEEPSEEK/m.test(fixed));
    assert.equal(parseEnv(fixed).active[TOKEN_KEY], CL_AUTH);
});

test('deleted lines, missing token and BOM are reported and repaired', () => {
    const text = '﻿# my note\nCHARACTERLIFE_THINK_MODEL=x\n';
    const codes = diagnose({ exists: true, text }).problems.map(problem => problem.code);
    assert.deepEqual(codes.sort(), ['bom', 'missing-lines', 'missing-token']);
    const fixed = renderEnv(text, { apiKey: FAKE_KEY, baseUrl: '', model: '' });
    const { active } = parseEnv(fixed);
    assert.match(active.CHARACTERLIFE_API_TOKEN, /^[0-9a-f]{64}$/);
    assert.equal(active.DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
    assert.equal(active.DEEPSEEK_MODEL, 'deepseek-chat');
    assert.equal(active.CHARACTERLIFE_THINK_MODEL, 'x');
    assert.ok(fixed.includes('# my note'));
    assert.ok(!fixed.startsWith('﻿'));
    assert.deepEqual(diagnose({ exists: false, text: '' }).problems.map(problem => problem.code), ['missing-file']);
});

test('copy-paste mistakes are normalized and validated', () => {
    const input = normalizeModelInput({ apiKey: ` Bearer ${FAKE_KEY} `, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions/', model: ' "ep-123" ' });
    assert.deepEqual(input, { apiKey: FAKE_KEY, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'ep-123' });
    assert.deepEqual(validateModelInput(input), {});
    const fullWidth = 'sk－全角';
    assert.ok(validateModelInput({ apiKey: fullWidth, baseUrl: '', model: '' }).apiKey);
    assert.ok(validateModelInput({ apiKey: 'x', baseUrl: 'ftp://a', model: '' }).baseUrl);
    assert.ok(validateModelInput({ apiKey: 'x', baseUrl: 'https://u:p@a.example', model: '' }).baseUrl);
    assert.ok(validateModelInput({ apiKey: '', baseUrl: '', model: '' }).apiKey);
    assert.ok(!maskSecret(FAKE_KEY).includes('0123456789'));
});

function startApp(env) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [APP, '--no-open'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', chunk => {
            out += chunk;
            const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(out);
            if (match) resolvePromise({ child, origin: `http://127.0.0.1:${match[1]}`, session: match[2] });
        });
        child.stderr.on('data', chunk => { out += chunk; });
        child.on('exit', code => reject(new Error(`config app exited ${code}: ${out}`)));
    });
}

test('server enforces token and host, saves, tests and backs up', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-config-'));
    const configPath = join(dir, 'config', '.env.video.local');
    // Fake OpenAI-compatible endpoint.
    let seenAuth = '';
    const fake = createServer((req, res) => {
        seenAuth = req.headers.authorization;
        res.writeHead(req.url === '/v1/chat/completions' ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/v1/chat/completions' ? { model: 'm1', choices: [{ message: { content: '好' } }] } : { error: { message: `bad ${FAKE_KEY}` } }));
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fakeBase = `http://127.0.0.1:${fake.address().port}/v1`;
    const app = await startApp({ CHARACTER_COMPANION_CONFIG: configPath, CHARACTER_COMPANION_HOME: dir });
    t.after(async () => { app.child.kill(); fake.close(); await rm(dir, { recursive: true, force: true }); });
    const call = (path, body, headers = {}) => fetch(app.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Config-Token': app.session, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    assert.equal((await fetch(`${app.origin}/?t=wrong`)).status, 403);
    assert.equal((await fetch(`${app.origin}/?t=${app.session}`)).status, 200);
    assert.equal((await call('/api/state', undefined, { 'X-Config-Token': 'test-nope' })).status, 403);
    assert.equal((await call('/api/save', {}, { 'Content-Type': 'text/plain' })).status, 415);
    // DNS rebinding: a foreign Host header is rejected even with the token.
    const rebinding = await new Promise(resolvePromise => {
        import('node:http').then(({ request }) => {
            const req = request(`${app.origin}/api/state`, { agent: false, headers: { Host: 'evil.example:80', 'X-Config-Token': app.session } }, res => {
                res.resume();
                resolvePromise(res.statusCode);
            });
            req.on('error', () => {});
            req.end();
        });
    });
    assert.equal(rebinding, 421);

    const initial = await (await call('/api/state')).json();
    assert.equal(initial.exists, false);
    assert.equal(initial.status.ready, false);

    const bad = await (await call('/api/test', { apiKey: FAKE_KEY, baseUrl: `${fakeBase}/x`, model: 'm1' })).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 404);
    assert.ok(!bad.detail.includes(FAKE_KEY), 'key must be redacted from error details');

    const good = await (await call('/api/test', { apiKey: FAKE_KEY, baseUrl: `${fakeBase}/chat/completions`, model: 'm1' })).json();
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(seenAuth, `Bearer ${FAKE_KEY}`);

    const saved = await (await call('/api/save', { apiKey: FAKE_KEY, baseUrl: fakeBase, model: 'm1' })).json();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.state.status.ready, true);
    assert.ok(!JSON.stringify(saved).includes(FAKE_KEY), 'state must not echo the key');
    const text = await readFile(configPath, 'utf8');
    assert.equal(parseEnv(text).active.DEEPSEEK_API_KEY, FAKE_KEY);

    // Keep the saved key when the field is left blank; old file is backed up.
    const again = await (await call('/api/save', { apiKey: '', keepKey: true, baseUrl: fakeBase, model: 'm2' })).json();
    assert.equal(again.ok, true);
    assert.equal(parseEnv(await readFile(configPath, 'utf8')).active.DEEPSEEK_MODEL, 'm2');
    assert.ok(existsSync(`${configPath}.bak`));
    assert.equal(parseEnv(await readFile(configPath, 'utf8')).active[TOKEN_KEY], parseEnv(text).active[TOKEN_KEY]);
});

test('--ensure exits 0 when configured and for -Demo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-ensure-'));
    const configPath = join(dir, '.env.video.local');
    await writeFile(configPath, [envLine(TOKEN_KEY, CL_AUTH), envLine('DEEPSEEK_API_KEY', FAKE_KEY), ''].join('\n'));
    const run = extra => new Promise(r => spawn(process.execPath, [APP, '--ensure', '--no-open', ...extra], {
        env: { ...process.env, CHARACTER_COMPANION_CONFIG: configPath }, stdio: 'ignore',
    }).on('exit', r));
    assert.equal(await run([]), 0);
    await writeFile(configPath, envLine('DEEPSEEK_API_KEY', FAKE_KEY, '# '));
    assert.equal(await run(['-Demo']), 0);
    await rm(dir, { recursive: true, force: true });
});
