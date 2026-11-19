'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const describer = require(path.resolve(__dirname, '..', 'tts-icon-describer.js'));

test('detects and describes screenshot kaomoji line cleanly in tagged default style', () => {
    const line = 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა';
    const prep = describer.prepareTextForTTS(line, { mode: 'auto', style: 'tagged' });

    assert.equal(prep.hasIcons, true);
    assert.equal(prep.needsAi, true);
    assert.equal(prep.tokens.length, 1);
    assert.equal(prep.tokens[0].type, 'kaomoji');
    assert.equal(prep.tokens[0].raw, '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა');
    assert.ok(prep.text.startsWith('Cô con gái, biểu cảm '), `Unexpected output: ${prep.text}`);
    assert.ok(!/[\u0A80-\u0AFF\u10A0-\u10FF\u0250-\u02FF\u06F5\u22CB]/.test(prep.text), 'No exotic kaomoji chars may remain');
});

test('handles complex modern and classic kaomoji across styles and locales', () => {
    const complex = '૮₍ ˃̣̣̥ ʌ ˂̣̣̥ ₎ა';
    const resTagged = describer.prepareTextForTTS(complex, { mode: 'auto', style: 'tagged', fallbackLocale: 'vi' });
    assert.equal(resTagged.hasIcons, true);
    assert.equal(resTagged.needsAi, true);
    assert.ok(resTagged.text.startsWith('Biểu cảm '), `Expected standalone tagged phrase, got: ${resTagged.text}`);

    const resNatural = describer.prepareTextForTTS(`Cô bé: ${complex}`, { mode: 'local', style: 'natural', fallbackLocale: 'vi' });
    assert.equal(resNatural.needsAi, false);
    assert.ok(!/biểu cảm/i.test(resNatural.text), 'Natural style must omit tagged label');
    assert.ok(resNatural.text.startsWith('Cô bé, '));

    const resEn = describer.prepareTextForTTS(`Daughter: ${complex}`, { mode: 'local', style: 'tagged', fallbackLocale: 'en' });
    assert.equal(resEn.lang, 'en');
    assert.ok(resEn.text.includes('expression: '), `Expected English expression tag, got: ${resEn.text}`);

    const classics = [
        'o(╥﹏╥)o',
        '(╯°□°）╯︵ ┻━┻',
        'ヽ(°〇°)ﾉ',
        '(⁄ ⁄•⁄ω⁄•⁄ ⁄)',
        '(￣▽￣)"'
    ];
    for (const c of classics) {
        const out = describer.prepareTextForTTS(c, { mode: 'auto', style: 'tagged' });
        assert.equal(out.hasIcons, true, `Failed to detect classic kaomoji: ${c}`);
        assert.equal(out.needsAi, false, `Dictionary classic kaomoji should resolve locally: ${c}`);
        assert.ok(out.text.startsWith('Biểu cảm '), `Expected Vietnamese tagged phrase for ${c}, got: ${out.text}`);
    }
});

test('handles emojis (single, repeated, ZWJ/VS16) and ASCII emoticons', () => {
    const repeatedCry = describer.prepareTextForTTS('😭😭😭', { mode: 'auto', style: 'tagged' });
    assert.equal(repeatedCry.hasIcons, true);
    assert.equal(repeatedCry.needsAi, false);
    assert.equal(repeatedCry.tokens.length, 1);
    assert.equal(repeatedCry.tokens[0].repeatCount, 3);
    assert.ok(repeatedCry.text.includes('khóc nức nở dữ dội'));

    const singleZwj = describer.prepareTextForTTS('Hắn choáng váng 😵‍💫 rồi gục xuống ⚔️', { mode: 'auto', style: 'tagged' });
    assert.equal(singleZwj.hasIcons, true);
    assert.equal(singleZwj.tokens.length, 2);
    assert.ok(singleZwj.text.includes('biểu cảm quay cuồng chóng mặt'));
    assert.ok(singleZwj.text.includes('biểu cảm song kiếm giao tranh'));

    for (const emo of ['QAQ', 'T_T', 'Orz', '>_<', '-_-', ':3', 'XD']) {
        const out = describer.prepareTextForTTS(`Trời ơi ${emo}`, { mode: 'auto', style: 'tagged' });
        assert.equal(out.hasIcons, true, `Failed to detect ASCII emoticon ${emo}`);
        assert.equal(out.needsAi, false);
        assert.ok(out.text.startsWith('Trời ơi, biểu cảm '), `Unexpected output for ${emo}: ${out.text}`);
    }
});

