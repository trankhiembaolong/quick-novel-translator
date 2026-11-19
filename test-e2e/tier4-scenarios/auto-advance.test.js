/**
 * test-e2e/tier4-scenarios/auto-advance.test.js
 * Scenario 4: Multi-Chapter Auto-Advance with Preload Cache
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupSandbox,
    teardownSandbox,
    UrlValidator,
    STV_TTSController,
    STV_createStreamRenderer
} from '../harness/index.js';

describe('Tier 4 Scenario 4: Multi-Chapter Auto-Advance with Preload', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            window: {
                url: 'https://novel.test/chapter-1.html'
            },
            chrome: {
                initialStorage: {
                    ttsAutoNextChapter: true,
                    apikey: 'sk-or-v1-valid-key',
                    'stv_selector_novel.test': '#chapter-content'
                },
                initialPermissions: ['storage', 'activeTab', 'scripting'],
                initialOrigins: ['https://novel.test/*'],
                initialTabs: [
                    { id: 1, active: true, url: 'https://novel.test/chapter-1.html', status: 'complete' }
                ]
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 4: background preloads next chapter and renders instantly on auto-advance tab completion', async () => {
        const chapter1Url = 'https://novel.test/chapter-1.html';
        const chapter2Url = 'https://novel.test/chapter-2.html';

        // Step 1: In Chapter 1, reader detects next chapter link
        const doc1 = document.createElement('div');
        doc1.innerHTML = `
            <div id="chapter-content"><p>Nội dung đang đọc chương 1.</p></div>
            <a rel="next" href="/chapter-2.html">Chương Sau</a>
        `;
        document.body.appendChild(doc1);

        const nextLink = doc1.querySelector('a[rel="next"]');
        assert.ok(nextLink);
        const resolvedNextUrl = new URL(nextLink.getAttribute('href'), chapter1Url).href;
        assert.strictEqual(resolvedNextUrl, chapter2Url);

        // Step 2: Validate safety against SSRF and cross-origin attacks
        const validation = UrlValidator.isSafePreloadTarget(chapter1Url, resolvedNextUrl);
        assert.strictEqual(validation.valid, true);

        // Step 3: Route network fetch for Chapter 2 HTML (>150 chars to satisfy extractor threshold)
        sandbox.network.addRoute('/chapter-2.html', () => {
            return new Response(`
                <div id="chapter-content">
                    <p>第二章: 斗之气三段。萧炎苦笑了一声，转身走出人群，周围的讥讽嘲笑之声不绝于耳，犹如一根根尖刺深深地扎在他的心中，让他感到无比的屈辱与愤怒。</p>
                    <p>然而在这个以武为尊的斗气大陆上，没有实力便连最基本的尊严都无法拥有，弱肉强食才是永恒不变的天地法则，他必须咬紧牙关坚持下去。</p>
                </div>
            `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });

        // Background worker initiates preload broker via runtime message
        const preloadRes = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: resolvedNextUrl,
            mode: 'tts_only'
        });

        assert.ok(preloadRes, 'Preload response must exist');
        assert.strictEqual(preloadRes.ok, true, 'Preload must be accepted');
        const preloadId = preloadRes.preloadId;
        assert.ok(preloadId, 'Must return assigned preloadId');

        // Allow background worker async fetch to resolve
        await new Promise(r => setTimeout(r, 20));

        // Step 4: Chapter 1 audio finishes -> auto-advance triggers navigation broker in background
        const navRes = await chrome.runtime.sendMessage({
            action: 'navigate_next_chapter',
            url: resolvedNextUrl,
            mode: 'tts_only'
        });
        assert.ok(navRes, 'Navigation response must exist');
        assert.strictEqual(navRes.ok, true);

        const currentTab = await chrome.tabs.get(1);
        assert.strictEqual(currentTab.url, resolvedNextUrl, 'Tab must be navigated to Chapter 2');

        // Step 5: On tab navigation complete, content script connects to genuine background stv-preload-stream port
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        await new Promise(r => setTimeout(r, 10));
        const snapshotReceived = await new Promise((resolve) => {
            port.onMessage.addListener((msg) => {
                if (msg && (msg.type === 'snapshot' || msg.type === 'delta')) {
                    resolve(msg);
                }
            });
            port.postMessage({ type: 'subscribe', preloadId });
        });

        assert.ok(snapshotReceived, 'Must receive preloaded snapshot from background broker');
        assert.strictEqual(snapshotReceived.type, 'snapshot');

        // Step 6: Render chapter content to DOM
        document.body.innerHTML = '';
        const chapter2Container = document.createElement('div');
        chapter2Container.id = 'chapter-content';

        const lines = [
            { orig: '第二章: 斗之气三段', trans: 'Chương 2: Đấu chi khí tam đoạn' },
            { orig: '萧炎苦笑了一声，转身走出人群。', trans: 'Tiêu Viêm cười khổ một tiếng, xoay người đi ra khỏi đám người.' }
        ];

        for (const item of lines) {
            const line = document.createElement('span');
            line.className = 'stv-line';
            line.setAttribute('data-orig', item.orig);
            line.textContent = item.trans;
            chapter2Container.appendChild(line);
        }
        document.body.appendChild(chapter2Container);

        const rendered = document.querySelectorAll('.stv-line');
        assert.strictEqual(rendered.length, 2);
        assert.strictEqual(rendered[0].textContent, 'Chương 2: Đấu chi khí tam đoạn');
        assert.strictEqual(rendered[1].textContent, 'Tiêu Viêm cười khổ một tiếng, xoay người đi ra khỏi đám người.');

        try { port.disconnect(); } catch {}
    });

    it('Scenario 4b: translated chapter starts preload at >=90s remaining and does not abort unrelated url on cancel', async () => {
        const chapter2Url = 'https://novel.test/chapter-2.html';
        const chapter3Url = 'https://novel.test/chapter-3.html';

        const container = document.createElement('div');
        container.id = 'chapter-content';
        // ~1200 chars -> ~68.6s at 17.5 chars/sec (< 90s effective lead -> must trigger immediately!)
        const longText = 'Tiêu Viêm nhìn về phía ngọn núi tuyết phủ sừng sững giữa bầu trời đêm. '.repeat(17);
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = longText;
        container.appendChild(span);

        const nextLink = document.createElement('a');
        nextLink.setAttribute('rel', 'next');
        nextLink.setAttribute('href', '/chapter-2.html');
        nextLink.textContent = 'Chương sau';

        document.body.appendChild(container);
        document.body.appendChild(nextLink);

        sandbox.network.addRoute('/chapter-2.html', () => new Response(`
            <div id="chapter-content">
                <p>${'Chương 2 tiếp nối cốt truyện hấp dẫn với nhiều chi tiết mới. '.repeat(5)}</p>
            </div>
        `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));

        const preloadChap2 = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: chapter2Url,
            mode: 'tts_only'
        });
        assert.strictEqual(preloadChap2.ok, true);
        await new Promise((r) => setTimeout(r, 20));

        // Cancelling chapter 3 must NOT abort chapter 2's active/ready preload entry
        await chrome.runtime.sendMessage({
            action: 'cancel_chapter_preload',
            url: chapter3Url
        });
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        await new Promise((r) => setTimeout(r, 10));
        const snap = await new Promise((resolve) => {
            port.onMessage.addListener((m) => { if (m && m.type === 'snapshot') resolve(m); });
            port.postMessage({ type: 'subscribe', preloadId: preloadChap2.preloadId });
        });
        assert.strictEqual(snap.done, true, 'Chapter 2 preload must survive cancel of unrelated URL');
        try { port.disconnect(); } catch {}

        await STV_TTSController.start({ engine: 'webspeech', preloadLeadSec: 30, autoNextChapter: true });
        await new Promise((r) => setTimeout(r, 40));

        const ttsState = STV_TTSController.getState();
        assert.strictEqual(ttsState.preloadState, 'ready', 'TTS controller must track preload readiness for ~69s translated chapter (<90s lead)');
        STV_TTSController.stop();
    });

    it('Scenario 4c: stream renderer invokes local STV_startTTS immediately on first complete translated paragraph', async () => {
        const container = document.createElement('div');
        container.id = 'chapter-content';
        document.body.appendChild(container);
        window.STV_activeContentBox = container;
        globalThis.STV_activeContentBox = container;

        let startedOpts = null;
        const origStartTts = window.STV_startTTS;
        window.STV_startTTS = (opts) => { startedOpts = opts; };
        globalThis.STV_startTTS = window.STV_startTTS;

        try {
            const renderer = STV_createStreamRenderer(container, ['Gốc 1', 'Gốc 2'], 'run-fast-start', true);
            renderer.syncText('Chương 2 bắt đầu với bầu không khí căng thẳng bao trùm khắp đại điện.\n', false);
            await new Promise((r) => setTimeout(r, 40));

            assert.ok(startedOpts, 'Must invoke STV_startTTS directly after first complete sentence (>=45 chars)');
            assert.strictEqual(startedOpts.autoTriggered, true);
        } finally {
            window.STV_startTTS = origStartTts;
            globalThis.STV_startTTS = origStartTts;
        }
    });

    it('Scenario 4d: preload survives MV3 SW restart via session storage and recovers on resume after port/network interruption during pause', async () => {
        const chapter2Url = 'https://novel.test/chapter-2.html';

        const container = document.createElement('div');
        container.id = 'chapter-content';
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Đoạn kết chương một ngắn để kích hoạt tải trước ngay.';
        container.appendChild(span);

        const nextLink = document.createElement('a');
        nextLink.setAttribute('rel', 'next');
        nextLink.setAttribute('href', '/chapter-2.html');
        nextLink.textContent = 'Chương sau';

        document.body.appendChild(container);
        document.body.appendChild(nextLink);

        let rejectDelayedFetch = null;
        let resolveSecondFetch = null;
        let fetchCount = 0;
        sandbox.network.addRoute('/chapter-2.html', () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                return new Promise((_, reject) => {
                    rejectDelayedFetch = () => reject(new Error('Network interrupted while paused'));
                });
            }
            if (fetchCount === 2) {
                return new Promise((resolve) => {
                    resolveSecondFetch = () => resolve(new Response(`
                        <div id="chapter-content">
                            <p>${'Chương 2 tải lại thành công sau khi nhấn Tiếp tục. '.repeat(5)}</p>
                        </div>
                    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
                });
            }
            return new Response(`
                <div id="chapter-content">
                    <p>${'Chương 2 dự phòng. '.repeat(5)}</p>
                </div>
            `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });

        const origConnect = chrome.runtime.connect.bind(chrome.runtime);
        const watchPorts = [];
        chrome.runtime.connect = (opts) => {
            const p = origConnect(opts);
            if (opts && opts.name === 'stv-preload-stream') {
                watchPorts.push(p);
            }
            return p;
        };

        await STV_TTSController.start({ engine: 'webspeech', preloadLeadSec: 60, autoNextChapter: true });
        await new Promise((r) => setTimeout(r, 30));

        assert.strictEqual(STV_TTSController.getState().preloadState, 'loading', 'Preload should be loading while fetch is pending');
        assert.strictEqual(watchPorts.length, 1, 'Should open initial preload watch port');

        // 1. User pauses; preload fails mid-pause -> must NOT enter retry loop while paused
        STV_TTSController.togglePauseResume();
        assert.strictEqual(STV_TTSController.getState().isPaused, true);
        rejectDelayedFetch();
        await new Promise((r) => setTimeout(r, 40));

        assert.strictEqual(fetchCount, 1, 'Must not retry preload in a loop while paused');
        assert.strictEqual(STV_TTSController.getState().preloadState, 'error');

        // Simulate browser discarding paused WebSpeech utterance during long pause
        speechSynthesis.queue.length = 0;
        speechSynthesis.speaking = false;
        speechSynthesis.paused = false;

        // 2. Resume -> must replay current segment AND re-trigger preload (fetch #2)
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 40));

        assert.strictEqual(STV_TTSController.getState().isPaused, false);
        assert.strictEqual(speechSynthesis.speaking, true, 'WebSpeech must resume cleanly after long pause');
        assert.strictEqual(fetchCount, 2, 'Resuming must re-trigger interrupted preload');
        assert.strictEqual(watchPorts.length, 2, 'Should open new preload watch port on retry');

        // 3. Pause again while fetch #2 is in-flight and simulate watchPort disconnecting mid-pause
        STV_TTSController.togglePauseResume();
        assert.strictEqual(STV_TTSController.getState().isPaused, true);
        watchPorts[1].disconnect();
        await new Promise((r) => setTimeout(r, 30));
        assert.notStrictEqual(STV_TTSController.getState().preloadState, 'ready', 'Must not stay ready if watchPort disconnected before completion');

        // Resume -> re-subscribes watchPort to in-flight preload, then fetch #2 completes
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 30));
        assert.strictEqual(watchPorts.length, 3, 'Resuming after watchPort disconnect must re-subscribe to preload');
        resolveSecondFetch();
        await new Promise((r) => setTimeout(r, 50));

        assert.strictEqual(STV_TTSController.getState().preloadState, 'ready', 'Preload must reach ready after resume');

        // Verify completed preload entry was persisted to chrome.storage.session
        const sessionAll = await chrome.storage.session.get(null);
        const sessionKey = 'stv_preload_1|' + chapter2Url;
        assert.ok(sessionAll[sessionKey], 'Completed preload entry must be persisted to chrome.storage.session');
        assert.strictEqual(sessionAll[sessionKey].status, 'ready');

        // User pauses again for a long time (unlike Stop, Pause must keep the preloaded chapter in session storage)
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 15));
        const savedSession = Object.fromEntries(chrome.storage.session._getRawStore().entries());
        assert.ok(savedSession[sessionKey], 'Pausing must NOT delete preloaded chapter from session storage');
        STV_TTSController.stop();

        // 4. Simulate MV3 Service Worker cold restart (fresh background.js RAM, session storage preserved)
        teardownSandbox();
        sandbox = setupSandbox({
            window: { url: 'https://novel.test/chapter-1.html' },
            chrome: {
                initialStorage: {
                    ttsAutoNextChapter: true,
                    apikey: 'sk-or-v1-valid-key',
                    'stv_selector_novel.test': '#chapter-content'
                },
                initialSessionStorage: savedSession,
                initialPermissions: ['storage', 'activeTab', 'scripting'],
                initialOrigins: ['https://novel.test/*'],
                initialTabs: [
                    { id: 1, active: true, url: 'https://novel.test/chapter-1.html', status: 'complete' }
                ]
            }
        });

        let postRestartFetchCount = 0;
        sandbox.network.addRoute('/chapter-2.html', () => {
            postRestartFetchCount += 1;
            return new Response('Should not refetch', { status: 500 });
        });

        const verifyRes = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: chapter2Url,
            mode: 'translate'
        });
        assert.strictEqual(verifyRes.ok, true);
        assert.strictEqual(verifyRes.status, 'ready', 'Restarted SW must restore ready preload from session storage');
        assert.strictEqual(verifyRes.reused, true, 'Restarted SW must reuse restored preload without re-fetching');
        assert.strictEqual(postRestartFetchCount, 0, 'Must not re-fetch chapter after restoring from session storage');

        // Verify navigating & subscribing to stv-preload-stream on restarted SW serves the restored snapshot
        const navRes = await chrome.runtime.sendMessage({
            action: 'navigate_next_chapter',
            url: chapter2Url,
            mode: 'translate'
        });
        assert.strictEqual(navRes.ok, true);
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        await new Promise((r) => setTimeout(r, 10));
        const snap = await new Promise((resolve) => {
            port.onMessage.addListener((m) => { if (m && m.type === 'snapshot') resolve(m); });
            port.postMessage({ type: 'subscribe', preloadId: verifyRes.preloadId });
        });
        assert.strictEqual(snap.done, true);
        assert.ok(snap.origChunks.length > 0, 'Restored preload snapshot must include extracted chapter chunks');
        try { port.disconnect(); } catch {}
    });

    it('Scenario 4e: long pause during VieNeu TTS stream & prefetch avoids infinite loop/error and recovers on resume', async () => {
        const container = document.createElement('div');
        container.id = 'chapter-content';
        ['Câu thứ nhất đang phát dở dang.', 'Câu thứ hai đang chờ nạp trước.', 'Câu thứ ba tiếp theo.'].forEach((txt) => {
            const line = document.createElement('span');
            line.className = 'stv-line';
            line.textContent = txt;
            container.appendChild(line);
        });
        document.body.appendChild(container);

        const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, cb) => {
            if (msg && msg.action === 'get_tts_runtime_config') {
                const resp = { ok: true, data: { ttsEngine: 'vieneu', ttsAutoNextChapter: false } };
                if (cb) cb(resp);
                return Promise.resolve(resp);
            }
            return origSendMessage(msg, cb);
        };

        const origConnect = chrome.runtime.connect.bind(chrome.runtime);
        const ttsPorts = [];
        chrome.runtime.connect = (opts) => {
            if (opts && opts.name === 'stv-tts-stream') {
                const messageListeners = new Set();
                const disconnectListeners = new Set();
                const mockTtsPort = {
                    name: 'stv-tts-stream',
                    messages: [],
                    disconnected: false,
                    onMessage: {
                        addListener: (fn) => messageListeners.add(fn),
                        removeListener: (fn) => messageListeners.delete(fn)
                    },
                    onDisconnect: {
                        addListener: (fn) => disconnectListeners.add(fn),
                        removeListener: (fn) => disconnectListeners.delete(fn)
                    },
                    postMessage: (m) => { mockTtsPort.messages.push(m); },
                    disconnect: () => {
                        if (mockTtsPort.disconnected) return;
                        mockTtsPort.disconnected = true;
                        for (const fn of disconnectListeners) fn();
                    },
                    simulateServerDisconnect: () => {
                        if (mockTtsPort.disconnected) return;
                        mockTtsPort.disconnected = true;
                        for (const fn of disconnectListeners) fn();
                    },
                    simulateServerMessage: (m) => {
                        for (const fn of messageListeners) fn(m);
                    }
                };
                ttsPorts.push(mockTtsPort);
                return mockTtsPort;
            }
            return origConnect(opts);
        };

        const startRes = await STV_TTSController.start({ engine: 'vieneu', autoNextChapter: false });
        assert.strictEqual(startRes.ok, true);
        assert.strictEqual(ttsPorts.length, 1, 'Initial segment port must be connected');

        // Complete segment 1 immediately so prefetch starts for segment 2
        const silentPcm = Buffer.from(new Uint8Array(new Int16Array(480).buffer)).toString('base64');
        ttsPorts[0].simulateServerMessage({ type: 'chunk', audio: silentPcm, sampleRate: 48000 });
        ttsPorts[0].simulateServerMessage({ type: 'done' });
        await new Promise((r) => setTimeout(r, 15));

        assert.strictEqual(ttsPorts.length, 2, 'Prefetch port for segment 2 must be opened');

        // Pause while segment 2 is prefetching, then disconnect prefetch port (SW idle sleep)
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(STV_TTSController.getState().isPaused, true);

        const portCountAtPause = ttsPorts.length;
        ttsPorts[1].simulateServerDisconnect();
        await new Promise((r) => setTimeout(r, 40));

        assert.strictEqual(ttsPorts.length, portCountAtPause, 'Prefetch must NOT spin up an infinite retry loop while paused');
        assert.strictEqual(STV_TTSController.getState().isPlaying, true, 'Player must remain active while paused');
        assert.strictEqual(STV_TTSController.getState().isPaused, true, 'Player must remain paused without crashing');

        // Resume -> prefetch must recover for segment 2 cleanly
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(STV_TTSController.getState().isPaused, false);
        assert.strictEqual(ttsPorts.length, portCountAtPause + 1, 'Resuming must re-initiate prefetch for segment 2');

        // Now test active stream disconnecting during a second long pause on segment 2
        STV_TTSController.jumpToSegment(1);
        await new Promise((r) => setTimeout(r, 15));
        const activePortIdx = ttsPorts.length - 1;
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 10));

        ttsPorts[activePortIdx].simulateServerDisconnect();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(STV_TTSController.getState().isPlaying, true, 'Active stream disconnect during pause must not kill playback with error');
        assert.strictEqual(STV_TTSController.getState().isPaused, true);

        // Resume -> active segment must automatically replay cleanly
        const countBeforeResume2 = ttsPorts.length;
        STV_TTSController.togglePauseResume();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(STV_TTSController.getState().isPaused, false);
        assert.strictEqual(ttsPorts.length, countBeforeResume2 + 1, 'Resuming after active stream disconnect during pause must replay segment');

        STV_TTSController.stop();
    });

    it('Scenario 4f: defers AudioContext creation until user gesture when autoplay is blocked and avoids self-pausing on play click', async () => {
        const container = document.createElement('div');
        container.id = 'chapter-content';
        const line = document.createElement('span');
        line.className = 'stv-line';
        line.textContent = 'Chương mới vừa mở ra và đang chờ tương tác người dùng.';
        container.appendChild(line);
        document.body.appendChild(container);

        navigator.userActivation = { isActive: false, hasBeenActive: false };

        let audioCtxCreatedCount = 0;
        const OrigAudioContext = globalThis.AudioContext;
        class CountingAudioContext extends OrigAudioContext {
            constructor(opts) {
                audioCtxCreatedCount += 1;
                super(opts);
            }
        }
        globalThis.AudioContext = CountingAudioContext;
        window.AudioContext = CountingAudioContext;

        const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, cb) => {
            if (msg && msg.action === 'get_tts_runtime_config') {
                const resp = { ok: true, data: { ttsEngine: 'vieneu', ttsAutoNextChapter: false } };
                if (cb) cb(resp);
                return Promise.resolve(resp);
            }
            return origSendMessage(msg, cb);
        };

        const origConnect = chrome.runtime.connect.bind(chrome.runtime);
        let ttsPortCount = 0;
        chrome.runtime.connect = (opts) => {
            if (opts && opts.name === 'stv-tts-stream') {
                ttsPortCount += 1;
            }
            return origConnect(opts);
        };

        const silentPcm = Buffer.from(new Uint8Array(new Int16Array(480).buffer)).toString('base64');
        let closeTtsStream = null;
        sandbox.network.addRoute('/v1/audio/speech', () => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: silentPcm, sample_rate: 48000 })}\n\n`));
                    closeTtsStream = () => {
                        try {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'speech.audio.done' })}\n\n`));
                            controller.close();
                        } catch {}
                    };
                }
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        });

        const startRes = await STV_TTSController.start({ autoTriggered: true, engine: 'vieneu', autoNextChapter: false });
        assert.strictEqual(startRes.ok, true);
        assert.strictEqual(startRes.autoplayBlocked, true);
        assert.strictEqual(STV_TTSController.getState().autoplayBlocked, true);
        assert.strictEqual(audioCtxCreatedCount, 0, 'Must NOT create AudioContext before user activation');
        assert.strictEqual(ttsPortCount, 0, 'Must wait for user gesture before starting audio stream');

        const host = document.getElementById('stv-tts-root');
        const toggleBtn = host.shadowRoot.querySelector('[data-act="toggle"]');
        assert.ok(toggleBtn, 'Toggle button must exist in shadow DOM');
        assert.strictEqual(toggleBtn.textContent, '▶', 'Button must display ▶ while waiting for user gesture');

        // Simulate real browser click sequence on ▶ button: pointerdown (unlocks autoplay) -> click (must NOT pause)
        navigator.userActivation = { isActive: true, hasBeenActive: true };
        document.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
        toggleBtn.click();

        await new Promise((r) => setTimeout(r, 25));

        assert.strictEqual(audioCtxCreatedCount, 1, 'AudioContext must be created upon user gesture');
        assert.strictEqual(STV_TTSController.getState().autoplayBlocked, false);
        assert.strictEqual(STV_TTSController.getState().isPlaying, true);
        assert.strictEqual(STV_TTSController.getState().isPaused, false, 'Click after pointerdown must NOT immediately toggle to paused');
        assert.strictEqual(ttsPortCount, 1, 'Must start streaming first segment after user gesture');
        assert.strictEqual(toggleBtn.textContent, '⏸', 'Button must switch to ⏸ once playing');

        if (closeTtsStream) closeTtsStream();
        STV_TTSController.stop();
    });
});
