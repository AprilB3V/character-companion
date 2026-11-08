import assert from 'node:assert/strict';
import test from 'node:test';
import { getModelStatus } from '../model-status.mjs';

test('normal startup requires a model and never silently selects demo replies', () => {
    assert.deepEqual(getModelStatus({}), { mode: 'unconfigured', ready: false, model: null, reason: 'missing-key' });
    const configured = getModelStatus({ DEEPSEEK_API_KEY: 'test-model-key', DEEPSEEK_MODEL: 'test-model' });
    assert.deepEqual(configured, { mode: 'model', ready: true, model: 'test-model' });
    assert.ok(!JSON.stringify(configured).includes('test-model-key'));
});

test('demo is explicit and invalid endpoints cannot report a configured model', () => {
    assert.deepEqual(getModelStatus({ JINGJING_ALLOW_MOCK: '1', DEEPSEEK_API_KEY: 'test-model-key' }),
        { mode: 'demo', ready: true, model: 'mock-in-character' });
    for (const endpoint of ['file:///tmp/model', 'https://user:password@example.test']) {
        assert.equal(getModelStatus({ DEEPSEEK_API_KEY: 'test-model-key', DEEPSEEK_BASE_URL: endpoint }).ready, false);
    }
});
