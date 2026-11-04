import { EMOTIONS } from './presentation-contract.mjs';

const PALETTE = { smug: '#557e98', disgust: '#6d856d', panic: '#b47d77', stubborn: '#9c779d', serious: '#647a92', curious: '#679c9e', thinking: '#7d84ad', neutral: '#648ca4' };
const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const BLINK_PERIOD_MS = 4200;
const BLINK_MS = 140;
const CROSSFADE_MS = 160;
const HOP_MS = 380;
const SHAKE_MS = 420;
const BUBBLES = 9;

// Deterministic pseudo-random in [0, 1): offline exports render the same frame for the same time.
const hash = value => {
    const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
};
const easeOut = value => 1 - (1 - value) ** 3;

export class PortraitPainter {
    constructor(canvas, config) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.config = config;
        this.images = new Map();
        this.bounds = new Map();
        // Motion state carried between frames (eased pose, state-change reactions, expression crossfade).
        this.pose = { tilt: 0, lean: 0, lift: 0 };
        this.lastTime = null;
        this.lastState = 'idle';
        this.stateChangedAt = -Infinity;
        this.faceKey = null;
        this.previousFace = null;
        this.faceChangedAt = -Infinity;
    }

    resetMotion() {
        this.pose = { tilt: 0, lean: 0, lift: 0 };
        this.lastTime = null;
        this.lastState = 'idle';
        this.stateChangedAt = -Infinity;
        this.faceKey = null;
        this.previousFace = null;
        this.faceChangedAt = -Infinity;
    }

    async loadAssets() {
        const paths = ['body.png', ...EMOTIONS.flatMap(emotion => ['open', 'closed', 'blink'].map(frame => `${emotion}_${frame}.png`))];
        await Promise.all(paths.map(async path => {
            const image = new Image();
            image.src = `${this.config.assetBase}/${path}`;
            try {
                await image.decode();
                this.images.set(path, image);
            } catch { /* Missing emotion art falls back to the neutral sprite, then a placeholder. */ }
        }));
        // Scanning alpha is a per-pixel loop; expression edits of the neutral canvas reuse neutral's anchor below,
        // so only neutral, body and differently sized art are scanned.
        const neutralImage = this.images.get('neutral_closed.png');
        const sameCanvas = image => neutralImage && image.naturalWidth === neutralImage.naturalWidth && image.naturalHeight === neutralImage.naturalHeight;
        for (const [name, image] of this.images) {
            if (name.startsWith('neutral_') && name !== 'neutral_blink.png' || name === 'body.png' || !sameCanvas(image)) this.bounds.set(name, this.visibleBounds(image));
        }
        for (const emotion of EMOTIONS) {
            // All frames of one emotion share a single anchor so swapping frames never moves the body.
            const names = ['closed', 'open', 'blink'].map(frame => `${emotion}_${frame}.png`).filter(name => this.images.has(name));
            const closed = this.images.get(`${emotion}_closed.png`);
            const frames = names.filter(name => closed && this.bounds.has(name) && this.images.get(name).naturalWidth === closed.naturalWidth && this.images.get(name).naturalHeight === closed.naturalHeight);
            if (frames.length < 2) continue;
            const all = frames.map(name => this.bounds.get(name));
            const left = Math.min(...all.map(item => item.left));
            const top = Math.min(...all.map(item => item.top));
            const bounds = { left, top, width: Math.max(...all.map(item => item.left + item.width)) - left, height: Math.max(...all.map(item => item.top + item.height)) - top };
            for (const name of frames) this.bounds.set(name, bounds);
        }
        // Emotion variants are edits of the neutral sprite; anchoring them all to neutral keeps the body still across expressions.
        const neutral = this.bounds.get('neutral_closed.png');
        if (neutral) for (const [name, image] of this.images) {
            if (name !== 'body.png' && sameCanvas(image)) this.bounds.set(name, neutral);
        }
    }

    visibleBounds(image) {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] <= 16) continue;
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
        return right < 0 ? { left:0, top:0, width:canvas.width, height:canvas.height } : { left, top, width:right - left + 1, height:bottom - top + 1 };
    }

    measureText(text) {
        this.context.font = `${this.config.fontSize}px ${FONT}`;
        return this.context.measureText(text).width;
    }

    box(x, y, width, height, fill, radius = 18, stroke = null) {
        const context = this.context;
        context.beginPath();
        context.roundRect(x, y, width, height, radius);
        context.fillStyle = fill;
        context.fill();
        if (stroke) { context.strokeStyle = stroke; context.lineWidth = 2; context.stroke(); }
    }

    text(text, x, y, size, color = '#f3f5f6', style = '') {
        const context = this.context;
        context.font = `${style} ${size}px ${FONT}`;
        context.textBaseline = 'top';
        context.fillStyle = color;
        context.fillText(text, x, y);
    }

    // Which sprite to show: the requested emotion and mouth, with a blink frame on a deterministic schedule.
    pickSprite(view, time) {
        const { emotion, mouth } = view;
        const fallback = name => this.images.has(name) ? name : null;
        const base = fallback(`${emotion}_${mouth}.png`) ?? fallback(`neutral_${mouth}.png`) ?? 'neutral_closed.png';
        const baseEmotion = base.split('_')[0];
        if (this.config.reducedMotion || view.state === 'yield' || mouth === 'open') return base;
        const cycle = Math.floor(time / BLINK_PERIOD_MS);
        const offset = hash(cycle) * (BLINK_PERIOD_MS - BLINK_MS * 3);
        const phase = time - cycle * BLINK_PERIOD_MS - offset;
        // Roughly one blink in four is a quick double blink.
        const blinking = (phase >= 0 && phase < BLINK_MS) || (hash(cycle + 0.5) < 0.25 && phase >= BLINK_MS * 1.8 && phase < BLINK_MS * 2.8);
        return blinking ? fallback(`${baseEmotion}_blink.png`) ?? base : base;
    }

    // Eased pose plus short reactions when the state changes: hop into speech, shake on yield.
    motion(view, time, unit) {
        // Rendering back in time (seek, restart) starts the motion history over instead of reusing future frames.
        if (this.lastTime !== null && time < this.lastTime) this.resetMotion();
        const elapsed = this.lastTime === null ? 16 : Math.min(100, Math.max(0, time - this.lastTime));
        this.lastTime = time;
        if (view.state !== this.lastState) { this.lastState = view.state; this.stateChangedAt = time; }
        if (this.config.reducedMotion) return { dx: 0, dy: view.floatY, tilt: 0, scaleX: 1, scaleY: 1, hop: 0 };
        const target = {
            tilt: view.state === 'thinking' ? -3.2 : view.state === 'listening' ? 2.2 : 0,
            lean: view.state === 'listening' ? 0.025 : 0,
            lift: view.state === 'thinking' ? -0.012 : 0,
        };
        const smoothing = 1 - Math.exp(-elapsed / 180);
        for (const key of Object.keys(target)) this.pose[key] += (target[key] - this.pose[key]) * smoothing;
        const since = time - this.stateChangedAt;
        const breathe = Math.sin(time * Math.PI * 2 / 3400);
        let tilt = this.pose.tilt + Math.sin(time / 2700) * 0.6;
        let dy = view.floatY + this.pose.lift * unit;
        let dx = 0;
        let hop = 0;
        if (view.state === 'speaking') tilt += Math.sin(time / 380) * 1.4;
        if (view.state === 'thinking') tilt += Math.sin(time / 900) * 1.2;
        if (view.state === 'speaking' && since < HOP_MS) { hop = Math.sin(Math.PI * since / HOP_MS); dy -= hop * unit * 0.045; }
        if (view.state === 'yield' && since < SHAKE_MS) dx = Math.sin(since / 22) * unit * 0.014 * (1 - since / SHAKE_MS);
        const lean = 1 + this.pose.lean;
        return { dx, dy, tilt, scaleX: lean * (1 - breathe * 0.005), scaleY: lean * (1 + breathe * 0.011), hop };
    }

    // Small air bubbles drifting up behind her: whale-themed ambient life, denser while she talks.
    bubbles(x, y, width, height, time, unit, speaking) {
        const context = this.context;
        const count = speaking ? BUBBLES : Math.ceil(BUBBLES * 0.6);
        context.save();
        for (let index = 0; index < count; index++) {
            const period = 5200 + hash(index + 1) * 4200;
            const progress = ((time + hash(index + 7) * period) % period) / period;
            const radius = unit * (0.008 + hash(index + 3) * 0.014);
            const bx = x + width * (0.12 + 0.76 * hash(index + 11)) + Math.sin(time / 650 + index * 1.7) * unit * 0.012;
            const by = y + height * (0.95 - progress * 0.9);
            const alpha = Math.sin(Math.PI * progress) * 0.55;
            context.globalAlpha = alpha;
            context.beginPath();
            context.arc(bx, by, radius, 0, Math.PI * 2);
            context.fillStyle = 'rgba(150,210,255,.18)';
            context.fill();
            context.lineWidth = Math.max(1, radius * 0.18);
            context.strokeStyle = 'rgba(190,230,255,.85)';
            context.stroke();
            context.beginPath();
            context.arc(bx - radius * 0.35, by - radius * 0.35, radius * 0.28, 0, Math.PI * 2);
            context.fillStyle = 'rgba(255,255,255,.9)';
            context.fill();
        }
        context.restore();
    }

    drawSprite(image, bounds, rect, alpha = 1) {
        const context = this.context;
        context.globalAlpha = alpha;
        context.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height, rect.x, rect.y, rect.width, rect.height);
        context.globalAlpha = 1;
    }

    paint(view) {
        const config = this.config;
        const context = this.context;
        const time = view.time ?? performance.now();
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        context.save();
        context.scale(this.canvas.width / config.width, this.canvas.height / config.height);
        const x = config.portraitX;
        const y = config.portraitY;
        const width = config.portraitWidth;
        const height = config.portraitHeight;
        const unit = Math.min(width, height);
        const uiScale = Math.min(1, config.fontSize / 44);
        const motion = this.motion(view, time, unit);
        if (config.ambient && !config.reducedMotion) this.bubbles(x, y, width, height, time, unit, view.state === 'speaking');
        const spriteName = this.pickSprite(view, time);
        const face = this.images.get(spriteName);
        const body = config.assetMode === 'layered' ? this.images.get('body.png') : null;
        let spriteRect = { x, y, width, height };
        if (face && (config.assetMode !== 'layered' || body)) {
            const bounds = body ? { left:0, top:0, width:body.naturalWidth, height:body.naturalHeight } : this.bounds.get(spriteName);
            const scale = Math.min(width / bounds.width, height / bounds.height);
            const rect = { width: bounds.width * scale, height: bounds.height * scale };
            rect.x = x + (width - rect.width) / 2;
            rect.y = y + (height - rect.height) / 2;
            spriteRect = rect;
            // Expression changes crossfade; mouth flaps and blinks within one emotion swap instantly.
            const faceKey = spriteName.split('_')[0];
            if (this.faceKey !== null && faceKey !== this.faceKey) { this.previousFace = this.lastSpriteName; this.faceChangedAt = time; }
            this.faceKey = faceKey;
            this.lastSpriteName = spriteName;
            const footX = rect.x + rect.width / 2;
            const footY = rect.y + rect.height;
            // Ground shadow (desktop ambient only; exports stay a clean cut-out). It shrinks while she hops.
            if (config.ambient) {
                context.beginPath();
                context.ellipse(footX + motion.dx, footY - rect.height * 0.015, rect.width * 0.3 * (1 - motion.hop * 0.25), rect.height * 0.028 * (1 - motion.hop * 0.3), 0, 0, Math.PI * 2);
                context.fillStyle = `rgba(4,14,34,${0.26 * (1 - motion.hop * 0.4)})`;
                context.fill();
            }
            context.save();
            // Breathing scales from the feet; tilt pivots at the hips so the head sways most.
            context.translate(footX + motion.dx, footY + motion.dy);
            context.scale(motion.scaleX, motion.scaleY);
            const hipY = -rect.height * 0.32;
            context.translate(0, hipY);
            context.rotate(motion.tilt * Math.PI / 180);
            context.translate(-footX, -footY - hipY);
            if (body) this.drawSprite(body, bounds, rect);
            const fade = Math.min(1, (time - this.faceChangedAt) / CROSSFADE_MS);
            const previous = fade < 1 && this.previousFace ? this.images.get(this.previousFace) : null;
            if (previous && !config.reducedMotion) {
                this.drawSprite(previous, this.bounds.get(this.previousFace) ?? bounds, rect);
                this.drawSprite(face, bounds, rect, easeOut(fade));
            } else this.drawSprite(face, bounds, rect);
            context.restore();
            this.canvas.dataset.sprite = spriteName;
        } else {
            this.box(x, y, width, height, PALETTE[view.emotion], 30, '#c0dbe5');
            context.save();
            context.beginPath(); context.rect(x, y, width, height); context.clip();
            this.text('鲸鲸 / 立绘待补', x + 24, y + 28, Math.min(30, width / 10));
            this.text(view.emotion, x + 24, y + 78, Math.min(44, width / 8), '#fff', 'bold');
            this.text(view.mouth, x + 24, y + 140, Math.min(28, width / 10));
            this.text(view.state, x + 24, y + height - 54, Math.min(28, width / 10));
            this.box(x + width * 0.32, y + height * 0.48, width * 0.36, view.mouth === 'open' ? 30 : 5, '#eef6f7', 5);
            context.restore();
        }
        if (view.indicator) this.thoughtBubble(view, spriteRect, time, uiScale, unit);
        if (view.text || view.yieldText) {
            const lineHeight = config.fontSize * 1.45;
            const dialogHeight = lineHeight * 2 + 40 * uiScale;
            const gradient = context.createLinearGradient(0, config.dialogY, 0, config.dialogY + dialogHeight);
            gradient.addColorStop(0, 'rgba(22,44,82,.92)');
            gradient.addColorStop(1, 'rgba(10,22,44,.92)');
            this.box(config.dialogX, config.dialogY, config.dialogWidth, dialogHeight, gradient, 20 * Math.max(uiScale, 0.6), 'rgba(150,200,255,.75)');
            const tagWidth = Math.max(this.measureName(config.name, 30 * uiScale) + 36 * uiScale, 100 * uiScale);
            this.box(config.dialogX + 22 * uiScale, config.dialogY - 40 * uiScale, tagWidth, 46 * uiScale, '#2f6aa8', 23 * uiScale, 'rgba(190,225,255,.9)');
            this.text(config.name, config.dialogX + 40 * uiScale, config.dialogY - 34 * uiScale, 30 * uiScale, '#ffffff', 'bold');
            view.lines.slice(0, 2).forEach((line, index) => this.text(line, config.dialogX + 32 * Math.max(uiScale, 0.6), config.dialogY + 20 * uiScale + lineHeight * index, config.fontSize));
            // Small bouncing caret: more text is still coming.
            if (view.state === 'speaking' && !config.reducedMotion) {
                const caretX = config.dialogX + config.dialogWidth - 26 * Math.max(uiScale, 0.6);
                const caretY = config.dialogY + dialogHeight - 22 * Math.max(uiScale, 0.6) + Math.sin(time / 180) * 3 * uiScale;
                context.beginPath();
                context.moveTo(caretX - 7 * uiScale, caretY); context.lineTo(caretX + 7 * uiScale, caretY); context.lineTo(caretX, caretY + 8 * uiScale);
                context.closePath(); context.fillStyle = 'rgba(160,210,255,.85)'; context.fill();
            }
            if (view.yieldText) {
                this.box(config.dialogX + 16, config.dialogY - 104, Math.max(300, this.measureText(view.yieldText) + 40), 52, 'rgba(52,37,44,.95)', 14);
                this.text(view.yieldText, config.dialogX + 32, config.dialogY - 102, 30, '#eed6da');
            }
        }
        if (view.innerOS) {
            const lines = this.wrapInner(view.innerOS, Math.min(config.dialogWidth - 64, 800));
            const bubbleY = Math.max(12, config.dialogY - 120 - lines.length * 42);
            this.box(config.dialogX, bubbleY, Math.min(config.dialogWidth, 864), lines.length * 42 + 28, 'rgba(38,42,50,.9)', 28, '#9199a5');
            lines.forEach((line, index) => this.text(line, config.dialogX + 24, bubbleY + 14 + index * 42, 30, '#c7cbd1', 'italic'));
        }
        context.restore();
    }

    measureName(text, size) {
        this.context.font = `bold ${size}px ${FONT}`;
        return this.context.measureText(text).width;
    }

    // Thinking / listening bubble beside her head, with animated dots instead of a static label.
    thoughtBubble(view, rect, time, uiScale, unit) {
        const context = this.context;
        const size = Math.max(0.45, uiScale) * Math.max(1, unit / 400);
        const bubbleWidth = 96 * size;
        const bubbleHeight = 52 * size;
        const bubbleX = Math.min(this.config.width - bubbleWidth - 4, rect.x + rect.width * 0.68);
        const bubbleY = Math.max(4, rect.y + rect.height * 0.04) + (this.config.reducedMotion ? 0 : Math.sin(time / 500) * 3 * size);
        context.save();
        context.fillStyle = 'rgba(240,248,255,.95)';
        context.strokeStyle = 'rgba(90,150,220,.9)';
        context.lineWidth = 2;
        // Tail of two small circles trailing toward her head.
        for (const [offsetX, offsetY, radius] of [[12, 8, 6], [2, 20, 4]]) {
            context.beginPath(); context.arc(bubbleX + offsetX * size, bubbleY + bubbleHeight + offsetY * size, radius * size, 0, Math.PI * 2); context.fill(); context.stroke();
        }
        context.beginPath();
        context.roundRect(bubbleX, bubbleY, bubbleWidth, bubbleHeight, bubbleHeight / 2);
        context.fill(); context.stroke();
        if (view.state === 'listening') {
            // Three bars pulsing like a level meter: she is listening.
            for (let index = 0; index < 3; index++) {
                const level = this.config.reducedMotion ? 0.6 : 0.35 + 0.65 * Math.abs(Math.sin(time / 260 + index * 0.9));
                const barHeight = bubbleHeight * 0.55 * level;
                this.box(bubbleX + bubbleWidth * (0.3 + index * 0.2) - 4 * size, bubbleY + (bubbleHeight - barHeight) / 2, 8 * size, barHeight, '#3f8fe0', 4 * size);
            }
        } else {
            const active = this.config.reducedMotion ? 3 : 1 + Math.floor(time / 380) % 3;
            for (let index = 0; index < 3; index++) {
                context.beginPath();
                context.arc(bubbleX + bubbleWidth * (0.3 + index * 0.2), bubbleY + bubbleHeight / 2, 5.5 * size, 0, Math.PI * 2);
                context.fillStyle = index < active ? '#3f8fe0' : 'rgba(63,143,224,.25)';
                context.fill();
            }
        }
        context.restore();
    }

    wrapInner(text, width) {
        const lines = [''];
        this.context.font = `italic 30px ${FONT}`;
        for (const char of text) {
            const index = lines.length - 1;
            if (this.context.measureText(lines[index] + char).width > width) lines.push(char);
            else lines[index] += char;
        }
        return lines.slice(0, 3);
    }
}
