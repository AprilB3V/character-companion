import { OVERLAY_STATES, normalizeEmotion } from './presentation-contract.mjs';

export const DEFAULT_CONFIG = Object.freeze({
    width: 1920, height: 1080,
    portraitX: 560, portraitY: 140, portraitWidth: 800, portraitHeight: 800,
    dialogX: 260, dialogY: 830, dialogWidth: 1400, fontSize: 44,
    showInnerOS: false, sound: false, volume: 0.025, typeMs: 30,
    name: '鲸鲸', assetMode: 'flat', assetBase: '/assets/jingjing', reducedMotion: false, ambient: false,
});
const NUMERIC_LIMITS = {
    width: [160, 7680], height: [160, 7680], portraitX: [-7680, 7680], portraitY: [-7680, 7680],
    portraitWidth: [40, 7680], portraitHeight: [40, 7680], dialogX: [-7680, 7680], dialogY: [-7680, 7680],
    dialogWidth: [120, 7680], fontSize: [16, 200], volume: [0, 1], typeMs: [15, 300],
};
// Caption pacing: ~9 chars/s plus a short lead, clamped so no page lingers.
// A reply is cut to what one dialog page holds (laid out with the real line breaks; a box narrower than
// minCap characters may page through that many; never above hardCap): at the last sentence end that fits,
// or hard with an ellipsis when no sentence end fits. History keeps the full text.
export const CAPTION = Object.freeze({ charsPerSecond: 9, leadMs: 600, minMs: 1500, maxMs: 6000, lastPageBonusMs: 1000, hurryMs: 1000, minCap: 24, hardCap: 90 });
/** Lines in the dialog box; the painter, the paging and the layout all use it. */
export const DIALOG_LINES = 3;
const SENTENCE_ENDS = '。！？!?…～~';
// Closing marks that belong to the sentence before them.
const CLOSERS = `”’」』）)》】"'`;
const isEndMark = char => SENTENCE_ENDS.includes(char) || CLOSERS.includes(char);
/** Height of the dialog box for a font size (same formula as the painter). */
export function dialogHeight(fontSize) {
    return fontSize * 1.45 * DIALOG_LINES + 40 * Math.min(1, fontSize / 44);
}
export function captionHoldMs(page, { last = false, hurry = false } = {}) {
    const chars = [...page].length;
    const hold = Math.min(CAPTION.maxMs, Math.max(CAPTION.minMs, chars / CAPTION.charsPerSecond * 1000 + CAPTION.leadMs)) + (last ? CAPTION.lastPageBonusMs : 0);
    return hurry ? Math.min(hold, CAPTION.hurryMs) : hold;
}
const startsNextTurn = event => ['user', 'thinking', 'start'].includes(event.type) || (event.type === 'overlay' && ['thinking', 'listening', 'speaking'].includes(event.state));