test('mode=off strips icons and drops pure-icon lines cleanly', () => {
    const mixed = describer.prepareTextForTTS('Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', { mode: 'off' });
    assert.equal(mixed.hasIcons, true);
    assert.equal(mixed.needsAi, false);
    assert.equal(mixed.text, 'Cô con gái');

    const pure = describer.prepareTextForTTS('😭😭😭', { mode: 'off' });
    assert.equal(pure.text, '');
});

test('learnedCache resolves complex kaomoji with confident=true and needsAi=false', () => {
    const cache = {
        '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა': { vi: 'mếu máo khóc nức nở', en: 'sobbing pitifully' }
    };
    const prep = describer.prepareTextForTTS('Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', {
        mode: 'auto',
        style: 'tagged',
        learnedCache: cache
    });
    assert.equal(prep.hasIcons, true);
    assert.equal(prep.needsAi, false);
    assert.equal(prep.text, 'Cô con gái, biểu cảm mếu máo khóc nức nở');
});

test('prevents false positives on units, math, timestamps, dividers, Arabic/Hebrew, and CJK prose', () => {
    const safeProse = [
        'Nhiệt độ là 38°C, góc nghiêng 90°, diện tích 50m², phép tính 3×4 ± 5 = 12.',
        'Lúc 10:30 hẹn gặp tại http://example.com:3000/test.',
        'Phương trình α + β = π và (x + y) = 10.',
        'Ghi chú (1), (2), (a), (1-2), (--), (Bình an).',
        'Tài liệu cổ ngữ: سلام عليكم (Bình an) và עִבְרִית cùng tiếng Trung 仙道.',
        '萧炎哈哈大笑'
    ];
    for (const line of safeProse) {
        const res = describer.prepareTextForTTS(line, { mode: 'auto', style: 'tagged' });
        assert.equal(res.hasIcons, false, `False positive on: ${line} -> ${JSON.stringify(res.tokens)}`);
        assert.equal(res.text, line);
    }

    for (const divider of ['---', '***', '★★★', '===', '◆◆◆']) {
        const res = describer.prepareTextForTTS(divider, { mode: 'auto', style: 'tagged' });
        assert.equal(res.text, '', `Divider should become empty: ${divider}`);
    }
});

test('AI prompt builder, fenced JSON parser, and anti-hallucination sanitizer work safely', () => {
    const { systemPrompt, userMessage } = describer.buildAiIconPrompt([
        {
            id: 0,
            prev: 'Sở Oánh: "Con gái, sao thế?"',
            text: 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა',
            next: 'Cô lao bổ vào Sở Oánh: "A... tại mẹ hết..."',
            icons: ['૮ε˚۵ ⋋ʌ⋋۵ 3˚ა']
        }
    ], { style: 'tagged', lang: 'vi' });

    assert.ok(systemPrompt.includes('TÁCH BẠCH'));
    assert.ok(userMessage.includes('Sở Oánh'));

    const rawAi = '```json\n{"results":[{"id":0,"spoken":"Cô con gái, biểu cảm mếu máo khóc nức nở. 😭","icon_gloss":{"૮ε˚۵ ⋋ʌ⋋۵ 3˚ა":"mếu máo khóc nức nở"}}]}\n```';
    const parsed = describer.parseAiIconResponse(rawAi);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 0);
    assert.equal(parsed[0].icon_gloss['૮ε˚۵ ⋋ʌ⋋۵ 3˚ა'], 'mếu máo khóc nức nở');

    const sanitized = describer.sanitizeAiSpokenText(
        parsed[0].spoken,
        'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა',
        'Cô con gái, biểu cảm mếu máo khóc lóc'
    );
    assert.equal(sanitized, 'Cô con gái, biểu cảm mếu máo khóc nức nở.');

    // Anti-hallucination: drops original speaker name or outputs crazy length -> fallback
    const badHallucination = describer.sanitizeAiSpokenText(
        'Một câu hoàn toàn bịa đặt không liên quan.',
        'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა',
        'Cô con gái, biểu cảm mếu máo khóc lóc'
    );
    assert.equal(badHallucination, 'Cô con gái, biểu cảm mếu máo khóc lóc');
});

