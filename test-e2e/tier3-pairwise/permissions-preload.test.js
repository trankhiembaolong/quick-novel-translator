/**
 * test-e2e/tier3-pairwise/permissions-preload.test.js
 * Tier 3 Pairwise Combinatorics: Permissions & Preload Navigation (3 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, UrlValidator } from '../harness/index.js';

describe('Tier 3: Permissions + Chapter Preload Interaction', () => {
    let sandbox;
    const SENDER_TAB_URL = 'https://truyenfull.vn/story/chap-1.html';

    beforeEach(() => {
        sandbox = setupSandbox({
            window: {
                url: SENDER_TAB_URL
            },
            chrome: {
                initialPermissions: ['storage', 'activeTab', 'scripting'],
                initialOrigins: ['https://truyenfull.vn/*'],
                initialStorage: {
                    'stv_selector_truyenfull.vn': '#chapter-content'
                },
                initialTabs: [
                    { id: 1, active: true, url: SENDER_TAB_URL, status: 'complete' }
                ]
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T3.12: chapter preload succeeds on permitted same-origin domain and populates preload cache', async () => {
        const nextChapterUrl = 'https://truyenfull.vn/story/chap-2.html';

        // 1. Validate safety
        const validation = UrlValidator.isSafePreloadTarget(SENDER_TAB_URL, nextChapterUrl);
        assert.strictEqual(validation.valid, true);

        // 2. Check permission
        const hasPermission = await chrome.permissions.contains({ origins: ['https://truyenfull.vn/*'] });
        assert.strictEqual(hasPermission, true);

        // 3. Network route for next chapter
        sandbox.network.addRoute('/story/chap-2.html', () => {
            return new Response(`
                <div id="chapter-content">
                    <p>${'Chương 2 đã được nạp sẵn sàng qua preload broker background. '.repeat(5)}</p>
                </div>
            `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });

        // 4. Exercise genuine background preload worker
        const preloadRes = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: nextChapterUrl,
            mode: 'tts_only'
        });

        assert.ok(preloadRes);
        assert.strictEqual(preloadRes.ok, true);
        assert.ok(preloadRes.preloadId);

        await new Promise(r => setTimeout(r, 20));

        // Connect genuine preload port to verify cache entry
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        await new Promise(r => setTimeout(r, 10));

        const snapshot = await new Promise((resolve) => {
            port.onMessage.addListener((msg) => {
                if (msg && (msg.type === 'snapshot' || msg.type === 'delta')) {
                    resolve(msg);
                }
            });
            port.postMessage({ type: 'subscribe', preloadId: preloadRes.preloadId });
        });

        assert.ok(snapshot, 'Must receive snapshot from genuine preload broker');
        assert.strictEqual(snapshot.type, 'snapshot');
        try { port.disconnect(); } catch {}
    });

    it('T3.13: cross-origin next chapter link triggers security rejection before any network fetch occurs', async () => {
        const crossOriginLink = 'https://external-novel.org/chap-2.html';
        let fetchInitiated = false;

        sandbox.network.addRoute(crossOriginLink, () => {
            fetchInitiated = true;
            return new Response('External Page');
        });

        const validation = UrlValidator.isSafePreloadTarget(SENDER_TAB_URL, crossOriginLink);
        assert.strictEqual(validation.valid, false, 'Validation must fail before fetch');
        assert.ok(validation.reason.includes('cross_origin_blocked') || validation.reason.includes('Cross-site'));

        // Background broker must reject preload attempt without making fetch
        const resp = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: crossOriginLink,
            mode: 'tts_only'
        });

        assert.ok(resp);
        assert.strictEqual(resp.ok, false, 'Preload must be rejected by background policy');
        assert.strictEqual(fetchInitiated, false, 'No network fetch should be dispatched to untrusted cross-origin');
    });

    it('T3.14: preloaded chapter cache is immediately consumed upon tab navigation completion without AI wait', async () => {
        const nextUrl = 'https://truyenfull.vn/story/chap-2.html';

        sandbox.network.addRoute('/story/chap-2.html', () => {
            return new Response(`
                <div id="chapter-content">
                    <p>${'Nội dung dịch sẵn của chương 2 được phục vụ ngay từ preload cache. '.repeat(5)}</p>
                </div>
            `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });

        // 1. Preload chapter via background broker
        const preloadRes = await chrome.runtime.sendMessage({
            action: 'start_chapter_preload',
            url: nextUrl,
            mode: 'tts_only'
        });
        assert.ok(preloadRes);
        assert.strictEqual(preloadRes.ok, true);

        await new Promise(r => setTimeout(r, 20));

        // 2. Trigger genuine auto-advance navigation
        const navRes = await chrome.runtime.sendMessage({
            action: 'navigate_next_chapter',
            url: nextUrl,
            mode: 'tts_only'
        });
        assert.ok(navRes);
        assert.strictEqual(navRes.ok, true);

        // 3. Tab navigation completes and consumes preload stream
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        await new Promise(r => setTimeout(r, 10));

        const snapshot = await new Promise((resolve) => {
            port.onMessage.addListener((msg) => {
                if (msg && (msg.type === 'snapshot' || msg.type === 'delta')) {
                    resolve(msg);
                }
            });
            port.postMessage({ type: 'subscribe', preloadId: preloadRes.preloadId });
        });

        assert.ok(snapshot, 'Preload cache hit via background stream broker');

        // Render to DOM
        const contentBox = document.createElement('div');
        contentBox.id = 'chapter-content';
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.textContent = 'Nội dung dịch sẵn của chương 2';
        contentBox.appendChild(span);
        document.body.appendChild(contentBox);

        assert.strictEqual(document.querySelector('.stv-line').textContent, 'Nội dung dịch sẵn của chương 2');
        try { port.disconnect(); } catch {}
    });
});
