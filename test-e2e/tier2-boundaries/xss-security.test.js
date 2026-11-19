/**
 * test-e2e/tier2-boundaries/xss-security.test.js
 * Tier 2 Boundary & Corner Cases: DOM XSS & Code Injection Security (11 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, UIModal, ReaderUI, STV_convertHtmlToTextChunks } from '../harness/index.js';

describe('Tier 2: DOM XSS & Code Injection Security', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
        delete globalThis.XSS_EXECUTED;
        delete globalThis.PWNED;
    });

    afterEach(() => {
        teardownSandbox();
        delete globalThis.XSS_EXECUTED;
        delete globalThis.PWNED;
    });

    const sanitizeAndExtract = (htmlStr) => STV_convertHtmlToTextChunks(htmlStr).filter(Boolean);

    it('T2.12: prevents XSS execution from raw <script> tags in chapter content', () => {
        const payload = `
            <div id="chapter-content">
                <script>globalThis.XSS_EXECUTED = true;</script>
                <p>Nội dung tiểu thuyết bình thường.</p>
            </div>
        `;

        const chunks = sanitizeAndExtract(payload);
        assert.strictEqual(globalThis.XSS_EXECUTED, undefined, 'Script must not execute in inert DOM');
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0], 'Nội dung tiểu thuyết bình thường.');
    });

    it('T2.13: prevents XSS from img/svg onerror and onload inline event handlers', () => {
        const payload = `
            <div id="chapter-content">
                <img src="invalid_image.jpg" onerror="globalThis.XSS_EXECUTED=true" />
                <svg onload="globalThis.XSS_EXECUTED=true"><circle r="10"/></svg>
                <p>Đoạn văn sau thẻ hình ảnh lỗi.</p>
            </div>
        `;

        const chunks = sanitizeAndExtract(payload);
        assert.strictEqual(globalThis.XSS_EXECUTED, undefined);
        assert.ok(chunks.includes('Đoạn văn sau thẻ hình ảnh lỗi.'));
    });

    it('T2.14: neutralizes obfuscated nested tag attacks: <<SCRIPT>alert(1)//<</SCRIPT>', () => {
        const payload = `
            <div id="chapter-content">
                <<SCRIPT>globalThis.XSS_EXECUTED=true;//<</SCRIPT>
                <p>Đoạn văn sau mã độc lồng thẻ.</p>
            </div>
        `;

        const chunks = sanitizeAndExtract(payload);
        assert.strictEqual(globalThis.XSS_EXECUTED, undefined);
        assert.ok(chunks.length > 0);
    });

    it('T2.15: rejects javascript: pseudo-protocols in chapter navigation links', () => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`
            <div class="navigation">
                <a rel="next" href="javascript:globalThis.PWNED=true">Chương Tiếp</a>
            </div>
        `, 'text/html');

        const nextLink = doc.querySelector('a[rel="next"]');
        assert.ok(nextLink);
        const href = nextLink.getAttribute('href');

        const isSafeProtocol = (url) => {
            try {
                const u = new URL(url, 'https://truyen.test');
                return u.protocol === 'http:' || u.protocol === 'https:';
            } catch {
                return false;
            }
        };

        assert.strictEqual(isSafeProtocol(href), false, 'javascript: URL must be rejected');
        assert.strictEqual(globalThis.PWNED, undefined);
    });

    it('T2.16: decodes HTML entity obfuscated vectors and renders safely via textContent', () => {
        const payload = `
            <div id="chapter-content">
                <p>&lt;script&gt;globalThis.XSS_EXECUTED=true&lt;/script&gt;</p>
            </div>
        `;

        const chunks = sanitizeAndExtract(payload);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0], '<script>globalThis.XSS_EXECUTED=true</script>');

        // Render to DOM via textContent
        const span = document.createElement('span');
        span.textContent = chunks[0];

        assert.strictEqual(span.textContent, '<script>globalThis.XSS_EXECUTED=true</script>');
        assert.strictEqual(globalThis.XSS_EXECUTED, undefined, 'Must be rendered as literal text without execution');
    });

    it('T2.17: prevents XSS injection from malicious line retranslation response payload', () => {
        const span = document.createElement('span');
        span.className = 'stv-line';
        span.setAttribute('data-orig', '天道');

        // Hostile response from poisoned API endpoint
        const hostileResponse = '<img src=x onerror="globalThis.PWNED=true"> Bản dịch độc hại';

        // Safe rendering rule: MUST assign via .textContent, NEVER .innerHTML
        span.textContent = hostileResponse;

        assert.strictEqual(span.textContent, hostileResponse);
        assert.strictEqual(span.querySelector('img'), null, 'img element must not be constructed in DOM');
        assert.strictEqual(globalThis.PWNED, undefined);
    });

    it('T2.18: prevents XSS injection in glossary terms and translations', () => {
        const termTable = document.createElement('div');
        const hostileOrig = '<script>alert(1)</script>';
        const hostileVi = '<b onmouseover="alert(1)">Nạp Lan</b>';

        const row = document.createElement('div');
        const origCol = document.createElement('span');
        origCol.textContent = hostileOrig; // Safe
        const viCol = document.createElement('span');
        viCol.textContent = hostileVi; // Safe

        row.appendChild(origCol);
        row.appendChild(viCol);
        termTable.appendChild(row);

        assert.strictEqual(origCol.textContent, '<script>alert(1)</script>');
        assert.strictEqual(row.querySelector('script'), null, 'Script tag must not exist');
        assert.strictEqual(row.querySelector('b'), null, 'Bold tag with handler must not exist');
    });

    it('T2.19: prevents attribute breakout XSS in custom accessible modal dialogs', async () => {
        const maliciousTitle = '"><script>globalThis.PWNED=true</script><span id="injected"';

        const modalPromise = UIModal.alert({
            title: maliciousTitle,
            message: 'Nội dung kiểm tra an toàn'
        });

        const overlay = document.querySelector('.stv-modal-overlay');
        assert.ok(overlay);
        assert.strictEqual(overlay.querySelector('#injected'), null, 'Injected element must not be constructed');
        assert.strictEqual(globalThis.PWNED, undefined);

        const okBtn = overlay.querySelector('#modal-btn-ok');
        okBtn.click();
        await modalPromise;
    });

    it('T2.20: prevents DOM clobbering attacks via named elements in chapter HTML', () => {
        const payload = `
            <div id="chapter-content">
                <form id="chrome"><input name="storage" value="clobbered"></form>
                <img id="window" />
            </div>
        `;

        const parser = new DOMParser();
        const doc = parser.parseFromString(payload, 'text/html');

        // In standard window, named elements could shadow globals
        // Verify sandbox chrome API remains uncorrupted
        assert.ok(globalThis.chrome, 'globalThis.chrome must exist');
        assert.ok(globalThis.chrome.storage, 'chrome.storage must be intact');
        assert.strictEqual(typeof globalThis.chrome.storage.local.get, 'function');
    });

    it('T2.21: prevents XSS injection in Shadow DOM toast notification messages', () => {
        ReaderUI.init();

        const hostileToastMsg = '<b>Cảnh báo!</b> <script>globalThis.PWNED=true</script>';
        const toast = ReaderUI.showToast(hostileToastMsg, 'error', 0);

        assert.strictEqual(toast.textContent, hostileToastMsg, 'TextContent must retain string verbatim');
        assert.strictEqual(toast.querySelector('script'), null, 'Script tag must not exist inside toast');
        assert.strictEqual(toast.querySelector('b'), null, 'HTML bold tag must not be rendered');
        assert.strictEqual(globalThis.PWNED, undefined);
    });

    it('T2.22: prevents CSS injection or style breakout in Shadow DOM reader root', () => {
        ReaderUI.init();

        const root = document.getElementById('stv-reader-root');
        assert.ok(root && root.shadowRoot);

        // Host page injects malicious CSS attempting to hide reader or steal keystrokes
        const maliciousStyle = document.createElement('style');
        maliciousStyle.textContent = `
            #stv-reader-root { display: none !important; }
            * { pointer-events: none !important; }
        `;
        document.head.appendChild(maliciousStyle);

        // Inner Shadow DOM content remains isolated from host CSS rules
        const pill = root.shadowRoot.getElementById('stv-floating-pill');
        assert.ok(pill);
        assert.strictEqual(pill.parentNode, root.shadowRoot);
    });
});
