import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
import { assembleRuntime } from '../../../CLResearch/CharacterLife/src/api/runtime-factory.ts';
import { createApiServer } from '../../../CLResearch/CharacterLife/src/api/server.ts';
import { MockProvider } from '../../../CLResearch/CharacterLife/src/conversation/providers/mock.ts';
import { SpyProvider } from '../../../CLResearch/CharacterLife/tests/helpers.ts';

test('game file -> relay -> real CL world route -> model context, without fabricated chat history', { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-e2e-'));
    const provider = new SpyProvider(new MockProvider({ mode: 'in-character' }));
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_jingjing_video', provider,
        world: { enabled: true, worldIds: ['world_jingjing_video'], acceptObservations: true,
            allowedVerbs: [], allowedTargets: [] } });
    const api = createApiServer({ runtime, port: 0, token: 'test-chat-token-123456', logger: () => {},
        stIdentityUserId: 'jingjing-video', world: { token: 'test-world-token-123456' } });
    const { url } = await api.listen();
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let relay;
    try {
        const session = await fetch(url + '/v1/sessions', { method: 'POST',
            headers: { authorization: 'Bearer test-chat-token-123456', 'content-type': 'application/json' }, body: '{}' });
        const { instanceId } = await session.json();
        const statePath = join(directory, 'state.json');
        const snapshot = { schemaVersion: 1, source: 'probably-stolen', sessionId: 'fixture-game', ready: true,
            capturedAt: Date.now(), saveSlot: 2, runId: 'run-2', cash: 8765,
            items: [{ id: 'magnifier', name: '放大镜', location: 'store', quantity: 1 }] };
        await writeFile(statePath, JSON.stringify(snapshot));
        relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
            env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: url, CHARACTERLIFE_API_TOKEN: 'test-chat-token-123456',
                JINGJING_WORLD_TOKEN: 'test-world-token-123456', JINGJING_GAME_STATE_PATH: statePath,
                HISTORY_DB: join(directory, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(directory, 'empty') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let errors = '';
        relay.stderr.on('data', data => { errors += data; });
        await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error(errors); })]);
        const base = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 6000;
        while (runtime.world.observations(instanceId).length === 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(runtime.world.observations(instanceId).length > 0);
        const state = await (await fetch(base + '/api/game/state')).json();
        assert.equal(state.connected, true);
        assert.equal(state.state.cash, 8765);
        assert.equal(state.state.items[0].name, '放大镜');
        assert.equal((await (await fetch(base + '/history')).json()).conversations.length, 0);
        const chat = await fetch(base + '/api/chat', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '现在有多少钱和什么物品？' }) });
        // The relay queues host speech and answers once the turn gate decides the host is done.
        assert.equal(chat.status, 202);
        const replyDeadline = Date.now() + 6000;
        while (Date.now() < replyDeadline) {
            const records = (await (await fetch(base + '/history')).json()).conversations;
            if (records.some(record => record.status === 'complete')) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(provider.lastRequest, 'CL was never asked for a reply');
        const data = provider.lastRequest.messages.map(message => message.content).join('\n');
        assert.match(data, /8765/);
        assert.match(data, /放大镜/);
        assert.ok(!provider.lastRequest.system.includes('8765'));
        assert.equal((await (await fetch(base + '/history')).json()).conversations.length, 1);
        assert.equal(runtime.persistence.listMemories(instanceId).length, 0);
        const blocked = await fetch(base + '/api/game/state', { headers: { origin: 'https://external.example' } });
        assert.equal(blocked.status, 403);
    } finally {
        if (relay && relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill(); await exited; }
        await api.close();
        runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});
