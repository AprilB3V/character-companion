import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('relay forwards replies, saves history across restarts, and keeps demos out of records', { timeout: 20000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jingjing-relay-'));
    const expectedReply = '你好，鲸鲸 🐳';
    let finishNative;
    const nativeGate = new Promise(resolve => { finishNative = resolve; });
    const upstream = http.createServer(async (request, response) => {
        if (request.url === '/transcribe') {
            let byteCount = 0;
            for await (const chunk of request) byteCount += chunk.length;
            assert.equal(byteCount, 6400);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            return response.end(JSON.stringify({ text: '本地识别测试' }));
        }
        if (!['/v1/messages', '/v1/chat/completions'].includes(request.url)) {
            request.resume();
            response.writeHead(404, { 'Content-Type': 'application/json' });
            return response.end(JSON.stringify({ error: 'route not implemented' }));
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        assert.equal(request.headers.authorization, 'Bearer test-only-token');
        if (request.url === '/v1/messages') {
            assert.equal(message.text, '直接连接记忆系统');
            assert.ok(request.headers['x-request-id']);
            assert.equal(message.stream, true);
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write('data: {"type":"delta","text":"你好"}\n\n');
            await nativeGate;
            response.write('data: {"type":"delta","text":"，鲸鲸 🐳"}\n\n');
            return response.end(`data: ${JSON.stringify({ type: 'end', reply: expectedReply, instanceId: 'original-jingjing', state: { memories: 7 } })}\n\n`);
        }
        if (message.stream) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const frame = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: expectedReply } }] })}\n\ndata: [DONE]\n\n`);
            for (const byte of frame) {
                response.write(Buffer.from([byte]));
                await new Promise(resolve => setImmediate(resolve));
            }
            response.end();
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: expectedReply } }] }));
        }
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let relay;
    async function startRelay() {
        relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
            env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: `http://127.0.0.1:${upstream.address().port}`,
                HISTORY_DB: join(tempDir, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(tempDir, 'empty'),
                MIC_SETTINGS_PATH: join(tempDir, 'microphone.json'), JINGJING_WORLD_TOKEN: '',
                CHARACTERLIFE_API_TOKEN: 'test-only-token', ASR_URL: `http://127.0.0.1:${upstream.address().port}` },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let errors = '';
        relay.stderr.on('data', chunk => { errors += chunk; });
        await Promise.race([
            once(relay.stdout, 'data'),
            once(relay, 'exit').then(([code]) => { throw new Error(`Relay exited ${code}: ${errors}`); }),
        ]);
    }
    async function stopRelay() {
        if (relay && relay.exitCode === null) {
            const exited = once(relay, 'exit');
            relay.kill();
            await exited;
        }
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await startRelay();
        const avatar = await fetch(baseUrl + '/assets/jingjing-avatar.png');
        assert.equal(avatar.headers.get('content-type'), 'image/png');
        assert.deepEqual([...new Uint8Array(await avatar.arrayBuffer()).slice(0, 4)], [137, 80, 78, 71]);
        const settingsResponse = await fetch(baseUrl + '/api/microphone/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thresholdDb: -31, attackMs: 250, minSpeechMs: 500, silenceMs: 1000 }),
        });
        assert.equal((await settingsResponse.json()).thresholdDb, -31);
        const eventsAbort = new AbortController();
        const eventResponse = await fetch(baseUrl + '/events', { signal: eventsAbort.signal });
        const eventReader = eventResponse.body.getReader();
        // The relay queues host speech; the reply starts once the turn gate decides she can answer.
        const queued = await fetch(baseUrl + '/api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '直接连接记忆系统', durationMs: 800 }),
        });
        assert.equal(queued.status, 202);
        assert.deepEqual(await queued.json(), { queued: true });
        let liveEvents = '';
        const deadline = setTimeout(() => eventsAbort.abort(), 3000);
        try {
            while (!liveEvents.includes('"type":"delta"')) {
                const eventChunk = await eventReader.read();
                assert.equal(eventChunk.done, false);
                liveEvents += new TextDecoder().decode(eventChunk.value);
            }
            assert.match(liveEvents, /你好/);
            assert.equal((await (await fetch(baseUrl + '/history')).json()).conversations[0].status, 'pending');
        } finally { clearTimeout(deadline); finishNative(); eventsAbort.abort(); }
        // Wait for the queued turn to finish before reading history.
        for (let attempt = 0; attempt < 30; attempt++) {
            const records = (await (await fetch(baseUrl + '/history')).json()).conversations;
            if (records.some(record => record.status === 'complete')) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const recognition = await fetch(baseUrl + '/api/transcribe', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Float32Array(1600),
        });
        assert.equal((await recognition.json()).text, '本地识别测试');
        for (const stream of [false, true]) {
            const response = await fetch(baseUrl + '/v1/chat/completions', {
                method: 'POST', headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ stream, messages: [{ role: 'user', content: `测试 ${stream}` }] }),
            });
            assert.equal(response.status, 200);
            await response.text();
        }
        let records = (await (await fetch(baseUrl + '/history')).json()).conversations;
        assert.equal(records.length, 3);
        assert.ok(records.every(record => record.assistantText === expectedReply && record.status === 'complete'));
        await fetch(baseUrl + '/demo');
        assert.equal((await (await fetch(baseUrl + '/history')).json()).conversations.length, 3);
        await stopRelay();
        await startRelay();
        assert.equal((await (await fetch(baseUrl + '/api/microphone/settings')).json()).thresholdDb, -31);
        records = (await (await fetch(baseUrl + '/history?q=' + encodeURIComponent('鲸鲸'))).json()).conversations;
        assert.equal(records.length, 3);
        assert.ok(records.every(record => record.assistantText === expectedReply));
    } finally {
        finishNative();
        await stopRelay();
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        assert.ok(tempDir.startsWith(join(tmpdir(), 'jingjing-relay-')));
        rmSync(tempDir, { recursive: true, force: true });
    }
});
