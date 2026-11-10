#!/usr/bin/env node
// Jingjing MCP server for dsh: game state reader, knowledge lookup, event stream and float-window speech.
// Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). No third-party dependencies.
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { KnowledgeBase } from './knowledge.mjs';
import { GameMonitor } from './game.mjs';
import { EventQueue } from './events.mjs';
import { PetHub } from './pet-hub.mjs';
import { eventLevel, gateFor, wakes } from './gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: 'jingjing', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const EMOTIONS = ['neutral', 'smug', 'disgust', 'panic', 'stubborn', 'serious', 'curious', 'thinking'];
const MAX_WAIT_MS = 600000;
const SAY_SOFT_LIMIT = 45;

const KB_PATH = process.env.JINGJING_KB_PATH || resolve(HERE, '../../pet/knowledge/Probably-Stolen-鲸鲸知识库-v2.md');
const GLOSSARY_PATH = process.env.JINGJING_GLOSSARY_PATH
    || resolve(HERE, '../../vendor/CharacterLife-VideoCohost/examples/video-cohost/jargon/glossary.json');
const PET_PORT = Number(process.env.JINGJING_PET_PORT || 8790);
const PET_ENABLED = process.env.JINGJING_PET !== '0';
const STATE_PATH = process.env.JINGJING_GAME_STATE_PATH || undefined;
const GATE = gateFor(process.env.JINGJING_CHATTY);
const DEFAULT_WAIT_MS = 180000;
// No wait for this long after the last one ended = the loop has stopped (the model ended its turn).
const LOOP_STALE_MS = 60000;
const DATA_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CharacterCompanion', 'dsh');
const DECISION_LOG = join(DATA_DIR, 'decisions.jsonl');

function log(message) {
    process.stderr.write(`[jingjing-mcp] ${message}\n`);
}

const queue = new EventQueue();
let lastSpokeAt = 0;
let pendingTurn = null;

/** Companion loop state for the float window: listening, thinking (between waits), or not running. */
function loopState() {
    if (queue.listening > 0) return { state: 'listening', label: '陪玩中 · 盯着店' };
    if (queue.lastWaitEndedAt && Date.now() - queue.lastWaitEndedAt < LOOP_STALE_MS) return { state: 'thinking', label: '陪玩中 · 思考' };
    return { state: 'off', label: queue.lastWaitEndedAt ? '陪玩已停 · 在 dsh 里说“开始陪玩”' : '未在陪玩 · 在 dsh 里说“开始陪玩”' };
}

