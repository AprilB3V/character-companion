import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventQueue } from '../mcp/events.mjs';
import { eventLevel, GATES, wakes } from '../mcp/gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('gate levels: player first, flagged goods and big trades notable, foot traffic routine', () => {
    assert.equal(eventLevel({ tag: 'player_said' }), 'urgent');
    assert.equal(eventLevel({ tag: 'appraisal:client_fake' }), 'notable');
    assert.equal(eventLevel({ tag: 'npc_arrived:security_officer' }), 'notable');
    assert.equal(eventLevel({ tag: 'sale:gold', amount: 800 }), 'notable');
    assert.equal(eventLevel({ tag: 'sale:gold', amount: 800 }, GATES.quiet), 'routine');
    assert.equal(eventLevel({ tag: 'npc_arrived:merchant' }), 'routine');
    assert.equal(eventLevel({ tag: 'dialogue:npc' }), 'routine');
    assert.equal(wakes({ tag: 'dialogue:npc' }, GATES.normal), false);
    assert.equal(wakes({ tag: 'dialogue:npc' }, GATES.lively), true);
});

test('routine traffic does not wake the waiter; it comes back as background with the next notable event', async () => {
    const queue = new EventQueue();
    const gate = item => wakes(item, GATES.normal);
    setTimeout(() => {
        queue.push({ tag: 'npc_arrived:merchant', summary: 'merchant in' });
        queue.push({ tag: 'dialogue:npc', summary: 'hello' });
    }, 10);
    setTimeout(() => queue.push({ tag: 'appraisal:client_fake', summary: 'fake water' }), 120);
    const started = Date.now();
    const result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate });
    assert.ok(Date.now() - started >= 100, 'woke on routine traffic');
    assert.deepEqual(result.events.map(event => event.summary), ['fake water']);
    assert.deepEqual(result.background.map(event => event.summary), ['merchant in', 'hello']);
    assert.equal(queue.listening, 0);
    assert.ok(queue.lastWaitEndedAt);
});

test('cooldown holds notable events, but the player cuts through it', async () => {
    const queue = new EventQueue();
    const gate = item => wakes(item, GATES.normal);
    queue.push({ tag: 'appraisal:client_fake', summary: 'fake' });
    let started = Date.now();
    let result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate, holdUntil: Date.now() + 200 });
    assert.ok(Date.now() - started >= 180, 'cooldown ignored');
    assert.deepEqual(result.events.map(event => event.summary), ['fake']);

    queue.push({ tag: 'appraisal:client_fake', summary: 'fake 2' });
    setTimeout(() => queue.push({ tag: 'player_said', urgent: true, summary: 'hi' }), 30);
    started = Date.now();
    result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate, holdUntil: Date.now() + 3000 });
    assert.ok(Date.now() - started < 1000, 'player waited for the cooldown');
    assert.deepEqual(result.events.map(event => event.summary), ['hi', 'fake 2']);
});

test('react logs the decision, speaks, and returns the next batch; float chat reports a stopped loop', async () => {
    const data = await mkdtemp(join(tmpdir(), 'jj-react-'));
    const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
        cwd: join(ROOT, 'mcp'), stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, JINGJING_PET: '0', JINGJING_GAME_STATE_PATH: join(data, 'missing.json'), LOCALAPPDATA: data },
    });
    const pending = new Map();
    let buffer = '';
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            const message = JSON.parse(line);
            pending.get(message.id)?.(message);
        }
    });
    let nextId = 1;
    const request = (method, params) => new Promise(resolveRequest => {
        const id = nextId++;
        pending.set(id, resolveRequest);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).result.content[0].text);
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        const list = await request('tools/list', {});
        assert.ok(list.result.tools.some(tool => tool.name === 'react'));
        const result = await call('react', { speak: false, reason: '没什么事', timeoutMs: 1000 });
        assert.equal(result.timedOut, true);
        assert.match(result.next, /react/);
        assert.equal(result.now.ready, false, 'the first batch carries the digest');
        assert.equal('lastSeq' in result, false, 'no fields the model does not act on');
        assert.ok(!list.result.tools.find(tool => tool.name === 'react').inputSchema.properties.timeoutMs, 'the model cannot shorten the idle wait');
        const spoken = await call('react', { speak: true, reason: '测试', text: '在呢', timeoutMs: 1000 });
        assert.equal(spoken.said.delivered, false);
        assert.equal(spoken.now, undefined, 'an unchanged digest is left out');
        const restart = await call('wait_for_event', { timeoutMs: 1000 });
        assert.equal(restart.now.ready, false, 'a new loop gets the digest again');
        const { readFile } = await import('node:fs/promises');
        const log = (await readFile(join(data, 'CharacterCompanion', 'dsh', 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(log.map(entry => entry.speak), [false, true]);
        assert.equal(log[1].text, '在呢');
    } finally {
        child.stdin.end();
        child.kill();
    }
});