export function normalizeConfig(input = {}) {
    const config = { ...DEFAULT_CONFIG };
    for (const [key, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
        const value = Number(input[key]);
        if (input[key] !== undefined && Number.isFinite(value)) config[key] = Math.min(max, Math.max(min, value));
    }
    for (const key of ['showInnerOS', 'sound', 'reducedMotion', 'ambient']) if (typeof input[key] === 'boolean') config[key] = input[key];
    for (const key of ['name', 'assetBase']) if (typeof input[key] === 'string' && input[key].trim()) config[key] = input[key].trim();
    if (input.assetMode === 'layered') config.assetMode = 'layered';
    if (config.height >= 1080) config.fontSize = Math.max(40, config.fontSize);
    if (input.portraitX === undefined) config.portraitX = (config.width - config.portraitWidth) / 2;
    if (input.portraitY === undefined) config.portraitY = (config.height - config.portraitHeight) / 2;
    return config;
}

export function parseReplay(text) {
    let firstWall = null;
    let previousMono = -1;
    let previousTime = 0;
    let offset = 0;
    let origin = null;
    return text.replace(/^\uFEFF/, '').split('\n').flatMap((line, index) => {
        if (!line.trim()) return [];
        let event;
        try { event = JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}`); }
        if (!event || typeof event !== 'object') throw new Error(`Invalid event at line ${index + 1}`);
        const wall = Date.parse(event.wall);
        if (!Number.isFinite(event.mono) || event.mono < 0) throw new Error(`Invalid timestamp at line ${index + 1}`);
        if (firstWall === null && Number.isFinite(wall)) firstWall = wall - event.mono;
        const wallDrift = Number.isFinite(wall) && firstWall !== null ? wall - firstWall - event.mono - offset : 0;
        if (event.mono < previousMono || Math.abs(wallDrift) > 250) {
            if (!Number.isFinite(wall) || firstWall === null) throw new Error(`Session timestamp reset without wall at line ${index + 1}`);
            offset = Math.max(previousTime, wall - firstWall) - event.mono;
        }
        const absoluteTime = event.mono + offset;
        origin ??= absoluteTime;
        previousMono = event.mono;
        previousTime = absoluteTime;
        return [{ ...event, time: absoluteTime - origin }];
    });
}

/** Length of the next whole sentence at the head of the queue (with its end marks), or null if none has arrived. */
function nextSentenceLength(queue) {
    let index = 0;
    while (index < queue.length && isEndMark(queue[index])) index++;
    for (; index < queue.length; index++) {
        if (!SENTENCE_ENDS.includes(queue[index])) continue;
        while (index + 1 < queue.length && isEndMark(queue[index + 1])) index++;
        return index + 1;
    }
    return null;
}

export class Presentation {
    constructor(config = {}, measureText) {
        this.config = normalizeConfig(config);
        this.measureText = measureText ?? (text => [...text].length * this.config.fontSize);
        this.state = 'idle';
        this.emotion = 'neutral';
        this.innerOS = '';
        this.turn = null;
        this.queue = [];
        this.page = '';
        this.received = '';
        this.done = false;
        this.nextAt = Infinity;
        this.pageStartedAt = 0;
        this.lastCharAt = -Infinity;
        this.charSerial = 0;
        this.now = 0;
        this.frozen = false;
        this.scheduled = [];
        this.eventDelay = 0;
        this.stoppedTurns = new Set();
        this.shownText = '';
        this.approved = 0;
        this.truncated = false;
        this.inEnd = false;
        this.hurry = false;
    }

    configure(config) { this.config = normalizeConfig({ ...this.config, ...config }); }

    completionTime(now) {
        const preview = Object.assign(Object.create(Presentation.prototype), this, { queue: [...this.queue], scheduled: this.scheduled.map(item => ({ ...item })), stoppedTurns: new Set(this.stoppedTurns) });
        const lastEventAt = preview.scheduled.at(-1)?.at ?? now;
        preview.advance(1e12);
        return Math.max(now, lastEventAt, preview.lastEventAt ?? now, preview.finishedAt ?? now);
    }

    lines(text) {
        const lines = [''];
        const availableWidth = this.config.dialogWidth - 64;
        for (const char of text) {
            const last = lines.length - 1;
            if (char === '\n') lines.push('');
            else if (lines[last] && this.measureText(lines[last] + char) > availableWidth) lines.push(char);
            else lines[last] += char;
        }
        return lines;
    }

    clear() {
        this.queue = [];
        this.page = '';
        this.received = '';
        this.nextAt = Infinity;
        this.done = false;
        this.frozen = false;
        this.lastCharAt = -Infinity;
        this.shownText = '';
        this.approved = 0;
        this.truncated = false;
        this.inEnd = false;
        this.hurry = false;
    }

    advance(now) {
        this.now = now;
        // Progress follows the presentation clock, never wall-clock timers.
        while (true) {
            const scheduled = this.scheduled[0];
            if (scheduled && scheduled.at <= now && (this.state !== 'speaking' || scheduled.at <= this.nextAt)) {
                if (this.state === 'speaking' && this.done && startsNextTurn(scheduled.event)) {
                    this.hurryUp(scheduled.at);
                    const preview = Object.assign(Object.create(Presentation.prototype), this, { queue: [...this.queue], scheduled: [] });
                    preview.advance(1e12);
                    const shift = preview.finishedAt - scheduled.at;
                    if (shift > 0) {
                        for (const item of this.scheduled) item.at += shift;
                        this.eventDelay += shift;
                        continue;
                    }
                }
                this.scheduled.shift();
                this.applyEvent(scheduled.event, scheduled.at);
                continue;
            }
            if (this.state !== 'speaking' || this.nextAt > now) break;
            const at = this.nextAt;
            // The reply limit is judged before each character shows, with whatever has arrived by then.
            if (this.queue.length && !this.truncated && this.admit() === 'wait') { this.nextAt = Infinity; continue; }
            const char = this.queue[0];
            const expiredAt = this.pageStartedAt + captionHoldMs(this.page, { last: char === undefined && this.done, hurry: this.hurry });
            if (char !== undefined && this.lines(this.page + char).length > DIALOG_LINES) {
                if (at < expiredAt) { this.nextAt = expiredAt; continue; }
                this.page = '';
                this.pageStartedAt = at;
            }
            if (char !== undefined) {
                this.queue.shift();
                if (!this.page) this.pageStartedAt = at;
                this.page += char;
                this.lastCharAt = at;
                this.charSerial++;
                this.nextAt = at + this.config.typeMs;
                this.noteShown(char);
            } else if (!this.done) {
                this.nextAt = Infinity;
            } else if (this.page && at < expiredAt) {
                this.nextAt = expiredAt;
            } else {
                this.state = 'idle';
                this.finishedAt = at;
                this.clear();
            }
        }
    }

    hurryUp(now) {
        this.hurry = true;
        // The current page's wake-up was scheduled with the full hold; pull it in.
        if (Number.isFinite(this.nextAt) && this.page) this.nextAt = Math.max(now, Math.min(this.nextAt, this.pageStartedAt + CAPTION.hurryMs));
    }

    /** Whether the whole reply shown so far plus `text` stays on one dialog page (more lines on very narrow boxes). */
    fitsReply(text) {
        return [...text].length <= CAPTION.hardCap && this.lines(text).length <= this.maxLines();
    }

    /** One page, except a box too narrow for minCap characters, which may page through the minimum. */
    maxLines() {
        const perLine = Math.max(1, Math.floor((this.config.dialogWidth - 64) / Math.max(1, this.measureText('鲸'))));
        return Math.max(DIALOG_LINES, Math.ceil(CAPTION.minCap / perLine));
    }

    /**
     * Decide about the character at the head of the queue: 'show' it (possibly after replacing the rest with an
     * ellipsis), 'stop' (the rest is dropped), or 'wait' for more of the stream before deciding.
     */
    admit() {
        const char = this.queue[0];
        if (this.approved > 0) return 'show';
        if (this.inEnd && !isEndMark(char)) {
            // A sentence just ended: the next one is shown whole or not at all.
            const next = nextSentenceLength(this.queue);
            const length = next ?? (this.done ? this.queue.length : null);
            if (length !== null) {
                if (this.fitsReply(this.shownText + this.queue.slice(0, length).join(''))) {
                    this.approved = length;
                    return 'show';
                }
                this.cut([]);
                return 'stop';
            }
            if (!this.fitsReply(this.shownText + this.queue.join(''))) {
                this.cut([]);
                return 'stop';
            }
            return 'wait';
        }
        if (this.done && this.queue.length === 1) {
            // The very last character: shown if it fits, else the ellipsis (which always fits) takes its place.
            if (!this.fitsReply(this.shownText + char)) this.cut([...'…']);
            return 'show';
        }
        // Mid-sentence: keep room for an ellipsis while more may follow.
        if (this.fitsReply(this.shownText + char + '…')) return 'show';
        if (!this.done && this.queue.length === 1) return 'wait';
        this.cut([...'…']);
        return 'show';
    }

    noteShown(char) {
        this.shownText += char;
        if (this.approved > 0) this.approved--;
        if (SENTENCE_ENDS.includes(char)) this.inEnd = true;
        else if (!CLOSERS.includes(char)) this.inEnd = false;
    }

    cut(tail) {
        this.truncated = true;
        this.queue = tail;
    }

    append(text, now, done = false) {
        if (!this.truncated) this.queue.push(...String(text ?? ''));
        this.done ||= done;
        if (!Number.isFinite(this.nextAt)) this.nextAt = now;
    }

    accept(event, now) {
        this.advance(now);
        if (event.turn !== undefined && this.stoppedTurns.has(event.turn)) return;
        const interrupt = ['yield', 'cancel'].includes(event.type) || (event.type === 'overlay' && (event.state === 'yield' || event.text === 'cancelled'));
        if (interrupt) {
            this.scheduled = [];
            this.eventDelay = 0;
            if (event.type === 'yield' || event.state === 'yield') this.yield(event.text);
            else { this.clear(); this.state = 'idle'; }
            if (event.turn !== undefined) this.stoppedTurns.add(event.turn);
            return;
        }
        if (!this.scheduled.length && this.state !== 'speaking') this.eventDelay = 0;
        const boundary = startsNextTurn(event);
        if (boundary && this.state === 'speaking' && this.done && !this.scheduled.length) {
            // A next turn still shows every remaining character, but each page holds at most hurryMs.
            this.hurryUp(now);
            const preview = Object.assign(Object.create(Presentation.prototype), this, { queue: [...this.queue], scheduled: [] });
            preview.advance(1e12);
            this.eventDelay = Math.max(this.eventDelay, preview.finishedAt - now);
        }
        if (this.eventDelay > 0 || this.scheduled.length) {
            this.scheduled.push({ event, at: now + this.eventDelay });
            this.advance(now);
        } else this.applyEvent(event, now);
    }

    applyEvent(event, now) {
        if (event.turn !== undefined && this.stoppedTurns.has(event.turn)) return;
        this.lastEventAt = now;
        if (event.type === 'thought') {
            this.innerOS = event.result?.innerOS ?? '';
            this.emotion = normalizeEmotion(event.result?.emotion);
            return;
        }
        if (event.type === 'overlay') {
            if (!OVERLAY_STATES.includes(event.state)) return;
            if (event.state === 'speaking') {
                this.clear();
                this.state = 'speaking';
                if (event.emotion) this.emotion = normalizeEmotion(event.emotion);
                this.append(event.text, now, true);
            } else if (event.state === 'yield') this.yield(event.text);
            else if (event.state === 'idle' && this.state === 'speaking' && event.text !== 'cancelled' && event.decision !== 'silent') {
                this.done = true;
                if (!Number.isFinite(this.nextAt)) this.nextAt = now;
            } else {
                this.clear();
                this.state = event.state;
                if (event.state === 'thinking' || event.state === 'listening') this.innerOS = '';
            }
            return;
        }
        if (event.type === 'asr') {
            if (this.state === 'idle') this.state = 'listening';
            return;
        }
        if (['user', 'thinking', 'start'].includes(event.type)) {
            if (event.turn !== this.turn || event.type === 'thinking') {
                this.clear();
                this.innerOS = '';
                this.turn = event.turn;
            }
            if (event.emotion) this.emotion = normalizeEmotion(event.emotion);
            if (event.thought) this.innerOS = event.thought.innerOS ?? '';
            this.state = event.type === 'start' ? 'speaking' : 'thinking';
            return;
        }
        if (event.turn !== undefined && this.turn !== null && event.turn !== this.turn) return;
        if (event.type === 'yield') { this.yield(event.text); return; }
        if (event.type === 'cancel' || event.type === 'silent') {
            if (event.turn !== undefined) this.stoppedTurns.add(event.turn);
            this.clear();
            this.state = 'idle';
            return;
        }
        if (this.frozen) return;
        if (event.type === 'delta' || event.type === 'end' || event.type === 'error') {
            if (event.type === 'error') this.clear();
            if (event.emotion) this.emotion = normalizeEmotion(event.emotion);
            this.state = 'speaking';
            if (event.type === 'delta') {
                this.received += event.text ?? '';
                this.append(event.text, now);
            } else {
                const full = event.text ?? '';
                const remainder = full.startsWith(this.received) ? full.slice(this.received.length) : this.received ? '' : full;
                this.append(remainder, now, true);
            }
        }
    }

    yield(text) {
        if (this.turn !== null) this.stoppedTurns.add(this.turn);
        this.queue = [];
        this.state = 'yield';
        this.frozen = true;
        this.nextAt = Infinity;
        this.yieldText = text ?? '';
    }

    snapshot(now) {
        this.advance(now);
        const emotion = this.state === 'listening' ? 'curious' : this.state === 'thinking' ? 'thinking' : this.state === 'yield' ? 'panic' : this.emotion;
        return {
            state: this.state, emotion, text: this.page, lines: this.lines(this.page),
            mouth: this.state === 'speaking' && now - this.lastCharAt < this.config.typeMs * 0.6 ? 'open' : 'closed',
            floatY: this.state === 'speaking' && !this.config.reducedMotion ? Math.sin(now / 220) * 4 : 0,
            indicator: this.state === 'thinking' ? '……' : this.state === 'listening' ? '在听' : '',
            innerOS: this.config.showInnerOS ? this.innerOS : '',
            yieldText: this.state === 'yield' ? this.yieldText : '', charSerial: this.charSerial,
            time: now,
        };
    }
}
