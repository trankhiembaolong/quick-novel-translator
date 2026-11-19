/**
 * test-e2e/tier3-pairwise/glossary-streaming.test.js
 * Tier 3 Pairwise Combinatorics: Glossary Rules & Streaming Translation (4 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox } from '../harness/index.js';
import '../../glossary-utils.js';

describe('Tier 3: Glossary + Streaming Translation Interaction', () => {
    let sandbox;
    const GlossaryUtils = globalThis.STV_GlossaryUtils;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    apikey: 'sk-test-valid-key',
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    model: 'stepfun/step-3.5-flash',
                    stv_active_glossary_profile: 'TienHiep',
                    stv_glossary_profile_TienHiep: {
                        '萧炎': { hanviet: 'Tiêu Viêm', locked: true },
                        '药尘': { hanviet: 'Dược Trần', locked: true }
                    }
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T3.5: locked terms in active profile are formatted into LLM system prompt for streaming', async () => {
        const stored = await chrome.storage.local.get([
            'stv_active_glossary_profile',
            'stv_glossary_profile_TienHiep'
        ]);
        const glossary = stored.stv_glossary_profile_TienHiep;

        const rawChineseChapter = '萧炎看着药尘，心中感慨万千。';
        const { finalSystemPrompt } = GlossaryUtils.buildTranslationPromptPayload(
            rawChineseChapter,
            'Bạn là dịch giả truyện chữ.',
            glossary
        );

        assert.ok(finalSystemPrompt.includes('Danh sách thuật ngữ đã dịch trước đó'));
        assert.ok(finalSystemPrompt.includes('萧炎 = Tiêu Viêm'));
        assert.ok(finalSystemPrompt.includes('药尘 = Dược Trần'));
        assert.ok(finalSystemPrompt.includes('[TRANSLATION]'));
        assert.ok(finalSystemPrompt.includes('[GLOSSARY]'));
    });

    it('T3.6: auto-extracted terms from streaming [GLOSSARY] block do not overwrite locked terms upon stream completion', () => {
        const fullStreamedResponse = `
[TRANSLATION]
Tiêu Viêm nhìn Dược Trần, trong lòng cảm khái vạn phần. Nạp Lan Yên Nhiên cũng đã đến.

[GLOSSARY]
萧炎 = Tiểu Viêm
纳兰嫣然 = Nạp Lan Yên Nhiên
药尘 = Dược Lão Sư
`;

        const existingGlossary = {
            '萧炎': { hanviet: 'Tiêu Viêm', locked: true },
            '药尘': { hanviet: 'Dược Trần', locked: true }
        };

        const { newTerms } = GlossaryUtils.extractGlossaryTermsFromFullText(fullStreamedResponse);
        assert.strictEqual(newTerms['萧炎'].hanviet, 'Tiểu Viêm');
        assert.strictEqual(newTerms['纳兰嫣然'].hanviet, 'Nạp Lan Yên Nhiên');

        // Merge protecting locked terms
        const { merged } = GlossaryUtils.mergeGlossaryTerms(existingGlossary, newTerms);

        assert.strictEqual(merged['萧炎'].hanviet, 'Tiêu Viêm', 'Locked term 萧炎 must remain unchanged');
        assert.strictEqual(merged['药尘'].hanviet, 'Dược Trần', 'Locked term 药尘 must remain unchanged');
        assert.strictEqual(merged['纳兰嫣然'].hanviet, 'Nạp Lan Yên Nhiên', 'New term must be added');
    });

    it('T3.7: line retranslation via stv_retranslate_line incorporates active glossary terms', async () => {
        let capturedPrompt = '';
        sandbox.network.addRoute('/chat/completions', (url, options) => {
            const body = JSON.parse(options.body || '{}');
            capturedPrompt = body.messages?.[0]?.content || '';
            return new Response(JSON.stringify({
                choices: [{
                    message: { content: 'Tiêu Viêm vung ra một chưởng' }
                }]
            }), { headers: { 'Content-Type': 'application/json' } });
        });

        const res = await chrome.runtime.sendMessage({
            action: 'stv_retranslate_line',
            origText: '萧炎一掌挥出',
            lineIndex: 0
        });

        assert.ok(res, 'Retranslate response must exist');
        assert.strictEqual(res.ok, true, 'Retranslation must succeed');
        assert.strictEqual(res.lineIndex, 0);
        assert.strictEqual(res.translatedText, 'Tiêu Viêm vung ra một chưởng');
        assert.ok(capturedPrompt.includes('萧炎'), 'Prompt sent to LLM must include glossary source term');
        assert.ok(capturedPrompt.includes('Tiêu Viêm'), 'Prompt sent to LLM must include glossary translation term');
    });

    it('T3.8: switching active glossary profile while stream is idle applies new glossary terms to next translation', async () => {
        // Create second profile
        await chrome.storage.local.set({
            stv_active_glossary_profile: 'KiemHiep',
            stv_glossary_profile_KiemHiep: {
                '令狐冲': { hanviet: 'Lệnh Hồ Xung', locked: true }
            }
        });

        const updatedProfileKey = (await chrome.storage.local.get(['stv_active_glossary_profile'])).stv_active_glossary_profile;
        assert.strictEqual(updatedProfileKey, 'KiemHiep');

        const profileData = await chrome.storage.local.get([`stv_glossary_profile_${updatedProfileKey}`]);
        const kiemHiepGlossary = profileData.stv_glossary_profile_KiemHiep;

        const rawText = '令狐冲拔出长剑';
        const { finalSystemPrompt } = GlossaryUtils.buildTranslationPromptPayload(rawText, '', kiemHiepGlossary);

        assert.ok(finalSystemPrompt.includes('令狐冲 = Lệnh Hồ Xung'));
        assert.strictEqual(finalSystemPrompt.includes('Tiêu Viêm'), false, 'Old profile terms must not leak');
    });
});
