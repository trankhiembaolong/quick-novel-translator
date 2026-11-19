/**
 * test-e2e/harness/network-mock.js
 * Interceptable Fetch, SSE Stream Generator, and Mock WebSocket.
 */

export class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    static instances = [];

    constructor(url, protocols) {
        this.url = String(url);
        this.protocols = protocols;
        this.readyState = MockWebSocket.CONNECTING;
        this.sentMessages = [];
        this.listeners = new Map();

        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;

        MockWebSocket.instances.push(this);

        // Auto-connect on next tick unless configured to fail or hang
        queueMicrotask(() => {
            if (this.url.includes('fail_immediate') || this.url.includes('invalid-ws')) {
                this.simulateError(new Error('WebSocket connection failed'));
                this.simulateClose(1006, 'Abnormal Closure');
            } else if (this.url.includes('unreachable') || this.url.includes('timeout') || this.url.includes('hang')) {
                // Do not auto-open: simulate unreachable server/timeout
            } else if (this.readyState === MockWebSocket.CONNECTING) {
                this.simulateOpen();
            }
        });
    }

    addEventListener(event, cb) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(cb);
    }

    removeEventListener(event, cb) {
        if (this.listeners.has(event)) this.listeners.get(event).delete(cb);
    }

    dispatchEvent(ev) {
        const handler = this[`on${ev.type}`];
        if (typeof handler === 'function') {
            try { handler.call(this, ev); } catch (e) { console.error(e); }
        }
        const set = this.listeners.get(ev.type);
        if (set) {
            for (const cb of Array.from(set)) {
                try { cb.call(this, ev); } catch (e) { console.error(e); }
            }
        }
    }

    send(data) {
        if (this.readyState !== MockWebSocket.OPEN) {
            throw new Error('WebSocket is not open: readyState ' + this.readyState);
        }
        this.sentMessages.push(data);

        // If message is a synthesis request, simulate audio chunk responses
        try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : null;
            if (parsed && parsed.action === 'synthesize') {
                queueMicrotask(() => {
                    this.simulateServerMessage(JSON.stringify({ type: 'audio_meta', sampleRate: 48000 }));
                    this.simulateServerMessage(new Float32Array(480).buffer);
                    this.simulateServerMessage(JSON.stringify({ type: 'done', sentenceIndex: parsed.index || 0 }));
                });
            }
        } catch {}
    }

    close(code = 1000, reason = 'Normal Closure') {
        if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) return;
        this.readyState = MockWebSocket.CLOSING;
        queueMicrotask(() => {
            this.readyState = MockWebSocket.CLOSED;
            this.dispatchEvent({ type: 'close', code, reason, wasClean: code === 1000 });
        });
    }

    simulateOpen() {
        if (this.readyState !== MockWebSocket.CONNECTING) return;
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent({ type: 'open' });
    }

    simulateServerMessage(data) {
        if (this.readyState !== MockWebSocket.OPEN) return;
        this.dispatchEvent({ type: 'message', data });
    }

    simulateError(error = new Error('WebSocket error')) {
        this.dispatchEvent({ type: 'error', error });
    }

    simulateClose(code = 1006, reason = 'Connection dropped') {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent({ type: 'close', code, reason, wasClean: code === 1000 });
    }
}

/**
 * Creates an SSE (Server-Sent Events) streaming Response
 */
export function createSseResponse(chunks, options = {}) {
    const encoder = new TextEncoder();
    const status = options.status || 200;
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...(options.headers || {})
    };

    let cancelled = false;

    const stream = new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                if (cancelled) break;
                if (typeof chunk === 'string') {
                    // Raw SSE line
                    controller.enqueue(encoder.encode(chunk.endsWith('\n') ? chunk : `${chunk}\n\n`));
                } else if (chunk && typeof chunk === 'object') {
                    // Delta token payload
                    const sseLine = `data: ${JSON.stringify({
                        id: 'chatcmpl-' + Math.random().toString(36).slice(2),
                        object: 'chat.completion.chunk',
                        created: Date.now(),
                        choices: [{ delta: chunk, index: 0, finish_reason: null }]
                    })}\n\n`;
                    controller.enqueue(encoder.encode(sseLine));
                }
            }
            if (!cancelled) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        },
        cancel() {
            cancelled = true;
        }
    });

    return new Response(stream, { status, headers });
}

/**
 * Network Mock Factory for intercepting fetch() calls
 */
export function createNetworkMock() {
    const routes = [];
    const requestLog = [];

    function addRoute(matcher, handler) {
        routes.unshift({ matcher, handler });
    }

    async function mockFetch(url, options = {}) {
        const urlStr = String(url);
        requestLog.push({ url: urlStr, options, timestamp: Date.now() });

        // Check configured routes
        for (const { matcher, handler } of routes) {
            const matches = typeof matcher === 'function' ? matcher(urlStr, options)
                : matcher instanceof RegExp ? matcher.test(urlStr)
                : urlStr.includes(matcher);

            if (matches) {
                return handler(urlStr, options);
            }
        }

        // Default mock responses for typical endpoints
        if (urlStr.includes('openrouter.ai') || urlStr.includes('/chat/completions')) {
            // Check for API key in headers
            const auth = (options.headers && (options.headers.Authorization || options.headers.authorization)) || '';
            if (auth.includes('invalid_key')) {
                return new Response(JSON.stringify({ error: { message: 'Invalid API key', code: 401 } }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (auth.includes('no_credits')) {
                return new Response(JSON.stringify({ error: { message: 'Credit limit reached', code: 402 } }), {
                    status: 402,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (auth.includes('rate_limited')) {
                return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }), {
                    status: 429,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Default streaming success response
            return createSseResponse([
                { content: 'Bản ' },
                { content: 'dịch ' },
                { content: 'thành ' },
                { content: 'công.' }
            ]);
        }

        // Default chapter html page
        if (urlStr.endsWith('.html') || urlStr.includes('/chap-')) {
            return new Response(`
                <!DOCTYPE html>
                <html>
                <head><title>Chương Tiếp Theo</title></head>
                <body>
                    <div id="chapter-content">
                        <p>Nội dung chương tiếp theo đã được tải về.</p>
                        <p>Nhân vật chính bước vào mật thất bí ẩn.</p>
                    </div>
                    <a rel="next" href="/chap-3.html">Chương 3</a>
                </body>
                </html>
            `, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        return new Response('Not Found', { status: 404 });
    }

    return {
        mockFetch,
        addRoute,
        createSseResponse,
        getRequestLog: () => [...requestLog],
        clearRequestLog: () => { requestLog.length = 0; }
    };
}
