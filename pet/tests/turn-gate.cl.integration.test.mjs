import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
import { assembleRuntime } from '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src/api/runtime-factory.ts';
import { createApiServer } from '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src/api/server.ts';
import { MockProvider } from '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src/conversation/providers/mock.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Records every model request; the first one is slow so the host can interrupt it.
class SlowFirstProvider {
    requests = [];
    #inner = new MockProvider({ mode: 'in-character' });
    get name() { return this.#inner.name; }
    get model() { return this.#inner.model; }
    async complete(request) {
        this.requests.push(request);
        if (this.requests.length === 1) await sleep(2500);
        return this.#inner.complete(request);
    }
}

test('an interrupted reply is committed once in real CL, and the follow-up sends only the new speech', { timeout: 30000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-gate-cl-'));
    const provider = new SlowFirstProvider();
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_jingjing_video', provider });
    const api = createApiServer({ runtime, port: 0, token: 'test-chat-token-123456', logger: () => {}, stIdentityUserId: 'jingjing-video' });
    const { url } = await api.listen();
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let relay;
    try {
        relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
            env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: url, CHARACTERLIFE_API_TOKEN: 'test-chat-token-123456',
                JINGJING_WORLD_TOKEN: '', JINGJING_GAME_STATE_PATH: join(directory, 'missing.json'),
                HISTORY_DB: join(directory, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(directory, 'empty') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let errors = '';
        relay.stderr.on('data', data => { errors += data; });
        await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error(errors); })]);
        const base = `http://127.0.0.1:${port}`;
        const say = text => fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, durationMs: 600 }) });

        assert.equal((await say('房租交了。')).status, 202);
        // Wait until CL is generating the first reply, then keep talking.
        const started = Date.now();
        while (provider.requests.length === 0 && Date.now() - started < 5000) await sleep(50);
        assert.equal(provider.requests.length, 1);
        assert.equal((await say('还有一件事')).status, 202);

        const deadline = Date.now() + 15000;
        let records = [];
        while (Date.now() < deadline) {
            records = (await (await fetch(base + '/history')).json()).conversations;
            if (records.some(record => record.status === 'complete')) break;
            await sleep(100);
        }
        assert.equal(records.find(record => record.userText === '房租交了。')?.status, 'interrupted');
        assert.equal(records.find(record => record.status === 'complete')?.userText, '房租交了。还有一件事');

        // CL ran the first turn anyway (it cannot abort), so the second request must not repeat it.
        assert.equal(provider.requests.length, 2);
        const second = provider.requests[1].messages.map(message => message.content).join('\n');
        assert.match(second, /还有一件事/);
        assert.match(second, /上一条回复主播没有看到/);
        assert.equal(second.split('房租交了').length - 1, 1, 'the first utterance appears once, from CL history');
    } finally {
        if (relay && relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill(); await exited; }
        await api.close();
        runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});