test('customIcons override learnedCache & built-in dicts and support custom tags', () => {
    const customIcons = describer.normalizeCustomIconsMap({
        '😭': { meaning: 'òa khóc thật to', skip: false },
        '❤️': { meaning: 'tim đỏ', skip: false },
        '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა': { meaning: 'khóc nấc lên vì tủi thân', skip: false },
        'TvT': { meaning: 'khóc thầm', skip: false },
        '[cười]': { meaning: 'cười khúc khích', skip: false },
        '': 'invalid',
        '   ': { meaning: '', skip: false }
    });
    const learnedCache = {
        '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა': { vi: 'nghĩa cũ từ AI' }
    };

    const overrideCry = describer.prepareTextForTTS('😭😭😭', { mode: 'auto', style: 'tagged', learnedCache, customIcons });
    assert.equal(overrideCry.needsAi, false);
    assert.equal(overrideCry.text, 'Biểu cảm òa khóc thật to');

    // Variation-selector fallback: ❤️ custom overrides ❤ in text
    const overrideHeart = describer.prepareTextForTTS('Yêu ❤ nhiều', { mode: 'auto', style: 'tagged', customIcons });
    assert.equal(overrideHeart.text, 'Yêu, biểu cảm tim đỏ, nhiều');

    const overrideKaomoji = describer.prepareTextForTTS('Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', { mode: 'auto', style: 'tagged', learnedCache, customIcons });
    assert.equal(overrideKaomoji.needsAi, false);
    assert.equal(overrideKaomoji.text, 'Cô con gái, biểu cảm khóc nấc lên vì tủi thân');

    // Custom alphanumeric tag respects word boundaries
    const customTag = describer.prepareTextForTTS('Trời ơi TvT và ATvT [cười]', { mode: 'auto', style: 'tagged', customIcons });
    assert.ok(customTag.text.includes('biểu cảm khóc thầm'));
    assert.ok(customTag.text.includes('ATvT'));
    assert.ok(customTag.text.includes('biểu cảm cười khúc khích'));
});

test('per-icon skip mutes skipped icons while preserving prose and non-skipped icons', () => {
    const customIcons = describer.normalizeCustomIconsMap({
        '✨': { meaning: 'lấp lánh', skip: true },
        '♪': { meaning: '', skip: true }
    });

    const inlineSkip = describer.prepareTextForTTS('Đẹp quá ✨ nha ♪', { mode: 'auto', style: 'tagged', customIcons });
    assert.equal(inlineSkip.text, 'Đẹp quá nha');
    assert.equal(inlineSkip.needsAi, false);

    const standaloneSkip = describer.prepareTextForTTS('✨ ♪', { mode: 'auto', style: 'tagged', customIcons });
    assert.equal(standaloneSkip.text, '');
    assert.equal(standaloneSkip.needsAi, false);

    const mixedSkipAndEmoji = describer.prepareTextForTTS('✨ 😭', { mode: 'auto', style: 'tagged', customIcons });
    assert.equal(mixedSkipAndEmoji.text, 'Biểu cảm khóc nức nở');
    assert.equal(mixedSkipAndEmoji.needsAi, false);

    const mixedSkipAndAi = describer.prepareTextForTTS('Cô con gái ✨: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', { mode: 'auto', style: 'tagged', customIcons });
    assert.equal(mixedSkipAndAi.needsAi, true);
    assert.ok(!mixedSkipAndAi.aiText.includes('✨'), `aiText must omit skipped icon: ${mixedSkipAndAi.aiText}`);
    assert.ok(mixedSkipAndAi.text.startsWith('Cô con gái, biểu cảm '));
});

test('getDefaultIconEntries returns deduplicated emoji and kaomoji entries', () => {
    const viEntries = describer.getDefaultIconEntries('vi');
    const heartEntries = viEntries.filter((e) => e.key.replace(/\uFE0F/g, '') === '❤');
    assert.equal(heartEntries.length, 1);
    assert.equal(heartEntries[0].key, '❤️');
    assert.ok(viEntries.some((e) => e.category === 'emoji'));
    assert.ok(viEntries.some((e) => e.category === 'kaomoji' && e.key === 'qaq'));
});

test('classifyIconCategory distinguishes unicode emoji from kaomoji and bracketed emoticons', () => {
    const emojiSamples = ['😭', '😭😭😭', '❤️', '❤', '✨', '♡', '♪♫', '😵‍💫', '🦄✨', '🇻🇳', '1️⃣'];
    for (const sample of emojiSamples) {
        assert.equal(describer.classifyIconCategory(sample), 'emoji', `Expected emoji for ${sample}`);
    }

    const kaomojiSamples = [
        '૮ε˚۵ ⋋ʌ⋋۵ 3˚ა',
        'o(╥﹏╥)o',
        '(╯°□°）╯︵ ┻━┻',
        'QAQ',
        'T_T',
        '>_<',
        ':3',
        'TvT',
        '(♡˙︶˙♡)',
        '(🔥_🔥)',
        '[cười]'
    ];
    for (const sample of kaomojiSamples) {
        assert.equal(describer.classifyIconCategory(sample), 'kaomoji', `Expected kaomoji for ${sample}`);
    }
});
