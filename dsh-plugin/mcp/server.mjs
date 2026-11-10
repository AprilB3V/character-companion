#!/usr/bin/env node
// Jingjing MCP server for dsh: game state reader, knowledge lookup, event stream and float-window speech.
// Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). No third-party dependencies.
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { KnowledgeBase } from './knowledge.mjs';
import { GameMonitor } from './game.mjs';
import { EventQueue } from './events.mjs';
import { PetHub } from './pet-hub.mjs';

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

function log(message) {
    process.stderr.write(`[jingjing-mcp] ${message}\n`);
}

const queue = new EventQueue();
const knowledge = new KnowledgeBase({ knowledgePath: KB_PATH, glossaryPath: existsSync(GLOSSARY_PATH) ? GLOSSARY_PATH : null });
const game = new GameMonitor({ statePath: STATE_PATH, onEvent: event => queue.push({ source: 'game', ...event }) });
const pet = PET_ENABLED ? new PetHub({
    port: PET_PORT, log,
    onChat: text => queue.push({ source: 'player', tag: 'player_said', urgent: true, at: new Date().toLocaleString('zh-CN', { hour12: false }), summary: text }),
    status: () => ({ game: game.bridge.status() }),
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
        description: '陪玩模式用：等待下一批新事件并返回。事件包括游戏里的成交、来客进出、柜台摆货与鉴定、对话、调查进度过线，以及玩家在浮窗里打的字（tag=player_said，必须回应）。没有事件时到时返回 timedOut=true，不是错误。',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_WAIT_MS, default: 120000 },
                afterSeq: { type: 'integer', minimum: 0, description: '从哪个序号之后读；省略表示接着上次读到的位置' },
            },
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
    '问“现在”用 game_status / game_inventory / game_recent；问机制攻略用 kb_lookup；陪玩循环用 wait_for_event + pet_say。',
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
    case 'wait_for_event': {
        const timeoutMs = Math.max(1000, Math.min(Number(args.timeoutMs) || 120000, MAX_WAIT_MS));
        const result = await queue.wait({ timeoutMs, signal, ...(Number.isSafeInteger(args.afterSeq) ? { afterSeq: args.afterSeq } : {}) });
        // A live digest saves a game_status round trip; customers often leave before a reply is ready.
        return text({ ...result, now: game.brief() });
    }
    case 'pet_say': {
        const line = String(args.text ?? '').trim();
        if (!line) return { ...text('text 不能为空'), isError: true };
        const emotion = EMOTIONS.includes(args.emotion) ? args.emotion : 'neutral';
        if (!pet) return text({ delivered: false, reason: '浮窗已关闭（JINGJING_PET=0）' });
        const result = pet.say(line.slice(0, 300), emotion);
        // Live play showed the model drifting to 70+ characters; nudge it without cutting the sentence.
        const length = [...line].length;
        const warning = length > SAY_SOFT_LIMIT ? { warning: `这句 ${length} 字，超过 40 字。下一句只说结论，一句话。` } : {};
        const reason = pet.listening ? '浮窗没打开，话没人看到'
            : pet.lastError === 'EADDRINUSE' ? `浮窗端口 ${PET_PORT} 被占用（多半是另一个 dsh jingjing 或旧版 relay 在运行）`
                : `浮窗服务未就绪：${pet.lastError ?? '启动中'}`;
        // Without this the full-power agent starts debugging the machine instead of keeping the shop.
        const advice = '不要排查系统，把这句话写进对话回复里，继续陪玩循环。';
        return text(result.delivered ? { ...result, ...warning } : { ...result, ...warning, reason, advice });
    }
    default: return { ...text(`未知工具：${name}`), isError: true };
    }
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
