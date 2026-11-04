// 鲸鲸浮窗中转：语音前端 → 本中转 → CL 服务端
// 原样转发 /v1/* 请求，同时把「你说的话」和「鲸鲸的回复」推给浮窗页面。
// Node 22.13+; start with start.cmd to configure local speech and CL credentials.
//   环境变量：CL_URL（默认 http://127.0.0.1:8787）  PORT（默认 8790）

import http from 'node:http'
import https from 'node:https'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ConversationStore } from './history-store.mjs'
import { randomUUID } from 'node:crypto'
import { GameWorldBridge, DEFAULT_GAME_STATE_PATH } from './game-world.mjs'
import { readNativeReply } from './native-stream.mjs'
import { normalizeMicSettings } from './voice-input.mjs'
import { servePresentation } from './presentation-http.mjs'
import { TurnGate } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/turn/turn-gate.ts'
import { EventLog } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/contract/event-log.ts'
import { PROACTIVE_CONFIG_PATH, loadProactiveConfig } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/config.ts'
import { ProactiveRunner } from './proactive-runner.mjs'
import { AsrCorrector, DEFAULT_GLOSSARY, glossaryHints, knowledgeHints, loadCorpus } from './asr-correction.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8790)
const UPSTREAM = new URL(process.env.CL_URL ?? 'http://127.0.0.1:8787')
const agent = UPSTREAM.protocol === 'https:' ? https : http
const conversationStore = new ConversationStore(process.env.HISTORY_DB ?? join(here, 'data', 'conversations.sqlite'))
conversationStore.importFrontend(process.env.FRONTEND_HISTORY_DIR ?? join(here, '..', 'Open-LLM-VTuber', 'chat_history', 'jingjing_video_001'))
const activeTurns = new Map()
const ASR_URL = process.env.ASR_URL ?? 'http://127.0.0.1:8791'
const CL_TOKEN = process.env.CHARACTERLIFE_API_TOKEN ?? ''
const MIC_SETTINGS_PATH = process.env.MIC_SETTINGS_PATH ?? join(here, 'data', 'microphone-settings.json')
// Recognition self-correction: editable glossary plus an optional constrained model pass.
const GLOSSARY_PATH = process.env.ASR_GLOSSARY_PATH ?? join(here, 'data', 'asr-glossary.json')
const CORRECTION_LOG = join(here, 'data', 'asr-corrections.jsonl')
if (!existsSync(GLOSSARY_PATH)) writeFileSync(GLOSSARY_PATH, `${JSON.stringify(DEFAULT_GLOSSARY, null, 4)}
`, 'utf8')
const asrCorrector = new AsrCorrector({
    glossaryPath: GLOSSARY_PATH,
    corpus: await loadCorpus(process.env.ASR_CORPUS_DIR ?? join(here, 'data', 'asr-corpus')),
    extraHints: [...new Set([
        ...await knowledgeHints(process.env.JINGJING_KNOWLEDGE_PATH ?? join(here, 'knowledge', 'Probably-Stolen-鲸鲸知识库-v2.md')),
        // Owner-confirmed game terms, so the correction pass knows them too.
        ...await glossaryHints(process.env.JINGJING_GLOSSARY_PATH ?? join(here, '..', 'vendor', 'CharacterLife-VideoCohost', 'examples', 'video-cohost', 'jargon', 'glossary.json')),
    ])],
    model: { baseUrl: process.env.DEEPSEEK_BASE_URL ?? '', apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: process.env.DEEPSEEK_MODEL ?? '' },
})
const WORLD_TOKEN = process.env.JINGJING_WORLD_TOKEN ?? await readFile(join(here, 'data', 'game-world-token.txt'), 'utf8').then(value => value.trim()).catch(() => '')
// Director hotkeys go through the owner console action; its token never leaves this process.
const CONSOLE_URL = new URL(process.env.CHARACTERLIFE_CONSOLE_URL ?? 'http://127.0.0.1:8788')
const CONSOLE_TOKEN = process.env.CHARACTERLIFE_CONSOLE_TOKEN ?? await readFile(join(here, 'data', 'console-token.txt'), 'utf8').then(value => value.trim()).catch(() => '')
const DIRECTOR_EVENT = /^director:[a-z_]{1,40}$/
const gameBridge = new GameWorldBridge({
    statePath: process.env.JINGJING_GAME_STATE_PATH ?? DEFAULT_GAME_STATE_PATH,
    send: async events => {
        if (!WORLD_TOKEN) throw new Error('Missing world credential')
        const identity = await clRequest('/v1/identity/me')
        if (!identity.instanceId) throw new Error('Missing CL identity')
        for (let offset = 0; offset < events.length; offset += 10) {
            const batch = events.slice(offset, offset + 10)
            const result = await clRequest('/v1/world/events', {
                method: 'POST', headers: { Authorization: `Bearer ${WORLD_TOKEN}` },
                body: JSON.stringify({ worldId: 'world_jingjing_video',
                    events: batch.map(event => ({ ...event, instanceId: identity.instanceId })) }),
                signal: AbortSignal.timeout(5000),
            })
            if (result.rejected?.length || (result.accepted?.length ?? 0) + (result.duplicates?.length ?? 0) !== batch.length) {
                throw new Error('World observations rejected')
            }
        }
    },
})

