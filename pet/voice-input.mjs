const SAMPLE_RATE = 16000;
const PAD_MS = 250;
export const DEFAULT_MIC_SETTINGS = Object.freeze({ thresholdDb: -34, attackMs: 200, minSpeechMs: 400, silenceMs: 1000 });
export const DEFAULT_CAPTURE_SETTINGS = Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });

export function normalizeMicSettings(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const bound = (name, min, max) => Math.round(Math.min(max, Math.max(min,
        Number.isFinite(value[name]) ? value[name] : DEFAULT_MIC_SETTINGS[name])));
    return { thresholdDb: bound('thresholdDb', -55, -20), attackMs: bound('attackMs', 100, 600),
        minSpeechMs: bound('minSpeechMs', 300, 1500), silenceMs: bound('silenceMs', 500, 2000) };
}

export function resampleAudio(samples, inputRate, outputRate = SAMPLE_RATE) {
    if (inputRate === outputRate) return new Float32Array(samples);
    const ratio = inputRate / outputRate;
    // Windowed-sinc low-pass at 90% of the output Nyquist, so higher frequencies do not alias.
    const cutoff = 0.9 / ratio;
    const halfWidth = Math.ceil(8 * ratio);
    const output = new Float32Array(Math.floor(samples.length / ratio));
    for (let index = 0; index < output.length; index++) {
        const center = index * ratio;
        const first = Math.max(0, Math.ceil(center - halfWidth));
        const last = Math.min(samples.length - 1, Math.floor(center + halfWidth));
        let sum = 0;
        let weightSum = 0;
        for (let source = first; source <= last; source++) {
            const distance = center - source;
            const argument = Math.PI * cutoff * distance;
            const sinc = distance === 0 ? 1 : Math.sin(argument) / argument;
            const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / halfWidth);
            const weight = cutoff * sinc * window;
            sum += weight * samples[source];
            weightSum += weight;
        }
        // Normalizing by the weight sum keeps DC gain at 1 near the chunk edges.
        output[index] = weightSum ? sum / weightSum : 0;
    }
    return output;
}

export class SpeechSegmenter {
    constructor(settings = {}) { this.configure(settings); }

    configure(settings) { this.settings = normalizeMicSettings(settings); this.reset(); }

    reset() {
        this.chunks = [];
        this.preRoll = [];
        this.active = false;
        this.speechMs = 0;
        this.silenceMs = 0;
        this.totalMs = 0;
        this.attackElapsed = 0;
    }

    push(samples) {
        let energy = 0;
        for (const value of samples) energy += value * value;
        const rms = Math.sqrt(energy / samples.length);
        const durationMs = samples.length / SAMPLE_RATE * 1000;
        const threshold = 10 ** ((this.settings.thresholdDb - (this.active ? 6 : 0)) / 20);
        const voiced = rms >= threshold;
        if (!this.active) {
            this.preRoll.push(samples);
            const preRollLimit = Math.ceil((this.settings.attackMs + PAD_MS) / durationMs);
            if (this.preRoll.length > preRollLimit) this.preRoll.shift();
            if (!voiced) { this.attackElapsed = 0; return null; }
            this.attackElapsed += durationMs;
            if (this.attackElapsed < this.settings.attackMs) return null;
            this.active = true;
            this.chunks = [...this.preRoll];
            this.speechMs = this.attackElapsed - durationMs;
            this.totalMs = this.attackElapsed - durationMs;
        } else {
            this.chunks.push(samples);
        }
        this.totalMs += durationMs;
        if (voiced) { this.speechMs += durationMs; this.silenceMs = 0; }
        else this.silenceMs += durationMs;
        if (this.silenceMs < this.settings.silenceMs && this.totalMs < 25000) return null;
        const captured = this.chunks;
        const trailingMs = this.silenceMs;
        const meaningful = this.speechMs >= this.settings.minSpeechMs;
        this.reset();
        // Silence already elapsed before the cut; lets the caller date the actual end of speech.
        this.lastTrailingMs = trailingMs;
        if (!meaningful) return null;
        // Keep PAD_MS of trailing silence; the rest of the pause before cutting is dropped.
        const totalSamples = captured.reduce((count, chunk) => count + chunk.length, 0);
        const trimSamples = Math.min(totalSamples, Math.max(0, Math.round((trailingMs - PAD_MS) * SAMPLE_RATE / 1000)));
        const output = new Float32Array(totalSamples - trimSamples);
        let offset = 0;
        for (const chunk of captured) {
            if (offset >= output.length) break;
            const part = chunk.subarray(0, Math.min(chunk.length, output.length - offset));
            output.set(part, offset);
            offset += part.length;
        }
        return output;
    }
}

