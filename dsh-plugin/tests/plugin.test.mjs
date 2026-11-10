import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKnowledge, KnowledgeBase } from '../mcp/knowledge.mjs';
import { EventQueue } from '../mcp/events.mjs';
import { GameMonitor, isDiscreteEvent } from '../mcp/game.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = resolve(ROOT, '../pet/knowledge/Probably-Stolen-鲸鲸知识库-v2.md');

test('knowledge rows parse and spoiler markers are stripped', () => {
    const { rows } = parseKnowledge('## 第三层\n| 关键词或别名 | 知识 |\n|---|---|\n| 教会、church | 独立派系。`剧情:需已见过` |\n');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].keys, ['教会', 'church']);
    assert.equal(rows[0].text, '独立派系。');
});

test('real knowledge base answers recipe and water questions', async () => {
    const kb = new KnowledgeBase({ knowledgePath: KB });
    await kb.load();
    const dream = kb.lookup('梦尘要加热到多少度');
    assert.ok(dream.matches.some(match => match.text.includes('40–50°C')));
    const water = kb.lookup('鬼水值多少钱');
    assert.ok(water.matches.some(match => match.text.includes('鬼水')));
    assert.ok(kb.lookup('完全无关的问题xyz').keywords.length > 5);
    assert.ok(!kb.coreContext().includes('剧透栅栏\n'));
});

test('event queue returns bursts and keeps a cursor', async () => {
    const queue = new EventQueue();
    queue.push({ summary: 'a' });
    const first = await queue.wait({ timeoutMs: 50, settleMs: 0 });
    assert.equal(first.events.length, 1);
    const empty = await queue.wait({ timeoutMs: 30, settleMs: 0 });
    assert.equal(empty.timedOut, true);
    setTimeout(() => { queue.push({ summary: 'b' }); queue.push({ summary: 'c' }); }, 10);
    const burst = await queue.wait({ timeoutMs: 1000, settleMs: 20 });
    assert.deepEqual(burst.events.map(event => event.summary), ['b', 'c']);
});

test('game monitor skips page events and history, emits new discrete events once', () => {
    const got = [];
    let clock = 10_000;
    const monitor = new GameMonitor({ statePath: 'nowhere.json', now: () => clock, onEvent: event => got.push(event) });
    const page = { eventId: 'ps:x:0', atWorldTimeMs: 20_000, summary: 'page', facts: [] };
    const old = { eventId: 'ps-event:old', atWorldTimeMs: 5_000, summary: 'old', facts: [] };
    const fresh = { eventId: 'ps-event:new', atWorldTimeMs: 12_000, summary: '卖出', facts: [{ key: 'event', value: 'sale:x' }] };
    assert.equal(isDiscreteEvent(page), false);
    monitor.accept([page, old, fresh]);
    monitor.accept([fresh]);
    assert.equal(got.length, 1);
    assert.equal(got[0].tag, 'sale:x');
});

test('game monitor reads a ready snapshot', async () => {
    // Inside the plugin folder: some sandboxes and AV setups refuse mkdtemp in the system temp dir.
    await mkdir(join(ROOT, 'tests', '.tmp'), { recursive: true });
    const dir = await mkdtemp(join(ROOT, 'tests', '.tmp', 'jj-'));
    const path = join(dir, 'state.json');
    const now = Date.now();
    await writeFile(path, JSON.stringify({
        schemaVersion: 1, source: 'probably-stolen', sessionId: 's1', capturedAt: now, ready: true, saveSlot: 1, runId: 'r1', cash: 1234,
        day: 5, investigation: 40, client: { id: 'npc1', name: '老王', faction: 'FACTION_LOWER' },
        items: [{ id: 'water', name: '瓶装水', location: 'outer-counter', quantity: 2, owner: 'client', role: 'client_offer',
            features: [{ category: 'CATEGORY_WATER_PURITY', label: '纯净水', actual: '鬼水', match: false, overstated: true }] },
        { id: 'coin', name: '赌徒硬币', location: 'store', quantity: 1 }],
        events: [], dialogue: [],
    }), 'utf8');
    const monitor = new GameMonitor({ statePath: path });
    await monitor.bridge.poll();
    const status = monitor.status();
    assert.equal(status.ready, true);
    assert.equal(status.cash, 1234);
    assert.equal(status.client.name, '老王');
    assert.match(status.clientOffers[0], /瓶装水×2（外柜台）；鉴定/);
    assert.equal(monitor.inventory({ query: '硬币' }).items.length, 1);
    assert.equal(monitor.recent().ready, true);
});

