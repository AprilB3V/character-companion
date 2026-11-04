import { OVERLAY_STATES, normalizeEmotion } from './presentation-contract.mjs';

export const DEFAULT_CONFIG = Object.freeze({
    width: 1920, height: 1080,
    portraitX: 560, portraitY: 140, portraitWidth: 800, portraitHeight: 800,
    dialogX: 260, dialogY: 870, dialogWidth: 1400, fontSize: 44,
    showInnerOS: false, sound: false, volume: 0.025, typeMs: 45,
    name: '鲸鲸', assetMode: 'flat', assetBase: '/assets/jingjing', reducedMotion: false, ambient: false,
});
const NUMERIC_LIMITS = {
    width: [160, 7680], height: [160, 7680], portraitX: [-7680, 7680], portraitY: [-7680, 7680],
    portraitWidth: [40, 7680], portraitHeight: [40, 7680], dialogX: [-7680, 7680], dialogY: [-7680, 7680],
    dialogWidth: [120, 7680], fontSize: [16, 200], volume: [0, 1], typeMs: [15, 300],
};
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
    }

    advance(now) {
        this.now = now;
        // Progress follows the presentation clock, never wall-clock timers.
        while (true) {
            const scheduled = this.scheduled[0];
            if (scheduled && scheduled.at <= now && (this.state !== 'speaking' || scheduled.at <= this.nextAt)) {
                if (this.state === 'speaking' && this.done && startsNextTurn(scheduled.event)) {
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
            const char = this.queue[0];
            const expiredAt = this.pageStartedAt + ([...this.page].length / 5 + 1) * 1000;
            if (char !== undefined && this.lines(this.page + char).length > 2) {
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

    append(text, now, done = false) {
        this.queue.push(...String(text ?? ''));
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
            // Normal next turns wait for all pages; only yield/cancel can cut a caption.
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
