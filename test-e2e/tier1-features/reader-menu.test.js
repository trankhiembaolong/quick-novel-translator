/**
 * test-e2e/tier1-features/reader-menu.test.js
 * Feature 5: Floating Reader Menu & Shadow DOM Encapsulation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, ReaderUI } from '../harness/index.js';

describe('Feature 5: Floating Reader Menu & Shadow DOM Encapsulation', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.25: mounts #stv-reader-root on document.body with open Shadow DOM', () => {
        const { root, shadow } = ReaderUI.init();

        assert.ok(root, 'Root element must exist');
        assert.strictEqual(root.id, 'stv-reader-root');
        assert.ok(shadow, 'Shadow root must exist');
        assert.strictEqual(shadow.mode, 'open', 'Shadow DOM mode must be open');
        assert.strictEqual(root.shadowRoot, shadow);
    });

    it('T1.26: renders compact 38x38 px floating icon docked to margin', () => {
        const { shadow } = ReaderUI.init();
        const pill = shadow.getElementById('stv-floating-pill');

        assert.ok(pill, 'Floating pill button must exist');
        const rect = pill.getBoundingClientRect();
        assert.strictEqual(rect.width, 38, 'Floating pill width must be 38px');
        assert.strictEqual(rect.height, 38, 'Floating pill height must be 38px');
    });

    it('T1.27: clicking floating icon toggles expanding popover reader menu', () => {
        const { shadow } = ReaderUI.init();
        const pill = shadow.getElementById('stv-floating-pill');
        const menu = shadow.getElementById('stv-popover-menu');

        assert.ok(menu, 'Popover menu must exist');
        assert.strictEqual(menu.classList.contains('open'), false, 'Menu initially closed');

        // Click 1: opens
        pill.click();
        assert.strictEqual(menu.classList.contains('open'), true, 'Menu must open on click');

        // Click 2: closes
        pill.click();
        assert.strictEqual(menu.classList.contains('open'), false, 'Menu must close on second click');
    });

    it('T1.28: Original / Translated toggle switches display mode between data-orig and translated text', () => {
        const { shadow } = ReaderUI.init();

        // Setup novel lines in document body
        const container = document.createElement('div');
        container.id = 'chapter-content';
        container.innerHTML = `
            <span class="stv-line" data-orig="你好世界">Chào thế giới</span>
            <span class="stv-line" data-orig="天道无情">Thiên đạo vô tình</span>
        `;
        document.body.appendChild(container);

        const btnToggleOrig = shadow.getElementById('btn-toggle-orig');
        const lines = document.querySelectorAll('.stv-line');

        // Initial translated state
        assert.strictEqual(lines[0].textContent, 'Chào thế giới');
        assert.strictEqual(lines[1].textContent, 'Thiên đạo vô tình');

        // Click to switch to Original
        btnToggleOrig.click();
        assert.strictEqual(lines[0].textContent, '你好世界', 'Line 0 must display data-orig');
        assert.strictEqual(lines[1].textContent, '天道无情', 'Line 1 must display data-orig');

        // Click again to restore Translated
        btnToggleOrig.click();
        assert.strictEqual(lines[0].textContent, 'Chào thế giới', 'Line 0 must restore translation');
        assert.strictEqual(lines[1].textContent, 'Thiên đạo vô tình', 'Line 1 must restore translation');
    });

    it('T1.29: Font size controls A- and A+ adjust reader font size dynamically', () => {
        const { shadow } = ReaderUI.init();

        const line = document.createElement('span');
        line.className = 'stv-line';
        line.textContent = 'Dòng đọc truyện';
        document.body.appendChild(line);

        const btnFontInc = shadow.getElementById('btn-font-inc');
        const btnFontDec = shadow.getElementById('btn-font-dec');

        // Click A+ -> 24px
        btnFontInc.click();
        assert.strictEqual(line.style.fontSize, '24px');

        // Click A+ again -> 26px
        btnFontInc.click();
        assert.strictEqual(line.style.fontSize, '26px');

        // Click A- -> 24px
        btnFontDec.click();
        assert.strictEqual(line.style.fontSize, '24px');
    });

    it('T1.30: host page CSS rules cannot penetrate Shadow DOM boundary', () => {
        const { shadow } = ReaderUI.init();

        // Host page injects an aggressive reset style
        const hostStyle = document.createElement('style');
        hostStyle.textContent = '* { display: none !important; color: red !important; }';
        document.head.appendChild(hostStyle);

        // Reader controls inside Shadow DOM remain intact
        const pill = shadow.getElementById('stv-floating-pill');
        assert.ok(pill);
        assert.strictEqual(pill.parentNode, shadow, 'Pill resides strictly inside Shadow DOM');
        assert.strictEqual(document.querySelector('#stv-floating-pill'), null, 'Host querySelector cannot pierce shadow boundary');
    });
});