async function clRequest(path, options = {}) {
    if (!CL_TOKEN) throw new Error('CL token is not configured')
    const response = await fetch(new URL(path, UPSTREAM), {
        ...options,
        headers: { Authorization: `Bearer ${CL_TOKEN}`, 'Content-Type': 'application/json', ...options.headers },
        signal: options.signal ?? AbortSignal.timeout(options.method === 'POST' ? 150000 : 5000),
    })
    if (!response.ok) throw new Error(`CL HTTP ${response.status}`)
    return await response.json()
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
}

async function handleLocalApi(req, res, path) {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        return sendJson(res, 403, { error: '请从本机浮窗使用此接口。' })
    }
    if (req.method === 'GET' && path === '/api/microphone/settings') {
        const settings = await readFile(MIC_SETTINGS_PATH, 'utf8').then(JSON.parse).catch(() => ({}))
        return sendJson(res, 200, normalizeMicSettings(settings))
    }
    if (req.method === 'GET' && path === '/api/game/state') {
        const state = gameBridge.snapshot()
        return sendJson(res, state ? 200 : 503, { ...gameBridge.status(), state })
    }
    if (req.method === 'GET' && path === '/api/status') {
        const [clResult, asrResult] = await Promise.allSettled([
            (async () => {
                const identity = await clRequest('/v1/identity/me')
                const state = identity.instanceId ? await clRequest(`/v1/characters/${identity.instanceId}/state`) : null
                return { connected: true, instanceId: identity.instanceId, memories: state?.memories ?? 0, capture: 'relaxed' }
            })(),
            fetch(new URL('/health', ASR_URL), { signal: AbortSignal.timeout(5000) }).then(async response => {
                if (!response.ok) throw new Error('ASR unavailable')
                return await response.json()
            }),
        ])
        return sendJson(res, 200, {
            cl: clResult.status === 'fulfilled' ? clResult.value : { connected: false },
            asr: asrResult.status === 'fulfilled' ? asrResult.value : { ready: false },
            game: gameBridge.status(),
        })
    }
    if (req.method !== 'POST' || !['/api/chat', '/api/transcribe', '/api/microphone/settings', '/api/director', '/api/presentation/listening', '/api/presentation/voice'].includes(path)) {
        return sendJson(res, 404, { error: '没有此接口。' })
    }
    const chunks = []
    let byteCount = 0
    for await (const chunk of req) {
        byteCount += chunk.length
        if (byteCount > 4 * 1024 * 1024) return sendJson(res, 413, { error: '录音过长，请分段说话。' })
        chunks.push(chunk)
    }
    const body = Buffer.concat(chunks)
    if (path === '/api/transcribe') {
        try {
            const response = await fetch(new URL('/transcribe', ASR_URL), {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
                signal: AbortSignal.timeout(60000),
            })
            const result = await response.json()
            if (!response.ok || typeof result.text !== 'string' || !result.text.trim()) return sendJson(res, response.status, result)
            const corrected = await asrCorrector.correct(result.text.trim())
            if (corrected.changes.length) {
                // Local tuning log for the glossary; never sent anywhere.
                await appendFile(CORRECTION_LOG, `${JSON.stringify({ at: Date.now(), original: corrected.original, text: corrected.text, changes: corrected.changes })}
`, 'utf8').catch(() => {})
            }
            return sendJson(res, 200, { text: corrected.text, original: corrected.original, changes: corrected.changes, correction: corrected.model })
        } catch {
            return sendJson(res, 503, { error: '本地语音识别未就绪，请稍后重试。' })
        }
    }
    let input
    try { input = JSON.parse(body.toString('utf8')) } catch {
        return sendJson(res, 400, { error: '请求格式不正确。' })
    }
    if (path === '/api/presentation/listening') {
        // Capture UI reports only that the host is listening; it cannot interrupt generation.
        if (!activeGeneration && !displayTimer) logEvent({ type: 'overlay', state: 'listening' })
        return sendJson(res, 200, { ok: true })
    }
    if (path === '/api/presentation/voice') {
        // VAD edges from the page: proactive speech never starts while the host is speaking.
        proactiveRunner?.observeHostSpeech(input?.speaking === true)
        return sendJson(res, 200, { ok: true })
    }
    if (path === '/api/director') {
        const event = typeof input?.event === 'string' ? input.event : ''
        if (!DIRECTOR_EVENT.test(event)) return sendJson(res, 400, { error: '导演事件格式不正确。' })
        if (!CONSOLE_TOKEN) return sendJson(res, 503, { error: '尚未配置后台令牌，导演操作不可用。' })
        try {
            const identity = await clRequest('/v1/identity/me')
            if (!identity.instanceId) throw new Error('Missing CL identity')
            const response = await fetch(new URL(`/api/instances/${encodeURIComponent(identity.instanceId)}/plugins/probably-stolen/actions/director.trigger`, CONSOLE_URL), {
                method: 'POST', headers: { Authorization: `Bearer ${CONSOLE_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ params: { event } }), signal: AbortSignal.timeout(5000),
            })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) return sendJson(res, response.status === 409 ? 409 : 502, { error: result.message ?? result.error ?? '导演操作被拒绝。' })
            return sendJson(res, 200, { message: result.message ?? `${event} 已发送` })
        } catch {
            return sendJson(res, 502, { error: '连不上后台，导演操作没有发出。' })
        }
    }
    if (path === '/api/microphone/settings') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return sendJson(res, 400, { error: '设置格式不正确。' })
        const settings = normalizeMicSettings(input)
        await writeFile(MIC_SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf8')
        return sendJson(res, 200, settings)
    }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text || text.length > 4000) return sendJson(res, 400, { error: '请说一句话，或输入不超过 4000 字的文字。' })
    if (!CL_TOKEN) return sendJson(res, 503, { error: '尚未配置 CL 连接，请使用启动脚本。' })
    // Host speech goes into the turn gate; the reply is generated when the gate decides she can answer.
    // speechEndAt comes from the page (same machine clock): segment cut time minus the silence already waited.
    const now = Date.now()
    const endMs = Number.isFinite(input.speechEndAt) ? Math.min(now, Math.max(now - 30000, input.speechEndAt)) : now
    const durationMs = Number.isFinite(input.durationMs) && input.durationMs > 0 ? Math.min(input.durationMs, 60000) : 0
    const original = typeof input.original === 'string' && input.original.trim() && input.original.trim() !== text ? input.original.trim().slice(0, 4000) : null
    logEvent({ type: 'asr', text, original, startMs: endMs - durationMs, endMs, confidence: null })
    const action = turnGate.addUtterance({ text, original, startMs: endMs - durationMs, endMs })
    proactiveRunner?.noteHostUtterance(endMs)
    if (action?.kind === 'cancel_generation') cancelGeneration()
    if (action?.kind === 'yield') yieldToHost(action.showYieldLine)
    // Poll now: the page may report speech that already ended a while ago.
    checkGateNow()
    return sendJson(res, 202, { queued: true })
}

// ---- 浮窗事件广播（SSE）----
const clients = new Set()
const history = []
let seq = 0
let turnSeq = Date.now()

// ---- 说完判定（TurnGate）+ 思维循环：等主播说完再想；想的时候新话并进同一轮；说的时候被打断则合并 ----
const turnGate = new TurnGate()
let gateTimer = null
let displayTimer = null
let displayingTurn = null
// { turn, controller, phase: 'thinking' | 'speaking', shownText, originals }
let activeGeneration = null
const YIELD_LINE = '……你先说'
// JINGJING_THINKING=0 keeps the pre-stage-5 path (reply to every turn through /v1/messages).
let thinkingEnabled = process.env.JINGJING_THINKING !== '0'
const INTERRUPTED_NOTICE = '主播在你上一条回复显示之前又接着说了，上一条回复主播没有看到。下面是主播接着说的话，请合在一起回应。'
const PROACTIVE_UNSEEN_NOTICE = '你刚才主动想说的话没有显示出来，主播没有看到；需要的话可以再说一次。'
// Set when a proactive turn that already reached CL is cancelled; the next turn tells her so once.
let unseenProactiveReply = false
// While CL finishes an interrupted reply: retry a new turn every 300 ms, for up to a minute.
const SPEAKING_RETRY_MS = 300
const SPEAKING_RETRIES = 200
// Every state change goes to a JSONL event log, for replay tests and for re-rendering the overlay when editing.
const eventLog = new EventLog(process.env.JINGJING_EVENT_LOG ?? join(here, 'data', 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`))
const logEvent = event => {
    eventLog.append(event).catch(() => {})
    broadcast({ type: 'presentation', event })
}

// ---- 主动搭话（任务 B）：游戏事件 → 触发器与闸门 → 思考层决定说不说；不加大全局说话概率 ----
const proactiveConfig = loadProactiveConfig()
const proactiveRunner = process.env.JINGJING_PROACTIVE === '0' || !CL_TOKEN ? null : new ProactiveRunner({
    settings: proactiveConfig.proactive,
    eventsDir: process.env.JINGJING_GAME_EVENTS_DIR ?? join(here, 'data', 'game-events'),
    logDir: process.env.JINGJING_PROACTIVE_LOG_DIR ?? join(here, 'data', 'proactive'),
    // Busy: thinking, speaking, a reply on screen, or host speech still waiting in the turn gate.
    isBusy: () => Boolean(activeGeneration || displayTimer || turnGate.nextDeadline(Date.now()) !== null),
    // Who is at the counter right now (also after a relay restart, when no arrival event was seen).
    visitor: () => {
        const state = gameBridge.snapshot()
        if (!state?.ready) return undefined
        return state.client ? (state.client.isSecurity ? 'security_officer' : state.client.id) : null
    },
    think: async (inputs, onSpeaking) => {
        // Without a thinking model every turn would be spoken; proactive lines need the decision.
        if (!thinkingEnabled) return { should_speak: false, utterance: null, reason: '思考层未开启' }
        const result = await generateReply({ utterances: [], originals: [], carried: 0 }, { inputs, onSpeaking })
        if (!result) return { should_speak: false, utterance: null, reason: '被打断或出错' }
        return { should_speak: result.outcome === 'spoke', utterance: result.reply ?? null, reason: result.reason ?? result.outcome }
    },
})

// The gate keeps running while she thinks (new speech joins the turn); it waits while she speaks or a reply is on screen.
const gateBlocked = () => Boolean(displayTimer || (activeGeneration && activeGeneration.phase === 'speaking'))

function scheduleGate() {
    // Always re-arm: new speech can move the next check earlier or later.
    clearTimeout(gateTimer)
    gateTimer = null
    if (gateBlocked()) return
    const now = Date.now()
    const deadline = turnGate.nextDeadline(now)
    if (deadline === null) return
    gateTimer = setTimeout(runGate, Math.max(0, deadline - now))
    gateTimer.unref?.()
}

function checkGateNow() {
    clearTimeout(gateTimer)
    gateTimer = null
    if (gateBlocked()) return
    runGate()
}

function runGate() {
    gateTimer = null
    const action = turnGate.poll(Date.now())
    if (action.kind === 'flush') {
        logEvent({ type: 'turn', result: 'done', reason: action.merge ? `${action.reason} (joins the turn in flight)` : action.reason })
        if (action.merge && activeGeneration?.phase === 'thinking') void mergeIntoThinking(action)
        else void generateReply(action)
        return
    }
    scheduleGate()
}

function cancelGeneration() {
    if (!activeGeneration) return
    if (activeGeneration.proactive && activeGeneration.sent) unseenProactiveReply = true
    const { turn, controller } = activeGeneration
    activeGeneration = null
    controller.abort()
    broadcast({ type: 'cancel', turn })
    logEvent({ type: 'overlay', state: 'idle', text: 'cancelled' })
}

function yieldToHost(showYieldLine) {
    // Host started talking while the reply was on screen: stop there, optionally add a short line.
    clearTimeout(displayTimer)
    displayTimer = null
    if (displayingTurn !== null) broadcast({ type: 'yield', turn: displayingTurn, ...(showYieldLine ? { text: YIELD_LINE } : {}) })
    logEvent({ type: 'overlay', state: 'yield', ...(showYieldLine ? { text: YIELD_LINE } : {}) })
    displayingTurn = null
}

function showReply(turn, reply, extra = {}) {
    broadcast({ type: 'end', turn, text: reply, ...extra })
    activeGeneration = null
    turnGate.markDisplaying()
    displayingTurn = turn
    logEvent({ type: 'overlay', state: 'speaking', text: reply, ...(extra.emotion ? { emotion: extra.emotion } : {}) })
    // Display time follows the caption pace: characters / 5 + 1 s.
    displayTimer = setTimeout(() => {
        displayTimer = null
        displayingTurn = null
        turnGate.markIdle()
        logEvent({ type: 'overlay', state: 'idle' })
        scheduleGate()
    }, [...reply].length / 5 * 1000 + 1000)
    displayTimer.unref?.()
}

/**
 * One turn: think, then speak or stay silent. `proactive` carries event inputs when she considers speaking
 * on her own (no host speech); host speech that arrives meanwhile joins the same thought.
 * Resolves to { outcome: 'spoke' | 'silent', reply?, reason? }, or undefined when cancelled or failed.
 */
async function generateReply(flush, proactive = null) {
    const turn = ++turnSeq
    const controller = new AbortController()
    // The page shows everything the host said in this turn (nothing for a proactive turn).
    const shownText = flush.utterances.join('')
    const originals = flush.originals.filter(Boolean)
    activeGeneration = { turn, controller, phase: thinkingEnabled ? 'thinking' : 'speaking', shownText, originals, proactive: Boolean(proactive) }
    broadcast({ type: 'user', turn, text: shownText, ...(originals.length ? { original: originals.join(' / ') } : {}), ...(proactive ? { proactive: true } : {}) })
    // CL cannot abort a turn, so a cancelled request was still committed there. Send only the new speech,
    // and tell her the previous reply never reached the host.
    const fresh = flush.utterances.slice(flush.carried)
    const lines = fresh.length ? fresh : flush.utterances
    activeGeneration.lines = [...lines]
    activeGeneration.sent = false
    const notices = flush.carried > 0 ? [INTERRUPTED_NOTICE] : []
    if (unseenProactiveReply) { notices.push(PROACTIVE_UNSEEN_NOTICE); unseenProactiveReply = false }
    // Enter the phase before any await: speech meanwhile must join this turn, not start a second one.
    if (thinkingEnabled) turnGate.markThinking()
    else turnGate.markGenerating()
    try {
        await gameBridge.poll()
        if (thinkingEnabled) {
            broadcast({ type: 'thinking', turn })
            logEvent({ type: 'overlay', state: 'thinking' })
            // Lines merged before the request leaves join it directly (CL does not know this turn yet).
            if (activeGeneration?.turn !== turn) return
            activeGeneration.sent = true
            const inputs = [...(proactive?.inputs ?? []), ...activeGeneration.lines.map(text => ({ kind: 'speech', text }))]
            const body = JSON.stringify({ inputs, stream: true, ...(notices.length ? { notices } : {}) })
            const requestId = randomUUID()
            let response
            // CL keeps generating an interrupted reply (it cannot abort) and answers 409 SPEAKING until it is done:
            // wait for it instead of failing the new turn.
            for (let attempt = 0; ; attempt++) {
                response = await fetch(new URL('/v1/think', UPSTREAM), {
                    method: 'POST', headers: { Authorization: `Bearer ${CL_TOKEN}`, 'Content-Type': 'application/json', 'X-Request-Id': requestId },
                    body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]),
                })
                if (response.status !== 409 || attempt >= SPEAKING_RETRIES) break
                const refusal = await response.json().catch(() => ({}))
                if (refusal?.error?.code !== 'SPEAKING') { response = null; break }
                await new Promise(resolve => setTimeout(resolve, SPEAKING_RETRY_MS))
                if (activeGeneration?.turn !== turn) return
            }
            if (!response) throw new Error('CL refused the turn')
            if (response.status === 503 || response.status === 404) {
                // CL has no thinking model configured (503) or predates /v1/think (404): reply to every turn as before.
                thinkingEnabled = false
                await response.body?.cancel()
                if (activeGeneration?.turn !== turn) return
                // A proactive turn without host speech needs the decision it can no longer get: stay silent.
                if (proactive && !activeGeneration.lines.length) return endSilently(turn, null, '思考层不可用')
                activeGeneration.phase = 'speaking'
                return await speakDirectly(turn, controller, (proactive ? activeGeneration.lines : lines).join(''), notices)
            }
            if (!response.ok) throw new Error(`CL HTTP ${response.status}`)
            let hasDeltas = false
            const result = await readNativeReply(response, delta => {
                if (activeGeneration?.turn !== turn) return
                hasDeltas = true
                broadcast({ type: 'delta', turn, text: delta })
            }, event => {
                if (activeGeneration?.turn !== turn || event.type !== 'decided') return
                logEvent({ type: 'thought', result: event.thought })
                if (event.thought.decision === 'silent') return
                // A purely proactive line never starts over the host: they may have begun talking during the thought.
                if (activeGeneration.proactive && !activeGeneration.merged && !proactiveMaySpeak()) {
                    // Nothing of the host is in flight for an unmerged proactive turn: reset the gate, then answer the host.
                    turnGate.markIdle()
                    cancelGeneration()
                    logEvent({ type: 'overlay', state: 'idle', text: 'proactive line yielded to the host' })
                    checkGateNow()
                    return
                }
                if (activeGeneration.proactive) proactive?.onSpeaking?.()
                // Decided to speak: from now on new speech interrupts instead of joining.
                activeGeneration.phase = 'speaking'
                turnGate.markGenerating()
                clearTimeout(gateTimer)
                gateTimer = null
                broadcast({ type: 'start', turn, decision: event.thought.decision, emotion: event.thought.emotion, ...(proactive ? { proactive: true } : {}) })
            })
            if (activeGeneration?.turn !== turn) return
            if (result.silent) return endSilently(turn, result.thought, result.thought?.reason ?? '')
            if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('Empty CL reply')
            if (!hasDeltas) broadcast({ type: 'delta', turn, text: result.reply })
            showReply(turn, result.reply, { ...(result.state ? { state: result.state } : {}), ...(result.thought?.emotion ? { emotion: result.thought.emotion } : {}) })
            return { outcome: 'spoke', reply: result.reply, reason: result.thought?.reason ?? '' }
        }
        turnGate.markGenerating()
        return await speakDirectly(turn, controller, lines.join(''), notices)
    } catch {
        // A cancelled generation is answered by the merged turn instead.
        if (activeGeneration?.turn !== turn) return
        activeGeneration = null
        turnGate.markIdle()
        broadcast({ type: 'error', turn, text: '暂时连接不上 CL，稍后再试。' })
        logEvent({ type: 'overlay', state: 'idle', text: 'error' })
        scheduleGate()
    }
}

/** The host is silent past the quiet window and nothing of theirs is waiting in the turn gate. */
function proactiveMaySpeak() {
    return (proactiveRunner?.hostAllowsSpeaking() ?? true) && turnGate.nextDeadline(Date.now()) === null
}

/** She thought it over and stays silent; the turn ends here. */
function endSilently(turn, thought, reason) {
    broadcast({ type: 'silent', turn, thought })
    activeGeneration = null
    turnGate.markIdle()
    logEvent({ type: 'overlay', state: 'idle', decision: 'silent' })
    scheduleGate()
    return { outcome: 'silent', reason }
}

/** Reply without thinking (thinking disabled or not configured in CL). */
async function speakDirectly(turn, controller, text, notices) {
    turnGate.markGenerating()
    broadcast({ type: 'start', turn })
    let hasDeltas = false
    const response = await fetch(new URL('/v1/messages', UPSTREAM), {
        method: 'POST', headers: { Authorization: `Bearer ${CL_TOKEN}`, 'Content-Type': 'application/json', 'X-Request-Id': randomUUID() },
        body: JSON.stringify({ text, stream: true, ...(notices.length ? { notices } : {}) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]),
    })
    if (!response.ok) throw new Error(`CL HTTP ${response.status}`)
    const result = await readNativeReply(response, delta => {
        if (activeGeneration?.turn !== turn) return
        hasDeltas = true
        broadcast({ type: 'delta', turn, text: delta })
    })
    if (activeGeneration?.turn !== turn) return
    if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('Empty CL reply')
    if (!hasDeltas) broadcast({ type: 'delta', turn, text: result.reply })
    showReply(turn, result.reply, result.state ? { state: result.state } : {})
}

/** More speech while she thinks: it joins the same turn and continues the thought in CL. */
async function mergeIntoThinking(flush) {
    const generation = activeGeneration
    generation.merged = true
    generation.shownText += flush.utterances.join('')
    generation.originals.push(...flush.originals.filter(Boolean))
    broadcast({ type: 'user', turn: generation.turn, text: generation.shownText,
        ...(generation.originals.length ? { original: generation.originals.join(' / ') } : {}) })
    if (!generation.sent) {
        // The turn has not reached CL yet: these lines go out with it.
        generation.lines.push(...flush.utterances)
        scheduleGate()
        return
    }
    let refused = false
    try {
        const response = await fetch(new URL('/v1/think', UPSTREAM), {
            method: 'POST', headers: { Authorization: `Bearer ${CL_TOKEN}`, 'Content-Type': 'application/json', 'X-Request-Id': randomUUID() },
            body: JSON.stringify({ inputs: flush.utterances.map(text => ({ kind: 'speech', text })), mergeOnly: true }),
            signal: AbortSignal.timeout(5000),
        })
        await response.body?.cancel()
        refused = response.status !== 202
    } catch {
        refused = true
    }
    scheduleGate()
    if (!refused) return
    const refusedLines = flush.utterances.map((text, index) => ({ text, original: flush.originals[index] ?? null }))
    if (activeGeneration && activeGeneration !== generation) {
        // A newer turn is running: the refused lines are host speech that still needs an answer. Queue them
        // like new speech, without touching the newer turn's state in the gate.
        const now = Date.now()
        for (const line of refusedLines) {
            const action = turnGate.addUtterance({ text: line.text, original: line.original, startMs: now, endMs: now })
            if (action?.kind === 'cancel_generation') cancelGeneration()
            if (action?.kind === 'yield') yieldToHost(action.showYieldLine)
        }
        checkGateNow()
        return
    }
    // She was already speaking, or the thought already ended: take the turn back and send it as a new one.
    // Pass the refused lines themselves: the turn in flight may already have been cleared meanwhile.
    turnGate.refuseMerge(refusedLines, Date.now())
    if (activeGeneration === generation) cancelGeneration()
    checkGateNow()
}

function broadcast(evt) {
  evt.id = ++seq
  evt.at = Date.now()
  if (evt.type === 'user') {
    const record = { id: `relay:${evt.turn}`, userText: evt.text, assistantText: '',
      status: 'pending', createdAt: evt.at, source: evt.demo ? 'demo' : 'relay' }
    activeTurns.set(evt.turn, record)
    if (!evt.demo) conversationStore.save(record)
  } else if (evt.type === 'end' || evt.type === 'error' || evt.type === 'cancel' || evt.type === 'silent') {
    const record = activeTurns.get(evt.turn)
    if (record) {
      record.assistantText = evt.type === 'cancel' || evt.type === 'silent' ? '' : evt.text ?? ''
      record.status = { end: 'complete', cancel: 'interrupted', silent: 'silent' }[evt.type] ?? 'error'
      if (record.source !== 'demo') conversationStore.save(record)
      activeTurns.delete(evt.turn)
    }
  }
  history.push(evt)
  if (history.length > 200) history.shift()
  const frame = `id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`
  for (const res of clients) {
    if (evt.type === 'presentation' && !res.acceptPresentation) continue
    res.write(frame)
  }
}

function openEvents(req, res) {
  res.acceptPresentation = new URL(req.url, 'http://127.0.0.1').searchParams.get('presentation') === '1'
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  // 重连时只补发缺失的事件；首次连接补发最近几轮
  const last = Number(req.headers['last-event-id'] ?? 0)
  const replay = last ? history.filter((e) => e.id > last) : history.slice(-60)
  for (const e of replay) {
    if (e.type === 'presentation' && !res.acceptPresentation) continue
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`)
  }
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(ping)
    clients.delete(res)
  })
}

// ---- 从 OpenAI 格式里取文字 ----
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
  return ''
}

function lastUserText(body) {
  try {
    const msgs = JSON.parse(body).messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return textOf(msgs[i].content)
  } catch {}
  return ''
}

// ---- 转发 ----
function proxy(req, res, body) {
  const isChat = req.method === 'POST' && req.url.split('?')[0] === '/v1/chat/completions'
  const turn = isChat ? ++turnSeq : 0
  if (isChat) {
    const said = lastUserText(body)
    if (said) broadcast({ type: 'user', turn, text: said })
  }

  const headers = { ...req.headers, host: UPSTREAM.host }
  delete headers['accept-encoding'] // 让上游返回明文，便于解析
  headers['content-length'] = Buffer.byteLength(body)

  const up = agent.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      if (!isChat) return upRes.pipe(res)

      const streaming = String(upRes.headers['content-type'] ?? '').includes('event-stream')
      let full = ''
      let buf = ''
      let raw = ''
      const decoder = new StringDecoder('utf8')
      if (upRes.statusCode === 200) broadcast({ type: 'start', turn })

      upRes.on('data', (chunk) => {
        res.write(chunk)
        if (upRes.statusCode !== 200) return
        if (!streaming) {
          raw += chunk
          return
        }
        buf += decoder.write(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const piece = textOf(JSON.parse(data).choices?.[0]?.delta?.content)
            if (piece) {
              full += piece
              broadcast({ type: 'delta', turn, text: piece })
            }
          } catch {}
        }
      })
      upRes.on('end', () => {
        res.end()
        if (upRes.statusCode !== 200) {
          broadcast({ type: 'error', turn, text: `CL 返回 ${upRes.statusCode}` })
          return
        }
        if (!streaming) {
          try {
            full = textOf(JSON.parse(raw).choices?.[0]?.message?.content)
            if (full) broadcast({ type: 'delta', turn, text: full })
          } catch {}
        }
        broadcast({ type: 'end', turn, text: full })
      })
    },
  )
  up.on('error', (err) => {
    broadcast({ type: 'error', turn, text: `连不上 CL：${err.code ?? err.message}` })
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'relay: upstream unreachable' } }))
  })
  up.end(body)
}

// ---- 测试：不连 CL 也能看浮窗效果 ----
function demo(res) {
  const turn = ++turnSeq
  broadcast({ type: 'user', turn, text: '这单赚了八百，我是不是天才', demo: true })
  broadcast({ type: 'start', turn })
  const reply = '赚八百就天才了？你上一单亏了一千二，账我都记着呢。'
  const parts = reply.match(/.{1,3}/gu) ?? [reply]
  parts.forEach((p, i) => setTimeout(() => broadcast({ type: 'delta', turn, text: p }), 120 * (i + 1)))
  setTimeout(() => broadcast({ type: 'end', turn, text: reply }), 120 * (parts.length + 1))
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('已发送一条测试消息，看浮窗。\n')
}

// Only loopback Host names: a DNS-rebinding page would otherwise reach the API, events and history
// with a Host and Origin that match each other.
function isLoopbackHost(host) {
  const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return ['127.0.0.1', 'localhost', '::1'].includes(name)
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0]
  if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: '只接受本机访问。' })
  if (await servePresentation(req, res)) return
  if (path.startsWith('/api/')) {
    try { return await handleLocalApi(req, res, path) } catch {
        if (!res.headersSent) sendJson(res, 500, { error: '本地服务暂时不可用，请重试。' })
        else res.end()
        return
    }
  }
  if (req.method === 'GET' && (path === '/' || path === '/overlay')) {
    const html = await readFile(join(here, 'overlay.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(html)
  }
  if (req.method === 'GET' && path === '/events') return openEvents(req, res)
  if (req.method === 'GET' && path === '/demo') return demo(res)
  if (req.method === 'GET' && path === '/voice-input.mjs') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(await readFile(join(here, 'voice-input.mjs')))
  }
  if (req.method === 'GET' && path === '/assets/jingjing-avatar.png') {
    const avatar = await readFile(join(here, 'assets', 'jingjing-avatar.png'))
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' })
    return res.end(avatar)
  }
  if (req.method === 'GET' && (path === '/sfx/chime_proactive.wav' || path === '/sfx/chime_reply.wav')) {
    // Chime paths come from proactive.config.json, relative to its folder.
    const file = path === '/sfx/chime_proactive.wav' ? proactiveConfig.audio.chimeProactive : proactiveConfig.audio.chimeReply
    const audio = await readFile(resolve(dirname(PROACTIVE_CONFIG_PATH), file)).catch(() => null)
    if (!audio) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-cache' })
    return res.end(audio)
  }
  if (req.method === 'GET' && path === '/history') {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('q') ?? ''
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ conversations: conversationStore.list(query) }))
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => proxy(req, res, Buffer.concat(chunks)))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`鲸鲸浮窗中转已启动`)
  console.log(`  语音前端的 LLM 地址填：http://127.0.0.1:${PORT}/v1   （token 不变）`)
  console.log(`  浮窗页面：           http://127.0.0.1:${PORT}/overlay`)
  console.log(`  测试一条消息：       http://127.0.0.1:${PORT}/demo`)
  console.log(`  转发到 CL：          ${UPSTREAM.origin}`)
})

const gameTimer = setInterval(() => { void gameBridge.poll().catch(() => {}) }, 2000)
gameTimer.unref()
if (WORLD_TOKEN) void gameBridge.poll().catch(() => {})
proactiveRunner?.start()
