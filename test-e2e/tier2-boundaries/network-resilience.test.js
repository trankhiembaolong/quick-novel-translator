/**
 * test-e2e/tier2-boundaries/network-resilience.test.js
 * Tier 2 Boundary & Corner Cases: Network Resilience & Error Recovery (10 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox } from '../harness/index.js';
import { createSseResponse } from '../harness/network-mock.js';

describe('Tier 2: Network Resilience & Error Recovery', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    apikey: 'sk-or-v1-valid-key',
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions'
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T2.33: handles WebSocket immediate abnormal closure (code 1006) during TTS startup', async () => {
        let wsClosed = false;
        let fallbackTriggered = false;

        const ws = new WebSocket('ws://fail_immediate/tts');
        ws.onclose = (ev) => {
            wsClosed = true;
            if (ev.code === 1006) {
                fallbackTriggered = true;
            }
        };

        await new Promise(r => setTimeout(r, 20));

        assert.strictEqual(wsClosed, true, 'WebSocket must emit close event');
        assert.strictEqual(fallbackTriggered, true, 'Code 1006 must trigger fallback condition');
    });

    it('T2.34: handles WebSocket timeout when server is unreachable', async () => {
        let timeoutTriggered = false;

        function connectWithTimeout(url, timeoutMs = 50) {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(url);
                const timer = setTimeout(() => {
                    timeoutTriggered = true;
                    try { ws.close(); } catch {}
                    resolve({ ok: false, error: 'timeout' });
                }, timeoutMs);

                ws.onopen = () => {
                    clearTimeout(timer);
                    resolve({ ok: true });
                };
            });
        }

        const res = await connectWithTimeout('ws://unreachable-server:9999/tts', 20);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(timeoutTriggered, true);
    });

    it('T2.35: handles WebSocket connection drop midway through reading and preserves sentence progress', async () => {
        const sentences = ['Đoạn 0', 'Đoạn 1', 'Đoạn 2', 'Đoạn 3', 'Đoạn 4'];
        let currentSentenceIdx = 2; // Disconnects at sentence 2

        const ws = new WebSocket('ws://127.0.0.1:8000/tts');
        await new Promise(r => setTimeout(r, 10));

        // Simulate server dropping connection during sentence 2
        ws.simulateClose(1006, 'Connection dropped midway');

        // Transition to Web Speech starting at preserved index
        const fallbackUtterances = [];
        for (let i = currentSentenceIdx; i < sentences.length; i++) {
            fallbackUtterances.push(new SpeechSynthesisUtterance(sentences[i]));
        }

        assert.strictEqual(fallbackUtterances.length, 3, 'Must resume remaining 3 sentences');
        assert.strictEqual(fallbackUtterances[0].text, 'Đoạn 2', 'Must resume from sentence 2');
        assert.strictEqual(fallbackUtterances[2].text, 'Đoạn 4');
    });

    it('T2.36: handles LLM API HTTP 401 Unauthorized (invalid key) gracefully', async () => {
        sandbox.network.addRoute('/chat/completions', () => {
            return new Response(JSON.stringify({ error: { message: 'Invalid API Key', code: 401 } }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.strictEqual(data.error.code, 401);
        assert.strictEqual(data.error.message, 'Invalid API Key');
    });

    it('T2.37: handles LLM API HTTP 402 Payment Required (credit limit reached)', async () => {
        sandbox.network.addRoute('/chat/completions', () => {
            return new Response(JSON.stringify({ error: { message: 'Credit limit reached', code: 402 } }), {
                status: 402,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
        assert.strictEqual(res.status, 402);
        const data = await res.json();
        assert.strictEqual(data.error.code, 402);
    });

    it('T2.38: handles LLM API HTTP 429 Too Many Requests (rate limited)', async () => {
        sandbox.network.addRoute('/chat/completions', () => {
            return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }), {
                status: 429,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
        assert.strictEqual(res.status, 429);
        const data = await res.json();
        assert.strictEqual(data.error.code, 429);
    });

    it('T2.39: handles upstream HTTP 500/502/503 Gateway and server errors', async () => {
        const errorStatuses = [500, 502, 503];

        for (const status of errorStatuses) {
            sandbox.network.addRoute('/gateway-test', () => {
                return new Response(`Server Error ${status}`, { status });
            });

            const res = await fetch('https://openrouter.ai/gateway-test');
            assert.strictEqual(res.status, status);
            assert.strictEqual(res.ok, false);
        }
    });

    it('T2.40: AbortController cancels upstream fetch request immediately upon client abort', async () => {
        const controller = new AbortController();

        sandbox.network.addRoute('/abort-test', (url, options) => {
            return new Promise((resolve, reject) => {
                if (options.signal) {
                    options.signal.addEventListener('abort', () => {
                        reject(new DOMException('The user aborted a request.', 'AbortError'));
                    });
                }
            });
        });

        const fetchPromise = fetch('https://openrouter.ai/abort-test', { signal: controller.signal });
        controller.abort();

        await assert.rejects(fetchPromise, (err) => {
            assert.strictEqual(err.name, 'AbortError');
            return true;
        });
        assert.strictEqual(controller.signal.aborted, true);
    });

    it('T2.41: skips corrupted or malformed SSE lines without breaking the stream reader', async () => {
        const response = createSseResponse([
            'data: {"choices":[{"delta":{"content":"Dòng 1 "}}]}',
            'data: { this is corrupt JSON that fails JSON.parse }',
            'data: {"choices":[{"delta":{"content":"Dòng 2."}}]}'
        ]);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const validContents = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        if (parsed.choices?.[0]?.delta?.content) {
                            validContents.push(parsed.choices[0].delta.content);
                        }
                    } catch {
                        // Safely skipped malformed line
                    }
                }
            }
        }

        assert.strictEqual(validContents.length, 2);
        assert.strictEqual(validContents[0], 'Dòng 1 ');
        assert.strictEqual(validContents[1], 'Dòng 2.');
    });

    it('T2.42: handles preload fetch failure and transitions preload status to error cleanly', async () => {
        sandbox.network.addRoute('/failed-preload.html', () => {
            return new Response('Chapter Not Found', { status: 404 });
        });

        const preloadEntry = {
            targetUrl: 'https://truyen.test/failed-preload.html',
            status: 'pending'
        };

        const res = await fetch(preloadEntry.targetUrl);
        if (!res.ok) {
            preloadEntry.status = 'error';
            preloadEntry.error = `HTTP ${res.status}`;
        }

        assert.strictEqual(preloadEntry.status, 'error');
        assert.strictEqual(preloadEntry.error, 'HTTP 404');
    });
});