test('MCP server handshakes, lists tools and answers kb_lookup over stdio', async () => {
    const child = spawn(process.execPath, [resolve(ROOT, 'mcp/server.mjs')], {
        env: { ...process.env, JINGJING_PET: '0', JINGJING_GAME_STATE_PATH: join(tmpdir(), 'missing-state.json') },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buffer = '';
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            pending.get(message.id)?.(message);
        }
    });
    let nextId = 1;
    const request = (method, params) => new Promise(resolveRequest => {
        const id = nextId++;
        pending.set(id, resolveRequest);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    try {
        const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        assert.equal(init.result.protocolVersion, '2025-06-18');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const list = await request('tools/list', {});
        assert.deepEqual(list.result.tools.map(tool => tool.name).sort(),
            ['game_inventory', 'game_recent', 'game_status', 'kb_lookup', 'pet_say', 'wait_for_event']);
        const kb = await request('tools/call', { name: 'kb_lookup', arguments: { query: '彩票' } });
        assert.match(kb.result.content[0].text, /6\/49/);
        const status = await request('tools/call', { name: 'game_status', arguments: {} });
        assert.match(status.result.content[0].text, /"ready": false/);
        const wait = await request('tools/call', { name: 'wait_for_event', arguments: { timeoutMs: 1000 } });
        assert.match(wait.result.content[0].text, /"timedOut": true/);
    } finally {
        child.stdin.end();
        child.kill();
    }
});

test('pet hub relays float-window chat and speaks over SSE in the overlay protocol', async () => {
    const { PetHub } = await import('../mcp/pet-hub.mjs');
    const chats = [];
    const hub = new PetHub({ port: 0, onChat: text => chats.push(text) });
    hub.listen();
    await new Promise(resolveListen => hub.server.once('listening', resolveListen));
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    try {
        const overlay = await fetch(`${base}/overlay`);
        assert.equal(overlay.status, 200);
        const status = await (await fetch(`${base}/api/status`)).json();
        assert.equal(status.model.ready, true);
        const controller = new AbortController();
        const stream = await fetch(`${base}/events`, { signal: controller.signal });
        const reader = stream.body.getReader();
        await reader.read();
        const chat = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: '这水是真的吗' }) });
        assert.equal(chat.status, 200);
        assert.deepEqual(chats, ['这水是真的吗']);
        const result = hub.say('鬼水，别按纯净水收。', 'smug');
        assert.equal(result.delivered, true);
        let received = '';
        while (!received.includes('"type":"end"')) received += new TextDecoder().decode((await reader.read()).value);
        assert.match(received, /"type":"user".*这水是真的吗/s);
        assert.match(received, /"type":"start".*"emotion":"smug"/s);
        controller.abort();
    } finally {
        hub.close();
    }
});

test('player lines skip the settle window and come first', async () => {
    const queue = new EventQueue();
    setTimeout(() => { queue.push({ summary: 'npc' }); queue.push({ summary: 'hi', urgent: true }); }, 10);
    const started = Date.now();
    const result = await queue.wait({ timeoutMs: 10000, settleMs: 5000 });
    assert.ok(Date.now() - started < 4000);
    assert.deepEqual(result.events.map(event => event.summary), ['hi', 'npc']);
});

test('in-game water names map to knowledge base wording', async () => {
    const kb = new KnowledgeBase({ knowledgePath: KB });
    await kb.load();
    assert.ok(kb.lookup('幽灵水值多少').matches.some(match => match.text.includes('鬼水')));
});

test('installer copies only model rows from another profile patch', async () => {
    const { pickRows } = await import('../scripts/install.mjs');
    const yaml = "- id: agent-default-model\n  config:\n    model: m\n- id: ui\n  name: x\n# === qq ===\n- insert:\n    - id: mcp-qq\n- id: llm-pi-ai\n  config:\n    providers: {}\n";
    const rows = pickRows(yaml, ['agent-default-model', 'llm-pi-ai']);
    assert.match(rows, /model: m/);
    assert.match(rows, /providers/);
    assert.doesNotMatch(rows, /mcp-qq|id: ui/);
});
