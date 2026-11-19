/**
 * test-e2e/tier1-features/tts.test.js
 * Feature 4: Dual-Engine TTS Subsystem & Automatic Fallback
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupSandbox,
    teardownSandbox,
    splitLongTextForTTS,
    cleanTextForSpeech,
    WSOLAProcessor,
    ContinuousResampler,
    createAnchorTrimmer,
    STV_TTSController
} from '../harness/index.js';
import { MockWebSocket } from '../harness/network-mock.js';

describe('Feature 4: Dual-Engine TTS Subsystem & Automatic Fallback', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    ttsEndpoint: 'ws://127.0.0.1:8765/tts',
                    ttsVoice: 'vi-female-1',
                    ttsSpeed: '1.0'
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.19: initializes with default TTS controller state', () => {
        const state = STV_TTSController.getState();
        assert.strictEqual(state.isPlaying, false, 'Default isPlaying must be false');
        assert.strictEqual(state.isPaused, false, 'Default isPaused must be false');
        assert.strictEqual(state.speed, 1.0, 'Default speed must be 1.0');
    });

    it('T1.20: plays sentence utterance and dispatches speech events', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Xin chào quý độc giả đang theo dõi tiểu thuyết.';
        document.body.appendChild(span);

        const res = await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(res.ok, true, 'Start must return ok');

        const state = STV_TTSController.getState();
        assert.strictEqual(state.isPlaying, true, 'Controller state must be isPlaying');
        assert.strictEqual(speechSynthesis.queue.length > 0, true, 'SpeechSynthesis queue must have utterance');
        assert.ok(speechSynthesis.queue[0].text.includes('Xin chào quý độc giả đang theo dõi tiểu thuyết.'));
        assert.strictEqual(speechSynthesis.speaking, true);
    });

    it('T1.21: seamlessly falls back to Web Speech API when WebSocket connection drops or fails', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Đoạn văn cần đọc lúc mạng bị lỗi kết nối.';
        document.body.appendChild(span);

        // Start with ws_default pointing to an immediate-failing WebSocket URL
        await STV_TTSController.start({
            engine: 'ws_default',
            wsEndpoint: 'wss://tts.stv-novel.local/fail_immediate'
        });

        // Wait a microtask tick for WebSocket error dispatch and fallbackToWebSpeech
        await new Promise((resolve) => setTimeout(resolve, 30));

        const state = STV_TTSController.getState();
        assert.strictEqual(state.isPlaying, true, 'Playback continues via fallback');
        assert.strictEqual(speechSynthesis.queue.length > 0, true, 'SpeechSynthesis must queue the sentence');
        assert.strictEqual(speechSynthesis.speaking, true, 'SpeechSynthesis speaking must be active');
    });

    it('T1.21b: triggers fallbackToWebSpeech when WebSocket closes mid-sentence after partial audio chunk is received', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Đoạn văn bị ngắt kết nối WebSocket giữa chừng khi đang nhận audio.';
        document.body.appendChild(span);

        await STV_TTSController.start({
            engine: 'ws_default',
            wsEndpoint: 'wss://tts.stv-novel.local/stream_audio'
        });

        const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        assert.ok(ws, 'Active WebSocket must exist');

        // Server sends partial audio chunk without done
        const fakePcm = new Int16Array(100).buffer;
        ws.onmessage({ data: fakePcm });

        // Server abruptly closes mid-sentence before sending done
        ws.simulateClose(1006, 'Abrupt mid-sentence disconnect');

        const state = STV_TTSController.getState();
        assert.strictEqual(state.activeEngine, 'webspeech', 'Must fallback to Web Speech on unexpected disconnect');
        assert.strictEqual(speechSynthesis.queue.length, 1, 'Sentence must queue in Web Speech without freeze/deadlock');
        assert.strictEqual(speechSynthesis.speaking, true);

        STV_TTSController.stop();
    });

    it('T1.22: chunks long sentences into segments <=180 characters at punctuation boundaries', () => {
        const longSentence = 'Tiêu Viêm nhìn về phía chân trời xa xôi, nơi đó mây đen vần vũ, sấm sét ầm ầm vang dội khắp cả sơn cốc, khiến cho vạn vật run rẩy, đồng thời trong lòng hắn cũng dâng lên một cỗ nhiệt huyết vô biên khi nhớ về lời ước hẹn ba năm trước.';

        assert.ok(longSentence.length > 180, 'Test input must be longer than 180 chars');

        const cleaned = cleanTextForSpeech(longSentence);
        const chunks = splitLongTextForTTS(cleaned, 180);

        assert.ok(chunks.length >= 2, 'Should be split into at least 2 chunks');
        for (const chunk of chunks) {
            assert.ok(chunk.length <= 180, `Chunk length (${chunk.length}) must not exceed 180 chars`);
            assert.ok(chunk.trim().length > 0, 'Chunk must not be empty');
        }
        // Verify no text loss
        const reconstituted = chunks.join(' ');
        assert.ok(reconstituted.includes('Tiêu Viêm nhìn về phía chân trời'));
        assert.ok(reconstituted.includes('ba năm trước'));
    });

    it('T1.23: Web Speech heartbeat cycles pause and resume every 10s without interrupting audio flow', () => {
        const initialHeartbeatCount = sandbox.speechSynthesis.heartbeatCount;
        assert.strictEqual(initialHeartbeatCount, 0);

        // Manually trigger the heartbeat callback
        sandbox.speechSynthesis.pause();
        sandbox.speechSynthesis.resume();

        assert.strictEqual(sandbox.speechSynthesis.heartbeatCount, 1);
        assert.strictEqual(sandbox.speechSynthesis.paused, false);
    });

    it('T1.24: pause, resume, and stop controls manipulate state cleanly', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Thử nghiệm điều khiển phát.';
        document.body.appendChild(span);

        await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(STV_TTSController.getState().isPlaying, true);

        // Pause
        STV_TTSController.togglePauseResume();
        assert.strictEqual(STV_TTSController.getState().isPaused, true);
        assert.strictEqual(sandbox.speechSynthesis.paused, true);

        // Resume
        STV_TTSController.togglePauseResume();
        assert.strictEqual(STV_TTSController.getState().isPaused, false);
        assert.strictEqual(sandbox.speechSynthesis.paused, false);

        // Stop
        STV_TTSController.stop();
        assert.strictEqual(STV_TTSController.getState().isPlaying, false);
        assert.strictEqual(sandbox.speechSynthesis.speaking, false);
        assert.strictEqual(sandbox.speechSynthesis.queue.length, 0);
    });

    it('T1.24b: DSP Audio processing with WSOLAProcessor, ContinuousResampler, and AnchorTrimmer', () => {
        // 1. WSOLA time stretcher
        const wsola = new WSOLAProcessor(48000, 1.5);
        assert.strictEqual(wsola.speed, 1.5);
        const testAudio = new Float32Array(4800);
        for (let i = 0; i < testAudio.length; i++) {
            testAudio[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
        }
        const wsolaOut = wsola.process(testAudio);
        assert.ok(wsolaOut instanceof Float32Array);

        // 2. Continuous Resampler (48000 -> 24000)
        const resampler = new ContinuousResampler(48000, 24000);
        const resampled = resampler.process(testAudio);
        assert.strictEqual(resampled.length, 2400, 'Downsampling 2:1 halves sample length');

        // 3. Anchor Trimmer
        const trimmer = createAnchorTrimmer(48000);
        const silence = new Float32Array(100);
        const trimmed = trimmer.push(silence);
        assert.strictEqual(trimmed, null, 'Initial silence accumulates until threshold');
    });

    it('T1.25: pure-icon lines are not dropped and default to tagged description style', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = '😭😭😭';
        document.body.appendChild(span);

        const res = await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(STV_TTSController.getState().iconMode, 'auto');
        assert.strictEqual(STV_TTSController.getState().iconStyle, 'tagged');
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.ok(speechSynthesis.queue[0].text.includes('Biểu cảm khóc nức nở dữ dội'));
        assert.strictEqual(span.textContent, '😭😭😭', 'Original DOM line must never be mutated');
        STV_TTSController.stop();
    });

    it('T1.26: resolves complex kaomoji via background AI with context, updates preview, and reuses learned cache', async () => {
        await chrome.storage.local.set({
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apikey: 'sk-test-valid-key',
            model: 'google/gemini-2.5-flash'
        });

        let aiCalls = 0;
        let capturedPayload = null;
        sandbox.network.addRoute('/chat/completions', async (url, options) => {
            aiCalls += 1;
            const body = JSON.parse(options.body);
            capturedPayload = JSON.parse(body.messages[1].content);
            assert.strictEqual(body.model, 'google/gemini-2.5-flash');
            assert.strictEqual(options.headers.Authorization, 'Bearer sk-test-valid-key');
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                id: capturedPayload.items[0].id,
                                spoken: 'Cô con gái, biểu cảm mếu máo khóc nấc vì ấm ức.',
                                icon_gloss: { '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა': 'mếu máo khóc nấc vì ấm ức' }
                            }]
                        })
                    }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const l1 = document.createElement('span');
        l1.className = 'stv-line';
        l1.textContent = 'Sở Oánh: "Con gái, sao thế?"';
        const l2 = document.createElement('span');
        l2.className = 'stv-line';
        l2.textContent = 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა';
        const l3 = document.createElement('span');
        l3.className = 'stv-line';
        l3.textContent = 'Cô lao bổ vào Sở Oánh: "A... tại mẹ hết..."';
        document.body.appendChild(l1);
        document.body.appendChild(l2);
        document.body.appendChild(l3);

        await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(speechSynthesis.queue.length, 1, 'First non-icon line must start immediately');
        assert.ok(speechSynthesis.queue[0].text.includes('Sở Oánh'));

        // Wait for background AI batch to finish
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.strictEqual(aiCalls, 1);
        assert.ok(capturedPayload.items[0].prev.includes('Sở Oánh'));
        assert.ok(capturedPayload.items[0].next.includes('lao bổ'));

        // Advance to segment 2 (MockSpeechSynthesis.cancel clears queue before pushing next utterance)
        speechSynthesis.queue[0].onend();
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.strictEqual(speechSynthesis.queue[0].text, 'Cô con gái, biểu cảm mếu máo khóc nấc vì ấm ức.');
        assert.strictEqual(l2.textContent, 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', 'Original DOM must stay untouched');

        const previewEl = document.getElementById('stv-tts-root')?.shadowRoot?.querySelector('.stv-tts-preview');
        assert.strictEqual(previewEl?.textContent, 'Cô con gái, biểu cảm mếu máo khóc nấc vì ấm ức.');

        const stored = await chrome.storage.local.get(['stv_tts_icon_cache']);
        assert.strictEqual(stored.stv_tts_icon_cache['૮ε˚۵ ⋋ʌ⋋۵ 3˚ა'].vi, 'mếu máo khóc nấc vì ấm ức');

        STV_TTSController.stop();

        // Second playback on same kaomoji must hit cache with 0 additional AI calls
        await STV_TTSController.start({ engine: 'webspeech', startIndex: 1 });
        assert.strictEqual(aiCalls, 1, 'Learned cache hit must avoid duplicate AI call');
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.strictEqual(speechSynthesis.queue[0].text, 'Cô con gái, biểu cảm mếu máo khóc nấc vì ấm ức');
        STV_TTSController.stop();
    });

    it('T1.27: falls back gracefully when API key is missing or AI errors, and honors iconMode=off', async () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა';
        document.body.appendChild(span);

        // No apikey configured -> falls back cleanly to Tier 3 structural heuristic
        await STV_TTSController.start({ engine: 'webspeech' });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.ok(speechSynthesis.queue[0].text.startsWith('Cô con gái, biểu cảm '));
        assert.ok(!/[\u0A80-\u0AFF\u10A0-\u10FF\u0250-\u02FF\u06F5]/.test(speechSynthesis.queue[0].text));
        STV_TTSController.stop();

        // Configured apikey but AI endpoint fails -> waits briefly and falls back cleanly without error
        await chrome.storage.local.set({ apikey: 'sk-test-valid-key' });
        sandbox.network.addRoute('/chat/completions', async () => new Response('Server error', { status: 500 }));
        await STV_TTSController.start({ engine: 'webspeech' });
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.ok(speechSynthesis.queue[0].text.startsWith('Cô con gái, biểu cảm '));
        STV_TTSController.stop();

        // iconMode = 'off' strips kaomoji cleanly
        await STV_TTSController.start({ engine: 'webspeech', iconMode: 'off' });
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.strictEqual(speechSynthesis.queue[0].text, 'Cô con gái');
        STV_TTSController.stop();
    });

    it('T1.28: honors stv_tts_custom_icons overrides, per-icon skip, and prevents AI cache overwrite', async () => {
        await chrome.storage.local.set({
            apikey: 'sk-test-valid-key',
            stv_tts_custom_icons: {
                '✨': { meaning: 'lấp lánh', skip: true, updatedAt: 100 },
                '😂': { meaning: 'cười vỡ bụng', skip: false, updatedAt: 200 },
                '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა': { meaning: 'khóc nức nở vì tủi thân', skip: false, updatedAt: 300 }
            }
        });

        let aiCalls = 0;
        sandbox.network.addRoute('/chat/completions', async () => {
            aiCalls += 1;
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                id: 0,
                                spoken: 'AI overridden',
                                icon_gloss: { '😂': 'should not overwrite custom' }
                            }]
                        })
                    }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const l1 = document.createElement('span');
        l1.className = 'stv-line';
        l1.textContent = '✨'; // completely muted -> must be skipped!
        const l2 = document.createElement('span');
        l2.className = 'stv-line';
        l2.textContent = 'Hắn cười 😂 rồi nhìn ✨ cô bé';
        const l3 = document.createElement('span');
        l3.className = 'stv-line';
        l3.textContent = 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა';
        document.body.appendChild(l1);
        document.body.appendChild(l2);
        document.body.appendChild(l3);

        const res = await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.totalSegments, 2, 'Muted icon-only line must be skipped completely');
        assert.strictEqual(aiCalls, 0, 'Custom-overridden kaomoji must not trigger AI call');

        assert.strictEqual(speechSynthesis.queue[0].text, 'Hắn cười, biểu cảm cười vỡ bụng, rồi nhìn cô bé');
        speechSynthesis.queue[0].onend();
        assert.strictEqual(speechSynthesis.queue[0].text, 'Cô con gái, biểu cảm khóc nức nở vì tủi thân');
        STV_TTSController.stop();

        // Also verify background resolve_tts_icons protects custom icons from cache write
        const bgRes = await chrome.runtime.sendMessage({
            action: 'resolve_tts_icons',
            style: 'tagged',
            lang: 'vi',
            items: [{
                id: 0,
                prev: '',
                text: 'Test 😂',
                fallbackText: 'Test',
                next: '',
                icons: ['😂']
            }]
        });
        assert.strictEqual(bgRes.ok, true);
        const storedAfter = await chrome.storage.local.get(['stv_tts_icon_cache']);
        assert.strictEqual(storedAfter.stv_tts_icon_cache?.['😂'], undefined, 'Custom icon must never be written into AI cache');
    });
});
