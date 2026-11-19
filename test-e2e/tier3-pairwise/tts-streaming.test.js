/**
 * test-e2e/tier3-pairwise/tts-streaming.test.js
 * Tier 3 Pairwise Combinatorics: TTS Playback Concurrent with Streaming Translation (4 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, STV_TTSController, STV_createStreamRenderer } from '../harness/index.js';

describe('Tier 3: TTS + Streaming Translation Interaction', () => {
    let sandbox;
    let container;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    ttsEngine: 'webspeech',
                    ttsAutoNextChapter: false
                }
            }
        });
        container = document.createElement('div');
        container.id = 'chapter-content';
        document.body.appendChild(container);
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T3.1: TTS reads completed lines concurrently while subsequent lines are streaming in', async () => {
        const origChunks = [
            'Đoạn 0 gốc tiếng Trung với nội dung chi tiết mở đầu câu chuyện tu tiên.',
            'Đoạn 1 gốc tiếng Trung tiếp tục diễn biến câu chuyện với các chi tiết gay cấn.',
            'Đoạn 2 gốc tiếng Trung kết thúc phân đoạn một với những bí ẩn chưa có lời giải đáp.'
        ];
        const runId = 'run-stream-tts-1';
        window.STV_translationState = { active: true, runId };
        globalThis.STV_translationState = window.STV_translationState;

        const renderer = STV_createStreamRenderer(container, origChunks, runId, false);

        // Streaming starts: line 0 arrives and finalizes
        renderer.syncText('Đoạn 0: Bầu trời đầy sao lấp lánh và màn đêm buông xuống trên ngọn núi cao hẻo lánh.\n', false);
        await new Promise(r => setTimeout(r, 40));

        const renderedLine0 = container.querySelector('.stv-line:not(.stv-line-partial)');
        assert.ok(renderedLine0, 'Line 0 must be finalized in DOM');

        // TTS starts reading finalized line 0 concurrently
        const startResult = await STV_TTSController.start({ engine: 'webspeech' });
        assert.ok(startResult.ok);

        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.ok(speechSynthesis.queue[0].text.includes('Bầu trời đầy sao'));

        // While TTS is reading line 0, subsequent lines 1 and 2 stream in
        renderer.syncText(
            'Đoạn 0: Bầu trời đầy sao lấp lánh và màn đêm buông xuống trên ngọn núi cao hẻo lánh.\n' +
            'Đoạn 1: Tiêu Viêm ngồi xếp bằng trong mật thất tu luyện công pháp thượng thừa.\n' +
            'Đoạn 2: Dược Lão chậm rãi hiện hình mỉm cười hài lòng với đệ tử.\n',
            true
        );

        const allLines = container.querySelectorAll('.stv-line:not(.stv-line-partial)');
        assert.strictEqual(allLines.length, 3, 'Streaming progressed to 3 finalized lines');

        // TTS completes line 0
        speechSynthesis.simulateCompleteCurrent();

        // TTS coordinator advances to line 1 automatically
        assert.strictEqual(speechSynthesis.queue.length, 1);
        assert.ok(speechSynthesis.queue[0].text.includes('Tiêu Viêm ngồi xếp bằng'));

        STV_TTSController.stop();
    });

    it('T3.2: TTS enters waiting state when catching up to streaming cursor and resumes when new chunk arrives', async () => {
        const origChunks = [
            'Đoạn mở đầu câu chuyện tu tiên huyền ảo với nhiều kỳ ngộ đặc biệt trên đỉnh núi linh khí.',
            'Đoạn tiếp theo vừa được dịch xong từ AI với câu từ mượt mà đậm chất kiếm hiệp cổ trang.'
        ];
        const runId = 'run-stream-wait-1';
        window.STV_translationState = { active: true, runId };
        globalThis.STV_translationState = window.STV_translationState;

        const renderer = STV_createStreamRenderer(container, origChunks, runId, false);

        // Line 0 is finalized
        renderer.syncText('Đoạn mở đầu câu chuyện tu tiên huyền ảo với nhiều kỳ ngộ đặc biệt trên đỉnh núi linh khí.\n', false);
        await new Promise(r => setTimeout(r, 40));

        // TTS starts playing line 0
        const startResult = await STV_TTSController.start({ engine: 'webspeech' });
        assert.ok(startResult.ok);
        assert.strictEqual(speechSynthesis.queue.length, 1);

        // Line 0 completes in TTS while line 1 is still translating
        speechSynthesis.simulateCompleteCurrent();

        // Coordinator notices stream is active and enters waiting state without terminating chapter
        const waitingState = STV_TTSController.getState();
        assert.strictEqual(waitingState.isPlaying, true, 'TTS should remain in active playing state');
        assert.strictEqual(speechSynthesis.queue.length, 0, 'No more audio queued yet while waiting');

        // Stream emits line 1 and completes
        renderer.syncText(
            'Đoạn mở đầu câu chuyện tu tiên huyền ảo với nhiều kỳ ngộ đặc biệt trên đỉnh núi linh khí.\n' +
            'Đoạn tiếp theo vừa được dịch xong từ AI với câu từ mượt mà đậm chất kiếm hiệp cổ trang.\n',
            true
        );

        // TTS listener receives 'stv-translation-progress' and auto-resumes playback of line 1
        assert.strictEqual(speechSynthesis.queue.length, 1, 'Audio for newly streamed line 1 must queue automatically');
        assert.ok(speechSynthesis.queue[0].text.includes('Đoạn tiếp theo vừa được dịch xong'));

        STV_TTSController.stop();
    });

    it('T3.3: pausing TTS during streaming does not interrupt streaming translation completion', async () => {
        const origChunks = [
            'Dòng 1 câu chuyện đang dịch.',
            'Dòng 2 câu chuyện tiếp theo.',
            'Dòng 3 câu chuyện kết thúc.'
        ];
        const runId = 'run-stream-pause-1';
        window.STV_translationState = { active: true, runId };
        globalThis.STV_translationState = window.STV_translationState;

        const renderer = STV_createStreamRenderer(container, origChunks, runId, false);
        renderer.syncText('Dòng 1 câu chuyện đang dịch.\n', false);
        await new Promise(r => setTimeout(r, 40));

        await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(speechSynthesis.speaking, true);

        // User pauses TTS
        STV_TTSController.togglePauseResume();
        const ttsState = STV_TTSController.getState();
        assert.strictEqual(ttsState.isPaused, true);
        assert.strictEqual(speechSynthesis.paused, true);

        // Streaming finishes in background while TTS is paused
        renderer.syncText('Dòng 1 câu chuyện đang dịch.\nDòng 2 câu chuyện tiếp theo.\nDòng 3 câu chuyện kết thúc.\n', true);

        const rendered = container.querySelectorAll('.stv-line');
        assert.strictEqual(rendered.length, 3, 'Streaming DOM rendering completed independently');

        const finalTtsState = STV_TTSController.getState();
        assert.strictEqual(finalTtsState.isPaused, true, 'TTS remains safely paused');

        STV_TTSController.stop();
    });

    it('T3.4: aborting translation cancels both SSE streaming and halts active TTS playback', async () => {
        const origChunks = ['Dòng đang đọc dở dang với nhiều tình tiết hồi hộp'];
        const runId = 'run-stream-abort-1';
        window.STV_translationState = { active: true, runId };
        globalThis.STV_translationState = window.STV_translationState;

        const renderer = STV_createStreamRenderer(container, origChunks, runId, false);
        renderer.syncText('Dòng đang đọc dở dang với nhiều tình tiết hồi hộp.\n', false);
        await new Promise(r => setTimeout(r, 40));

        await STV_TTSController.start({ engine: 'webspeech' });
        assert.strictEqual(speechSynthesis.speaking, true);

        // Abort translation and stop TTS
        window.STV_translationState = { active: false, runId: null };
        globalThis.STV_translationState = window.STV_translationState;
        STV_TTSController.stop();

        assert.strictEqual(speechSynthesis.speaking, false, 'TTS audio must be canceled');
        assert.strictEqual(speechSynthesis.queue.length, 0);
        const stoppedState = STV_TTSController.getState();
        assert.strictEqual(stoppedState.isPlaying, false);
    });
});