function logDecision(entry) {
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        appendFileSync(DECISION_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch { /* logging must never break the loop */ }
}

const knowledge = new KnowledgeBase({ knowledgePath: KB_PATH, glossaryPath: existsSync(GLOSSARY_PATH) ? GLOSSARY_PATH : null });
const game = new GameMonitor({ statePath: STATE_PATH, onEvent: event => queue.push({ source: 'game', ...event, level: eventLevel(event, GATE) }) });
const pet = PET_ENABLED ? new PetHub({
    port: PET_PORT, log,
    onChat: text => {
        queue.push({ source: 'player', tag: 'player_said', level: 'urgent', urgent: true, at: new Date().toLocaleString('zh-CN', { hour12: false }), summary: text });
        const loop = loopState();
        // Without a listening loop the message would sit in the queue unanswered; say so instead of failing silently.
        return loop.state === 'off' ? { notice: `消息已记下，但${loop.label}` } : {};
    },
    status: () => ({ game: game.bridge.status(), companion: loopState() }),
}) : null;

const TOOLS = [
    {
        name: 'game_status',
        description: '读取《Probably Stolen》当前实时状态：资金、天数、房租、调查进度、犯罪值、声望、当前来客、柜台上的货及鉴定（标签 vs 实际）、库存概况。回答任何关于“现在”的问题前先调用，不要凭记忆报数字。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'game_inventory',
        description: '列出店里的物品（含来客摆在柜台上的货），可按名称关键词或位置过滤；有鉴定数据的货会附“标签 vs 实际”。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '物品名称或 id 关键词，可留空' },
                location: { type: 'string', description: '位置 id 或中文名，如 store/主库存、outer-counter/外柜台' },
                limit: { type: 'integer', minimum: 1, maximum: 300, default: 60 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'game_recent',
        description: '最近的成交、资金变动、房租、击杀记录和柜台对话（来自读取模组的日志）。',
        inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    },
    {
        name: 'kb_lookup',
        description: '查鲸鲸的游戏知识库与术语表：机制、化学制药配方与温度、纯度档位与价格、幸运/彩票、治安与调查、派系、NPC 术语等。回答游戏机制或攻略问题前先查，用查到的数字回答。',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '关键词或原问题，如“梦尘温度”“水质”“彩票”' } }, required: ['query'], additionalProperties: false },
    },
    {
        name: 'wait_for_event',
        description: '陪玩模式开头用一次：等待下一批值得考虑的事件。events 是要你考虑的事（玩家在浮窗打的字 tag=player_said 必须回应；虚标货、捡漏、治安官、调查过线、房租、大额交易），background 是期间的普通来往（只作参考）。之后每批都用 react，不再单独调用本工具。没有事件时到时返回 timedOut=true，不是错误。',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS },
                afterSeq: { type: 'integer', minimum: 0, description: '从哪个序号之后读；省略表示接着上次读到的位置' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'react',
        description: '陪玩循环的核心，每批事件必须调用一次：先想（speak 说不说、reason 为什么），要说就给 text；本工具发出台词后直接等待并返回下一批事件（格式同 wait_for_event）。不想说也必须调用（speak=false），否则陪玩会停。',
        inputSchema: {
            type: 'object',
            properties: {
                speak: { type: 'boolean', description: '这批事件值不值得开口。玩家说话时必须 true。' },
                reason: { type: 'string', maxLength: 120, description: '一句话：为什么说或不说（写入决策日志，玩家看不到）' },
                text: { type: 'string', maxLength: 300, description: 'speak=true 时要说的一句话，40 字以内' },
                emotion: { type: 'string', enum: EMOTIONS, default: 'neutral' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS },
            },
            required: ['speak', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'pet_say',
        description: '让桌面浮窗里的鲸鲸说一句话并切换表情。陪玩时你对玩家说的话必须通过它发出，玩家看不到你的普通文本输出。一次一到两句，短。',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', minLength: 1, maxLength: 300 },
                emotion: { type: 'string', enum: EMOTIONS, default: 'neutral' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
];

const INSTRUCTIONS = [
    'jingjing 服务连着玩家本机的《Probably Stolen》读取模组和鲸鲸桌面浮窗。',
    '问“现在”用 game_status / game_inventory / game_recent；问机制攻略用 kb_lookup；陪玩循环：wait_for_event 开头一次，之后每批都用 react（它会接着等下一批）。',
    '游戏数据只说工具返回的；工具说未就绪就照实说游戏没连上，攻略照答。',
].join('\n');

function text(value) {
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function callTool(name, args = {}, signal) {
    switch (name) {
    case 'game_status': return text(game.status());
    case 'game_inventory': return text(game.inventory(args));
    case 'game_recent': return text(game.recent(args));
    case 'kb_lookup': return text(knowledge.lookup(args.query));
    case 'wait_for_event':
        return text(await waitBatch(args, signal));
    case 'react': {
        const speak = args.speak === true;
        const line = String(args.text ?? '').trim();
        const emotion = EMOTIONS.includes(args.emotion) ? args.emotion : 'neutral';
        let said = null;
        if (speak && line) said = speakLine(line, emotion);
        else if (pendingTurn !== null) pet?.silent(pendingTurn);
        pendingTurn = null;
        logDecision({ speak: Boolean(said), reason: String(args.reason ?? '').slice(0, 200), ...(said ? { text: line, emotion } : {}) });
        const next = await waitBatch(args, signal);
        const note = said ? { said } : speak ? { said: { delivered: false, reason: 'speak=true 但没给 text，这次没说' } } : {};
        return text({ ...note, ...next });
    }
    case 'pet_say': {
        const line = String(args.text ?? '').trim();
        if (!line) return { ...text('text 不能为空'), isError: true };
        const emotion = EMOTIONS.includes(args.emotion) ? args.emotion : 'neutral';
        const said = speakLine(line, emotion);
        pendingTurn = null;
        return text(said);
    }
    default: return { ...text(`未知工具：${name}`), isError: true };
    }
}

/** One gated wait: player speech at once, notable events after the speech cooldown, routine as background. */
async function waitBatch(args, signal) {
    const timeoutMs = Math.max(1000, Math.min(Number(args.timeoutMs) || DEFAULT_WAIT_MS, MAX_WAIT_MS));
    const result = await queue.wait({
        timeoutMs, signal, wakes: item => wakes(item, GATE), holdUntil: lastSpokeAt + GATE.cooldownMs,
        ...(Number.isSafeInteger(args.afterSeq) ? { afterSeq: args.afterSeq } : {}),
    });
    if (!result.timedOut && pet) pendingTurn = pet.think();
    const compact = item => ({ seq: item.seq, tag: item.tag, at: item.at, summary: item.summary });
    // A live digest saves a game_status round trip; customers often leave before a reply is ready.
    return {
        events: result.events.map(compact), timedOut: result.timedOut, lastSeq: result.lastSeq,
        ...(result.background ? { background: result.background.map(item => item.summary) } : {}),
        ...(result.backgroundOmitted ? { backgroundOmitted: result.backgroundOmitted } : {}),
        ...(result.dropped ? { dropped: result.dropped } : {}),
        now: game.brief(),
        next: result.timedOut ? '没有新事：直接再调 react（speak=false）继续等。' : '想一下值不值得说，然后调 react。',
    };
}

/** Deliver a line to the float window (on the pending thinking turn, if any) and start the cooldown. */
function speakLine(line, emotion) {
    lastSpokeAt = Date.now();
    if (!pet) return { delivered: false, reason: '浮窗已关闭', advice: '把这句话写进对话回复里，然后继续 react 循环。' };
    const result = pet.say(line.slice(0, 300), emotion, pendingTurn);
    // Live play showed the model drifting to 70+ characters; nudge it without cutting the sentence.
    const length = [...line].length;
    const warning = length > SAY_SOFT_LIMIT ? { warning: `这句 ${length} 字，超过 40 字。下一句只说结论，一句话。` } : {};
    const reason = pet.listening ? '浮窗没打开，话没人看到'
        : pet.lastError === 'EADDRINUSE' ? `浮窗端口 ${PET_PORT} 被占用（多半是另一个 dsh jingjing 或旧版 relay 在运行）`
            : `浮窗服务未就绪：${pet.lastError ?? '启动中'}`;
    // Without this the full-power agent starts debugging the machine instead of keeping the shop.
    const advice = '不要排查系统，把这句话写进对话回复里，继续 react 循环。';
    return result.delivered ? { ...result, ...warning } : { ...result, ...warning, reason, advice };
}

// ---- JSON-RPC plumbing ----
const inflight = new Map();

function send(message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handle(message) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (method === 'notifications/cancelled') { inflight.get(params?.requestId)?.abort(); return; }
    if (!isRequest) return;
    try {
        if (method === 'initialize') {
            return send({ id, result: { protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
                capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } });
        }
        if (method === 'ping') return send({ id, result: {} });
        if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
        if (method === 'tools/call') {
            const controller = new AbortController();
            inflight.set(id, controller);
            try {
                return send({ id, result: await callTool(params?.name, params?.arguments ?? {}, controller.signal) });
            } finally {
                inflight.delete(id);
            }
        }
        if (method === 'resources/list') return send({ id, result: { resources: [] } });
        if (method === 'prompts/list') return send({ id, result: { prompts: [] } });
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (error) {
        return send({ id, result: { ...text(`工具出错：${error.message}`), isError: true } });
    }
}

await knowledge.load();
game.start();
pet?.listen();

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    void handle(message);
});
rl.on('close', () => {
    game.stop();
    pet?.close();
    process.exit(0);
});
