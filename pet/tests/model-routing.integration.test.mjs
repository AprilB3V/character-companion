import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function waitFor(url, child, errors) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(errors());
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return await response.json();
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error('Service startup timed out. ' + errors());
}

test('the installed kernel routes Jingjing prompts to the configured gateway', { timeout: 25000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-model-route-'));
    const reply = '我是鲸鲸，在 Probably Stolen 的当铺里。';
    const calls = [];
    const gateway = http.createServer(async (request, response) => {
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        calls.push(body);
        assert.equal(request.headers.authorization, 'Bearer test-model-key');
        const content = JSON.stringify({ reply, proposals: [], memoryWrites: [] });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const reservations = [http.createServer(), http.createServer(), http.createServer()];
    for (const server of reservations) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const [kernelPort, consolePort, relayPort] = reservations.map(server => server.address().port);
    for (const server of reservations) await new Promise(resolve => server.close(resolve));
    const env = {
        ...process.env,
        CHARACTERLIFE_API_TOKEN: 'test-chat-token', CHARACTERLIFE_VIDEO_DB: join(directory, 'kernel.db'),
        CHARACTERLIFE_PORT: String(kernelPort), CHARACTERLIFE_CONSOLE_PORT: String(consolePort),
        JINGJING_OVERLAY_DIR: directory, JINGJING_DATA_DIR: join(directory, 'data'),
        JINGJING_KNOWLEDGE_PATH: fileURLToPath(new URL('../knowledge/Probably-Stolen-鲸鲸知识库-v2.md', import.meta.url)),
        JINGJING_ALLOW_MOCK: '0', JINGJING_TEXT_ONLY: '1', JINGJING_THINKING: '0', JINGJING_PROACTIVE: '0',
        DEEPSEEK_API_KEY: 'test-model-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + gateway.address().port,
        DEEPSEEK_MODEL: 'test-gateway-model', PORT: String(relayPort), CL_URL: 'http://127.0.0.1:' + kernelPort,
        JINGJING_GAME_STATE_PATH: join(directory, 'no-game.json'), FRONTEND_HISTORY_DIR: join(directory, 'empty'),
    };
    const children = [];
    let errors = '';
    const start = name => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../' + name, import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.on('data', chunk => { errors += chunk; });
        children.push(child);
        return child;
    };
    try {
        const kernel = start('kernel-server.mjs');
        await waitFor(env.CL_URL + '/healthz', kernel, () => errors);
        const relay = start('relay.mjs');
        const baseUrl = 'http://127.0.0.1:' + relayPort;
        const status = await waitFor(baseUrl + '/api/status', relay, () => errors);
        assert.equal(status.cl.character.id, 'jingjing');
        assert.equal(status.model.mode, 'model');
        assert.equal(status.model.model, 'test-gateway-model');
        const response = await fetch(baseUrl + '/api/chat', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你是谁？', stream: false }) });
        assert.equal(response.status, 202);
        let saved;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            saved = (await (await fetch(baseUrl + '/history')).json()).conversations.find(record => record.status === 'complete');
            if (saved) break;
            await new Promise(resolve => setTimeout(resolve, 75));
        }
        assert.equal(saved?.assistantText, reply);
        assert.ok(calls.length > 0);
        assert.equal(calls[0].model, 'test-gateway-model');
        assert.ok(JSON.stringify(calls[0]).includes('鲸鲸'));
        assert.ok(!JSON.stringify(calls[0]).includes('沈知微'));
    } finally {
        for (const child of children.reverse()) {
            if (child.exitCode === null) {
                const exited = once(child, 'exit');
                child.kill();
                await exited;
            }
        }
        await new Promise(resolve => gateway.close(resolve));
        assert.ok(directory.startsWith(join(tmpdir(), 'jingjing-model-route-')));
        await rm(directory, { recursive: true, force: true });
    }
});
