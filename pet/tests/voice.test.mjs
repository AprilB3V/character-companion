import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('speech segmentation ignores silence and short clicks, and submits a phrase once after a pause', async () => {
    assert.ok(existsSync(new URL('../voice-input.mjs', import.meta.url)), 'Local microphone capture is missing');
    const { SpeechSegmenter, resampleAudio } = await import('../voice-input.mjs');
    const segmenter = new SpeechSegmenter();
    const speech = new Float32Array(1600).fill(0.05);
    const silence = new Float32Array(1600);
    assert.equal(segmenter.push(silence), null);
    segmenter.push(speech);
    for (let index = 0; index < 12; index++) assert.equal(segmenter.push(silence), null);
    for (let index = 0; index < 5; index++) assert.equal(segmenter.push(speech), null);
    const segments = [];
    for (let index = 0; index < 12; index++) {
        const result = segmenter.push(silence);
        if (result) segments.push(result);
    }
    assert.equal(segments.length, 1);
    assert.ok(segments[0].length >= 1600 * 5);
    const resampled = resampleAudio(new Float32Array(4800).fill(0.25), 48000);
    assert.equal(resampled.length, 1600);
    assert.ok(resampled.every(value => Math.abs(value - 0.25) < 0.00001));
});

test('a segment cut on silence reports how much silence was already waited', async () => {
    const { SpeechSegmenter } = await import('../voice-input.mjs');
    const segmenter = new SpeechSegmenter({ silenceMs: 1000 });
    for (let index = 0; index < 6; index++) segmenter.push(new Float32Array(1600).fill(0.05));
    let output = null;
    for (let index = 0; index < 15 && !output; index++) output = segmenter.push(new Float32Array(1600));
    assert.ok(output);
    // Chunks are 100 ms, so the cut happens at the first chunk reaching 1000 ms of silence.
    assert.equal(Math.round(segmenter.lastTrailingMs), 1000);
});

test('leaving busy does not cut speech that is still being captured', async () => {
    const { VoiceInput } = await import('../voice-input.mjs');
    const voice = new VoiceInput({ onUtterance: () => {}, onState: () => {}, onLevel: () => {} });
    for (let index = 0; index < 4; index++) voice.segmenter.push(new Float32Array(1600).fill(0.05));
    assert.equal(voice.segmenter.active, true);
    voice.setBusy(false);
    assert.equal(voice.segmenter.active, true);
    voice.setBusy(true);
    assert.equal(voice.segmenter.active, false);
});

test('configured microphone gate rejects steady background noise and brief loud clicks', async () => {
    const { SpeechSegmenter } = await import('../voice-input.mjs');
    const segmenter = new SpeechSegmenter({ thresholdDb: -30, attackMs: 200, minSpeechMs: 400 });
    const noise = new Float32Array(1600).fill(0.02);
    for (let index = 0; index < 50; index++) assert.equal(segmenter.push(noise), null);
    assert.equal(segmenter.push(new Float32Array(1600).fill(0.2)), null);
    for (let index = 0; index < 15; index++) assert.equal(segmenter.push(noise), null);
    assert.equal(segmenter.active, false);
    const outputs = [];
    for (let index = 0; index < 8; index++) segmenter.push(new Float32Array(1600).fill(0.08));
    for (let index = 0; index < 12; index++) {
        const output = segmenter.push(new Float32Array(1600));
        if (output) outputs.push(output);
    }
    assert.equal(outputs.length, 1);
});