export class VoiceInput {
    constructor({ onUtterance, onState, onLevel, onActivity, settings = {}, capture = {} }) {
        this.onUtterance = onUtterance;
        this.onState = onState;
        this.onLevel = onLevel;
        // VAD edges: true when the segmenter starts a segment, false when it ends or is dropped.
        this.onActivity = onActivity;
        this.speaking = false;
        this.capture = { ...DEFAULT_CAPTURE_SETTINGS, ...capture };
        this.segmenter = new SpeechSegmenter(settings);
        this.running = false;
        this.busy = false;
        this.pending = Promise.resolve();
    }

    setSettings(settings) { this.segmenter.configure(settings); }

    async calibrate() {
        if (!this.running || this.busy || this.calibration) throw new Error('请先开启麦克风，并等待当前回复结束');
        this.segmenter.reset();
        this.onState('校准中 · 请保持安静 2 秒');
        return await new Promise((resolve, reject) => { this.calibration = { values: [], elapsedMs: 0, resolve, reject }; });
    }

    reportActivity(active) {
        if (active === this.speaking) return;
        this.speaking = active;
        this.onActivity?.(active);
    }

    setBusy(value) {
        this.busy = value;
        // Only entering busy drops a partial segment; leaving it must not cut speech that is still coming in.
        if (value) { this.segmenter.reset(); this.reportActivity(false); }
        if (!value && this.running) this.onState('正在听 · 停顿后发送');
    }

    async start() {
        if (this.running) return;
        this.onState('等待麦克风授权…');
        try {
            this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
            await this.context.resume();
            this.media = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, ...this.capture },
            });
            this.source = this.context.createMediaStreamSource(this.media);
            this.processor = this.context.createScriptProcessor(2048, 1, 1);
            this.gain = this.context.createGain();
            this.gain.gain.value = 0;
            this.source.connect(this.processor);
            this.processor.connect(this.gain);
            this.gain.connect(this.context.destination);
            this.running = true;
            this.processor.onaudioprocess = event => {
                if (!this.running) return;
                const samples = resampleAudio(event.inputBuffer.getChannelData(0), this.context.sampleRate);
                let energy = 0;
                for (const sample of samples) energy += sample * sample;
                const rms = Math.sqrt(energy / samples.length);
                const decibels = 20 * Math.log10(Math.max(rms, 0.0000001));
                this.onLevel?.(Math.min(1, rms * 12), decibels);
                if (this.calibration) {
                    const calibration = this.calibration;
                    calibration.values.push(decibels);
                    calibration.elapsedMs += samples.length / SAMPLE_RATE * 1000;
                    if (calibration.elapsedMs >= 2000) {
                        const values = calibration.values.sort((a, b) => a - b);
                        const noiseDb = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
                        const settings = normalizeMicSettings({ ...this.segmenter.settings, thresholdDb: noiseDb + 10 });
                        this.calibration = null;
                        this.setSettings(settings);
                        this.onState('正在听 · 停顿后发送');
                        calibration.resolve(settings);
                    }
                    return;
                }
                if (this.busy) return;
                const utterance = this.segmenter.push(samples);
                this.reportActivity(this.segmenter.active);
                if (utterance) {
                    // Keep listening while this segment is transcribed; segments are handed over in order.
                    const meta = { trailingMs: this.segmenter.lastTrailingMs ?? 0, emittedAt: Date.now() };
                    this.pending = this.pending.then(() => this.onUtterance(utterance, meta)).catch(() => {});
                } else if (this.segmenter.active) {
                    this.onState('正在收音…');
                } else this.onState('正在听 · 停顿后发送');
            };
            this.media.getAudioTracks()[0].addEventListener('ended', () => this.stop());
            this.onState('正在听 · 停顿后发送');
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop() {
        this.running = false;
        if (this.calibration) { this.calibration.reject(new Error('校准已取消')); this.calibration = null; }
        if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
        this.source?.disconnect();
        this.gain?.disconnect();
        this.media?.getTracks().forEach(track => track.stop());
        if (this.context && this.context.state !== 'closed') await this.context.close();
        this.segmenter.reset();
        this.reportActivity(false);
        this.onLevel?.(0);
        this.onState('麦克风已关闭');
    }
}
