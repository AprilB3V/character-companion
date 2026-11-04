import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
// Use the kernel copy the cohost adapter itself imports (vendor submodule), so both share one module instance.
const VENDOR = '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src';
const { assembleRuntime, createApiServer } = await import(`${VENDOR}/api/index.ts`);
const { createConsoleServer } = await import(`${VENDOR}/console/index.ts`);
const { MockProvider } = await import(`${VENDOR}/index.ts`);
const { JingjingGameAdapter } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/game-adapter.ts');
const { JingjingKnowledge } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/knowledge.ts');
const { jingjingTemplate } = await import('../../vendor/CharacterLife-VideoCohost/examples/characters/jingjing.ts');

const WORLD = 'world_jingjing_video';
const CONSOLE_TOKEN = 'test-console-token-123456';

test('overlay director hotkey -> relay -> owner console -> season director', { timeout: 30000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-director-'));
    const knowledge = new JingjingKnowledge(fileURLToPath(new URL('../../vendor/CharacterLife-VideoCohost/tests/season/fixtures/knowledge.md', import.meta.url)));
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: WORLD, template: jingjingTemplate, provider: new MockProvider({ mode: 'in-character' }),
        world: { enabled: true, worldIds: [WORLD], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge }) });
    const api = createApiServer({ runtime, port: 0, token: 'test-chat-token-123456', logger: () => {}, stIdentityUserId: 'jingjing-video',
        world: { token: 'test-world-token-123456' } });
    const { url } = await api.listen();
    const ownerConsole = createConsoleServer({ runtime, token: CONSOLE_TOKEN, port: 0 });
    const consoleAddress = await ownerConsole.listen();
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let relay;
    try {
        const session = await fetch(url + '/v1/sessions', { method: 'POST',
            headers: { authorization: 'Bearer test-chat-token-123456', 'content-type': 'application/json' }, body: '{}' });
        const { instanceId } = await session.json();
        const instance = runtime.runtimeManager.get(instanceId);
        const adapter = instance.extension;
        // Open the season with a reader snapshot (day 1).
        const now = runtime.clock.nowSim();
        runtime.world.ingest(WORLD, [{ eventId: 'ps:day1:0', instanceId, kind: 'observation', actionId: null, result: null, atWorldTimeMs: now, summary: '读取器快照',
            facts: [{ key: 'source', value: 'probably-stolen' }, { key: 'snapshotId', value: 'day1' }, { key: 'page', value: 0 }, { key: 'pages', value: 1 },
                { key: 'ready', value: true }, { key: 'capturedAt', value: now }, { key: 'cash', value: -200 }, { key: 'save', value: '1:run' },
                { key: 'rent', value: 500 }, { key: 'day', value: 1 }, { key: 'investigation', value: 0 }] }]);
        await runtime.runtimeManager.syncWorld(instanceId);
        assert.deepEqual(adapter.season.state().progress.map(item => item.beatId), ['W0']);

        relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
            env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: url, CHARACTERLIFE_API_TOKEN: 'test-chat-token-123456',
                CHARACTERLIFE_CONSOLE_URL: consoleAddress.url, CHARACTERLIFE_CONSOLE_TOKEN: CONSOLE_TOKEN,
                JINGJING_WORLD_TOKEN: '', JINGJING_GAME_STATE_PATH: join(directory, 'missing.json'),
                HISTORY_DB: join(directory, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(directory, 'empty') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let errors = '';
        relay.stderr.on('data', data => { errors += data; });
        await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error(errors); })]);
        const base = `http://127.0.0.1:${port}`;
        const press = (event, headers = {}) => fetch(base + '/api/director', { method: 'POST',
            headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ event }) });

        const early = await press('director:trial');
        assert.equal(early.status, 200);
        assert.match((await early.json()).message, /没有推进/);
        assert.equal(adapter.season.state().stage, 'watch');

        const closed = await press('director:shop_closed');
        assert.equal(closed.status, 200);
        assert.match((await closed.json()).message, /W1/);
        assert.equal(adapter.season.state().entered.W1.count, 1);
        const apprentice = await press('director:apprentice');
        assert.match((await apprentice.json()).message, /A0/);
        assert.equal(adapter.season.state().stage, 'apprentice');

        assert.equal((await press('kill:ai_controlled')).status, 400, 'only director events pass the relay');
        assert.equal((await press('director:nobody_listens')).status, 409, 'the console refuses events no beat listens to');
        assert.equal((await press('director:trial', { origin: 'https://external.example' })).status, 403, 'other origins are refused');
        // DNS rebinding: a page on a hostile name that resolves to 127.0.0.1 sends a Host and Origin that match each other.
        const rebound = path => new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path, method: 'POST',
                headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'content-type': 'application/json' } }, response => {
                response.resume();
                resolve(response.statusCode);
            });
            request.on('error', reject);
            request.end(JSON.stringify({ event: 'director:trial' }));
        });
        assert.equal(await rebound('/api/director'), 403);
        assert.equal(await rebound('/history'), 403, 'conversation history is not readable through a rebound name either');
        assert.equal(adapter.season.state().stage, 'apprentice');
    } finally {
        if (relay && relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill(); await exited; }
        await ownerConsole.close();
        await api.close();
        runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});
