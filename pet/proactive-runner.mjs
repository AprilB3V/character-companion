// Proactive speech in the relay (task B): game event feed -> controller (triggers, gate) -> thinking layer.
// The controller and the feed live in the cohost repository, like the turn gate. The relay supplies
// the live signals (host VAD, whether she is busy) and the think call.
import { join } from 'node:path'
import { ProactiveController } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/proactive/gate.ts'
import { GameEventFeed } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/feed.ts'
import { describeForThinking } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/describe.ts'
import { JsonlSink } from '../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/jsonl-sink.ts'

export const TICK_MS = 1000
/** Recent events shown to the thinker per consideration; older ones are already in CL's context. */
export const MAX_EVENT_LINES = 8
const MIN_EVENT_IMPORTANCE = 0.3
const MAX_LINE_CHARS = 300

const TRIGGER_LINES = {
    silence: '主播已经有一阵子没说话了',
    post_transaction: '刚做完一笔交易',
}

/** Thinking inputs for one consideration: why she is thinking now, then what happened. */
export function proactiveInputs(request) {
    const reasons = [...new Set(request.triggers.map(trigger => TRIGGER_LINES[trigger.kind]).filter(Boolean))]
    const events = request.events
        .filter(event => event.importance >= MIN_EVENT_IMPORTANCE || event.type === 'npc_dialogue')
        .slice(-MAX_EVENT_LINES)
        .map(describeForThinking)
    return [...reasons, ...events].map(text => ({ kind: 'event', text: text.slice(0, MAX_LINE_CHARS) }))
}

export class ProactiveRunner {
    /**
     * @param {object} options
     * @param {import('../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/config.ts').ProactiveSettings} options.settings
     * @param {string} options.eventsDir   recorder directory written by the CL server
     * @param {string} options.logDir      decision log directory
     * @param {(inputs: Array<{kind: 'event', text: string}>, onSpeaking: () => void) => Promise<{should_speak: boolean, utterance: string | null, reason: string}>} options.think
     *   call onSpeaking when her line actually starts, so cooldown counts even if the host interrupts it
     * @param {() => boolean} options.isBusy  she is thinking, speaking, showing a reply, or host speech is waiting in the turn gate
     * @param {() => string | null | undefined} [options.visitor]  live visitor from the reader snapshot; undefined when unknown
     */
    constructor({ settings, eventsDir, logDir, think, isBusy, visitor = () => undefined, now = Date.now, onError = () => {} }) {
        this.now = now
        this.isBusy = isBusy
        this.visitor = visitor
        this.onError = onError
        this.timer = null
        this.ticking = false
        const sink = new JsonlSink(join(logDir, `${new Date(now()).toISOString().slice(0, 10)}.jsonl`))
        this.controller = new ProactiveController({
            settings,
            startedAt: now(),
            now,
            log: entry => { sink.append({ ...entry, wall: new Date(entry.at).toISOString() }).catch(onError) },
            think: async request => {
                const inputs = proactiveInputs(request)
                if (!inputs.length) return { should_speak: false, utterance: null, reason: '没有可说的内容' }
                return await think(inputs, request.onSpeaking)
            },
        })
        this.feed = new GameEventFeed({
            dir: eventsDir,
            // Event `ts` is the CL process clock; the wall time is shared with this process.
            onEvent: event => this.controller.observeGameEvent({ ...event, ts: Date.parse(event.wall_time) || this.now() }),
            onError,
        })
    }

    start() {
        if (this.timer) return
        void this.feed.poll()
        this.timer = setInterval(() => { void this.tick() }, TICK_MS)
        this.timer.unref?.()
    }

    stop() {
        clearInterval(this.timer)
        this.timer = null
    }

    async tick() {
        if (this.ticking) return
        this.ticking = true
        try {
            await this.feed.poll()
            this.controller.setShePending(this.isBusy())
            const visitor = this.visitor()
            if (visitor !== undefined) this.controller.setVisitor(visitor)
            await this.controller.consider(this.now())
        } catch (error) {
            this.onError(error)
        } finally {
            this.ticking = false
        }
    }

    observeHostSpeech(speaking) { this.controller.observeHostSpeech(speaking, this.now()) }

    /** Asked again when the thinker decides to speak: the host may have started talking during the thought. */
    hostAllowsSpeaking() { return this.controller.hostAllowsSpeaking(this.now()) }

    noteHostUtterance(endMs) { this.controller.noteHostUtterance(endMs) }
}