test('pet hub passes the loop notice back to the float window', async () => {
    const { PetHub } = await import('../mcp/pet-hub.mjs');
    const hub = new PetHub({ port: 0, onChat: () => ({ notice: '消息已记下，但未在陪玩' }), status: () => ({ companion: { state: 'off', label: '未在陪玩' } }) });
    hub.listen();
    await new Promise(resolveListen => hub.server.once('listening', resolveListen));
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    try {
        const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: '在吗' }) })).json();
        assert.equal(chat.notice, '消息已记下，但未在陪玩');
        const status = await (await fetch(`${base}/api/status`)).json();
        assert.equal(status.companion.state, 'off');
    } finally {
        hub.close();
    }
});

test('session overlay: other MCP servers off, early compaction in every preset, js expressions kept', async () => {
    const { buildOverlay } = await import('../scripts/overlay.mjs');
    const dump = [
        '# == bundle',
        '- id: preset-standard',
        "  name: '@deepseek-ai/dsh-agent-preset'",
        '  config:',
        '    id: standard',
        '    plugins:',
        '      - id: tool-bash',
        "        disabled: !!js process.platform === 'win32'",
        '      - id: planning',
        '        config:',
        '          text: |-',
        '            first paragraph',
        '',
        '            second paragraph',
        '      - id: compaction',
        '        name: cordis:group',
        '        group: true',
        '        config:',
        '          - id: compaction-basic',
        "            name: '@deepseek-ai/dsh-compaction-basic'",
        '          - id: command-compact',
        '- id: preset-minimal',
        "  name: '@deepseek-ai/dsh-agent-preset'",
        '  config:',
        '    plugins: []',
        '- id: mcp-jingjing',
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '- id: mcp-taptap-maker',
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        '    serverName: taptap-maker',
        '- id: mcp-old',
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  disabled: true',
        '',
    ].join('\r\n');
    const overlay = buildOverlay(dump);
    assert.deepEqual(overlay.disabledMcp, ['mcp-taptap-maker']);
    assert.deepEqual(overlay.presets, ['preset-standard']);
    assert.match(overlay.text, /- id: mcp-taptap-maker\n  disabled: true/);
    assert.match(overlay.text, /disabled: !!js process\.platform === 'win32'/);
    assert.match(overlay.text, /first paragraph\n\n {12}second paragraph/, 'block scalars keep their blank lines');
    assert.match(overlay.text, / {10}- id: compaction-basic\n {12}name: '@deepseek-ai\/dsh-compaction-basic'\n {12}config:\n {14}thresholdRatio: 0\.25\n {14}retainRatio: 0\.05\n {10}- id: command-compact/);
    assert.equal(buildOverlay(dump, { keepMcp: true }).disabledMcp.length, 0);
    // An already configured compaction is left to the user.
    const configured = dump.replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: '@deepseek-ai/dsh-compaction-basic'\r\n            config:\r\n              auto: false");
    assert.deepEqual(buildOverlay(configured).presets, []);
});
