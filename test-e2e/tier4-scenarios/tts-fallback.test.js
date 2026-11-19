/**
 * test-e2e/tier4-scenarios/tts-fallback.test.js
 * Scenario 3: Resilient Chapter Audio Reading with WebSocket Disconnection Fallback
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, ReaderUI, STV_TTSController } from '../harness/index.js';
import { MockWebSocket } from '../harness/network-mock.js';

describe('Tier 4 Scenario 3: TTS Disconnection & Seamless Web Speech Fallback', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    ttsEngine: 'ws_default',
                    ttsWsEndpoint: 'ws://127.0.0.1:8765/tts',
                    ttsWsVoice: 'vi-VN-HoaiMyNeural',
                    ttsWsAutoFallback: true,
                    ttsSpeed: 1.0,
                    ttsAutoNextChapter: false
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 3: reading session recovers from WebSocket drop with Web Speech API and Shadow DOM toast', async () => {
        // Step 1: Injected Reader UI initialized in Shadow DOM
        const { shadow } = ReaderUI.init();

        const sentences = [
            'Câu thứ nhất của chương truyện với nội dung chi tiết về thế giới tu tiên rộng lớn bao la và hành trình gian khổ bắt đầu từ một sơn thôn hẻo lánh.',
            'Câu thứ hai tiếp tục vang lên với nhiều chi tiết hấp dẫn về bí kíp võ công thượng thừa được truyền lại từ thời viễn cổ xa xôi ngàn năm trước.'
        ];

        // Setup DOM with novel sentences
        const container = document.createElement('div');
        container.id = 'chapter-content';
        for (const s of sentences) {
            const span = document.createElement('span');
            span.className = 'stv-line';
            span.textContent = s;
            container.appendChild(span);
        }
        document.body.appendChild(container);

        // Step 2: User starts TTS via genuine STV_TTSController
        const startResult = await STV_TTSController.start();
        assert.ok(startResult.ok, 'TTS must start successfully');
        assert.strictEqual(startResult.totalSegments, 2);

        const initialTtsState = STV_TTSController.getState();
        assert.strictEqual(initialTtsState.isPlaying, true);
        assert.strictEqual(initialTtsState.currentIndex, 0);

        // Active WebSocket created for sentence 0
        const wsInstances = MockWebSocket.instances;
        assert.ok(wsInstances.length > 0, 'WebSocket instance must be instantiated');
        const activeWs = wsInstances[wsInstances.length - 1];
        assert.strictEqual(activeWs.url, 'ws://127.0.0.1:8765/tts');

        // Step 3: During reading, WebSocket connection abruptly closes (network drop / server crash)
        activeWs.simulateClose(1006, 'Abnormal Connection Closure');

        // Step 4: Coordinator intercepts unexpected close, stops stream player, and switches engine to Web Speech
        const fallbackState = STV_TTSController.getState();
        assert.strictEqual(fallbackState.activeEngine, 'webspeech', 'Engine must switch to Web Speech');

        // Verify toast appeared inside Shadow DOM
        const toastContainer = shadow.getElementById('stv-toast-container');
        assert.ok(toastContainer, 'Toast container must exist in Shadow DOM');
        const toast = toastContainer.querySelector('.stv-toast');
        assert.ok(toast, 'Toast notification must be emitted');
        assert.ok(toast.textContent.includes('Web Speech'), 'Toast text must announce Web Speech switch');

        // Step 5: Web Speech resumes playback of sentence 0 via genuine speechSynthesis
        assert.strictEqual(speechSynthesis.queue.length, 1, 'Sentence 0 must be queued in Web Speech');
        assert.strictEqual(speechSynthesis.queue[0].text, sentences[0]);

        // Step 6: User pauses and resumes smoothly via STV_TTSController
        STV_TTSController.togglePauseResume();
        const pausedState = STV_TTSController.getState();
        assert.strictEqual(pausedState.isPaused, true);
        assert.strictEqual(speechSynthesis.paused, true);

        STV_TTSController.togglePauseResume();
        const resumedState = STV_TTSController.getState();
        assert.strictEqual(resumedState.isPaused, false);
        assert.strictEqual(speechSynthesis.paused, false);

        // Step 7: Advance playback by completing current Web Speech utterance
        speechSynthesis.simulateCompleteCurrent();

        // Next sentence (index 1) continues seamlessly in Web Speech
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.strictEqual(speechSynthesis.queue[0].text, sentences[1]);

        const nextState = STV_TTSController.getState();
        assert.strictEqual(nextState.currentIndex, 1);
        assert.strictEqual(nextState.activeEngine, 'webspeech');
    });
});
