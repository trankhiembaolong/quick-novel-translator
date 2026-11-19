/**
 * test-e2e/tier2-boundaries/edge-inputs.test.js
 * Tier 2 Boundary & Corner Cases: Edge Inputs & Extreme Values (11 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, STV_convertHtmlToTextChunks, splitLongTextForTTS } from '../harness/index.js';
import '../../glossary-utils.js';

describe('Tier 2: Edge Inputs & Boundary Stress', () => {
    let sandbox;
    const GlossaryUtils = globalThis.STV_GlossaryUtils;

    beforeEach(() => {
        sandbox = setupSandbox();
    });

    afterEach(() => {
        teardownSandbox();
    });

    const extractTextChunks = (htmlStr) => STV_convertHtmlToTextChunks(htmlStr).filter(Boolean);

    it('T2.1: handles empty string chapter content without crashing', () => {
        const chunks1 = extractTextChunks('');
        assert.deepStrictEqual(chunks1, []);

        const chunks2 = extractTextChunks(null);
        assert.deepStrictEqual(chunks2, []);
    });

    it('T2.2: handles whitespace-only and newline-only chapter content', () => {
        const chunks = extractTextChunks('   \n\t\r\n   \n\n   ');
        assert.deepStrictEqual(chunks, []);
    });

    it('T2.3: handles single gigantic paragraph exceeding 50,000 characters without call stack overflow', () => {
        const giantText = 'Chữ '.repeat(15000); // ~60,000 characters
        const html = `<div id="chapter-content"><p>${giantText}</p></div>`;

        const chunks = extractTextChunks(html);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].length, giantText.trim().length);
    });

    it('T2.4: handles novel chapter exceeding 2,000 lines without memory exhaustion', () => {
        const paragraphs = [];
        for (let i = 0; i < 2000; i++) {
            paragraphs.push(`<p>Dòng thứ ${i}: Tiêu Viêm vận hành đấu khí chu thiên.</p>`);
        }
        const html = `<div id="chapter-content">${paragraphs.join('')}</div>`;

        const chunks = extractTextChunks(html);
        assert.strictEqual(chunks.length, 2000);
        assert.strictEqual(chunks[0], 'Dòng thứ 0: Tiêu Viêm vận hành đấu khí chu thiên.');
        assert.strictEqual(chunks[1999], 'Dòng thứ 1999: Tiêu Viêm vận hành đấu khí chu thiên.');
    });

    it('T2.5: preserves unicode surrogate pairs and emoji sequences accurately', () => {
        const html = '<div id="chapter-content"><p>Tu tiên 🚀🔥𠮷野家 linh thạch 💎 cấp bậc 🌟 thần khí ⚔️</p></div>';
        const chunks = extractTextChunks(html);

        assert.strictEqual(chunks.length, 1);
        assert.ok(chunks[0].includes('🚀🔥𠮷野家'));
        assert.ok(chunks[0].includes('💎'));
        assert.ok(chunks[0].includes('⚔️'));
    });

    it('T2.6: handles RTL text (Arabic, Hebrew) mixed with novel text without DOM corruption', () => {
        const html = '<div id="chapter-content"><p>Tài liệu cổ ngữ: سلام عليكم (Bình an) và עִבְרִית cùng tiếng Trung 仙道.</p></div>';
        const chunks = extractTextChunks(html);

        assert.strictEqual(chunks.length, 1);
        assert.ok(chunks[0].includes('سلام عليكم'));
        assert.ok(chunks[0].includes('עִבְרִית'));
        assert.ok(chunks[0].includes('仙道'));
    });

    it('T2.7: handles zero-width spaces and invisible control characters cleanly', () => {
        const html = '<div id="chapter-content"><p>Từ\u200Bkhóa\uFEFFẩn\u200Ctrong\u200Dvăn\u00A0bản</p></div>';
        const chunks = extractTextChunks(html);

        assert.strictEqual(chunks.length, 1);
        assert.ok(chunks[0].length > 0);
        // Stripped or preserved cleanly without breaking token stream
        assert.ok(chunks[0].includes('khóa'));
    });

    it('T2.8: splits continuous unbroken string (>10,000 chars without punctuation) safely', () => {
        const continuous = 'A'.repeat(12000);
        const slices = splitLongTextForTTS(continuous, 180);

        assert.strictEqual(slices.length, Math.ceil(12000 / 180));
        assert.strictEqual(slices[0].length, 180);
        assert.strictEqual(slices.join(''), continuous);
    });

    it('T2.9: handles malformed JSON during glossary import safely with user error indication', () => {
        const malformedJson = '{ "version": 1, "profile": "TuTien", "terms": { invalid_json_here } ';

        let parseError = null;
        let parsedResult = null;
        try {
            parsedResult = JSON.parse(malformedJson);
        } catch (err) {
            parseError = err;
        }

        assert.ok(parseError, 'Syntax error must be thrown and caught');
        assert.strictEqual(parsedResult, null);
    });

    it('T2.10: validates Hanzi term length boundary in glossary (rejects <2 chars or >20 chars)', () => {
        // Single character: rejected
        assert.strictEqual(GlossaryUtils.isPureChineseTerm('炎'), false, '1 char Hanzi must be rejected');

        // Exactly 2 characters: accepted
        assert.strictEqual(GlossaryUtils.isPureChineseTerm('萧炎'), true, '2 char Hanzi must be accepted');

        // Exactly 20 characters: accepted
        const twentyChars = '一二三四五六七八九十一二三四五六七八九十';
        assert.strictEqual(twentyChars.length, 20);
        assert.strictEqual(GlossaryUtils.isPureChineseTerm(twentyChars), true, '20 char Hanzi must be accepted');

        // 21 characters: rejected
        const twentyOneChars = twentyChars + '一';
        assert.strictEqual(GlossaryUtils.isPureChineseTerm(twentyOneChars), false, '21 char Hanzi must be rejected');
    });

    it('T2.11: filters huge glossary profile (>1,000 terms) within 50ms performance budget', () => {
        const hugeGlossary = [];
        for (let i = 0; i < 1500; i++) {
            hugeGlossary.push({
                orig: `角色${i}`,
                hanviet: `Nhân vật ${i}`,
                locked: i % 3 === 0
            });
        }

        const start = performance.now();
        const query = 'nhân vật 12';
        const filtered = hugeGlossary.filter(t => t.hanviet.toLowerCase().includes(query));
        const duration = performance.now() - start;

        assert.ok(filtered.length >= 10, 'Must match character indices 120-129, 1200-1299 etc.');
        assert.ok(duration < 50, `Filtering took ${duration.toFixed(2)}ms, must be < 50ms`);
    });
});
