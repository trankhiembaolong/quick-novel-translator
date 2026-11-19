/**
 * test-e2e/tier4-scenarios/novel-reading.test.js
 * Scenario 2: End-to-End Chapter Reading, Batch Streaming & Line Retranslation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, TranslationBroker, ReaderUI, STV_convertHtmlToTextChunks, STV_createStreamRenderer } from '../harness/index.js';
import { createSseResponse } from '../harness/network-mock.js';

describe('Tier 4 Scenario 2: End-to-End Chapter Reading & Line Retranslation', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    apikey: 'sk-or-v1-valid-key-for-scenario',
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    model: 'stepfun/step-3.5-flash'
                },
                accessLevel: 'TRUSTED_CONTEXTS'
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 2: full reading session: extraction -> streaming deltas -> batched DOM -> in-place retranslation', async () => {
        // Step 1: Web page DOM with Chinese novel chapter
        const container = document.createElement('div');
        container.id = 'chapter-content';
        container.innerHTML = `
            <p>第一章: 乌坦城的天才</p>
            <p>萧炎站在演武场中央，周围投来讥讽的目光。</p>
            <p>“斗之力，三段！”测验石碑旁，中年男子冷漠地公布结果。</p>
        `;
        document.body.appendChild(container);

        // Step 2: Extractor extracts clean paragraph chunks via genuine STV_convertHtmlToTextChunks
        const rawChunks = STV_convertHtmlToTextChunks(container.innerHTML).filter(Boolean);
        assert.strictEqual(rawChunks.length, 3);
        assert.strictEqual(rawChunks[0], '第一章: 乌坦城的天才');

        // Mock LLM streaming SSE tokens
        sandbox.network.addRoute('/chat/completions', () => {
            return createSseResponse([
                { content: 'Chương 1: ' },
                { content: 'Thiên tài của thành Ô Thản.\n' },
                { content: 'Tiêu Viêm đứng giữa diễn võ trường, xung quanh truyền đến những ánh mắt châm chọc.\n' },
                { content: '“Đấu chi lực, tam đoạn!” Bên cạnh bia đá trắc nghiệm, nam tử trung niên lạnh lùng công bố kết quả.' }
            ]);
        });

        // Step 4: Content script connects port and receives streaming deltas
        const port = chrome.runtime.connect({ name: 'stv-translate-stream' });
        const receivedDeltas = [];

        const streamPromise = new Promise((resolve) => {
            port.onMessage.addListener((msg) => {
                if (msg.type === 'delta') {
                    receivedDeltas.push(msg.delta);
                } else if (msg.type === 'done') {
                    resolve();
                }
            });
        });

        port.postMessage({
            action: 'start_translation',
            runId: 'novel-session-run-1',
            textChunks: rawChunks
        });

        await streamPromise;

        // Step 5: Render batched lines to DOM via genuine STV_createStreamRenderer
        const renderer = STV_createStreamRenderer(container, rawChunks, 'novel-session-run-1');
        let fullText = '';
        for (const delta of receivedDeltas) {
            fullText += delta;
            renderer.syncText(fullText, false);
        }
        renderer.syncText(fullText, true);

        const renderedLines = container.querySelectorAll('.stv-line');
        assert.strictEqual(renderedLines.length, 3);
        assert.strictEqual(renderedLines[0].textContent, 'Chương 1: Thiên tài của thành Ô Thản.');

        // Step 6: User notices line 1 and double-clicks to retranslate
        const targetLine = renderedLines[1];
        assert.strictEqual(targetLine.getAttribute('data-orig'), '萧炎站在演武场中央，周围投来讥讽的目光。');

        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.action === 'stv_retranslate_line') {
                sendResponse({
                    ok: true,
                    lineIndex: msg.lineIndex,
                    translatedText: 'Tiêu Viêm sừng sững đứng ở giữa diễn võ trường, bốn phía ánh mắt giễu cợt bắn tới.'
                });
                return true;
            }
        });

        const retranslateRes = await chrome.runtime.sendMessage({
            action: 'stv_retranslate_line',
            origText: targetLine.getAttribute('data-orig'),
            lineIndex: 1
        });

        assert.strictEqual(retranslateRes.ok, true);

        // Apply updated line text safely via .textContent
        targetLine.textContent = retranslateRes.translatedText;
        assert.strictEqual(targetLine.textContent, 'Tiêu Viêm sừng sững đứng ở giữa diễn võ trường, bốn phía ánh mắt giễu cợt bắn tới.');
    });
});
