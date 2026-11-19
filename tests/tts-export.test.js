'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTtsHelpers() {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const sandbox = {
        window: undefined,
        globalThis: {},
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Blob,
        Float32Array,
        Int16Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Math,
        Number,
        String,
        Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return sandbox.STV_TTSHelpers;
}

test('float32ToInt16 converts normalized PCM samples with clamping and NaN safety', () => {
    const helpers = loadTtsHelpers();
    const input = new Float32Array([0, 1, -1, 1.8, -2.5, Number.NaN, 0.5]);
    const out = helpers.float32ToInt16(input);

    assert.ok(out instanceof Int16Array);
    assert.equal(out.length, 7);
    assert.equal(out[0], 0);
    assert.equal(out[1], 32767);
    assert.equal(out[2], -32768);
    assert.equal(out[3], 32767);
    assert.equal(out[4], -32768);
    assert.equal(out[5], 0);
    assert.equal(out[6], 16384);
});

test('encodeWavFromInt16Chunks produces valid 24kHz Mono 16-bit RIFF WAVE header and payload', async () => {
    const helpers = loadTtsHelpers();
    const backing = new Int16Array([999, 100, -200, 300, 400, -999]);
    const slicedChunk = backing.subarray(1, 5); // [100, -200, 300, 400]
    const extraChunk = new Int16Array([500, -600]);

    const res = helpers.encodeWavFromInt16Chunks([slicedChunk, new Int16Array(0), extraChunk], 24000);
    assert.equal(res.sampleRate, 24000);
    assert.equal(res.totalSamples, 6);
    assert.equal(res.byteLength, 44 + 6 * 2);
    assert.ok(res.blob);
    assert.equal(res.blob.size, res.byteLength);

    const buf = await res.blob.arrayBuffer();
    const view = new DataView(buf);
    const ascii = (start, len) => Buffer.from(buf, start, len).toString('ascii');

    assert.equal(ascii(0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 12);
    assert.equal(ascii(8, 4), 'WAVE');
    assert.equal(ascii(12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint32(28, true), 48000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(ascii(36, 4), 'data');
    assert.equal(view.getUint32(40, true), 12);

    const decodedSamples = [
        view.getInt16(44, true),
        view.getInt16(46, true),
        view.getInt16(48, true),
        view.getInt16(50, true),
        view.getInt16(52, true),
        view.getInt16(54, true)
    ];
    assert.deepStrictEqual(decodedSamples, [100, -200, 300, 400, 500, -600]);
});

test('extractCleanTranslatedLines strips markers, glossary block, fences, and blank lines', () => {
    const helpers = loadTtsHelpers();
    const raw = [
        '```markdown',
        '[TRANSLATION]',
        '',
        '  Chương 5: Khởi hành  ',
        '',
        'Hắn bước ra khỏi sơn cốc.',
        '   ',
        '[GLOSSARY]',
        '山谷 = sơn cốc',
        '```'
    ].join('\n');

    const lines = Array.from(helpers.extractCleanTranslatedLines(raw));
    assert.deepStrictEqual(lines, [
        'Chương 5: Khởi hành',
        'Hắn bước ra khỏi sơn cốc.'
    ]);

    assert.deepStrictEqual(Array.from(helpers.extractCleanTranslatedLines('Chỉ có một dòng.\n\nDòng thứ hai.')), [
        'Chỉ có một dòng.',
        'Dòng thứ hai.'
    ]);
    assert.deepStrictEqual(Array.from(helpers.extractCleanTranslatedLines('')), []);
});

test('appendPackedSegment packs consecutive preloaded lines when domEl is null', () => {
    const helpers = loadTtsHelpers();
    const segments = [];
    helpers.appendPackedSegment(segments, 'Câu thứ nhất ngắn gọn', null, 0);
    helpers.appendPackedSegment(segments, 'Câu thứ hai cũng ngắn.', null, 0);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'Câu thứ nhất ngắn gọn. Câu thứ hai cũng ngắn.');
});

test('packSegmentsForExport merges short lines up to 210 chars across segments', () => {
    const helpers = loadTtsHelpers();
    const shortLines = [
        { text: 'Tiêu Viêm bước vào đại điện.' },
        { text: 'Mọi người đều quay sang nhìn hắn' },
        { text: 'Bầu không khí bỗng trở nên im lặng lạ thường.' },
        '   ',
        '---',
        { text: 'Một lát sau, trưởng lão mới chậm rãi mở lời hỏi thăm tình hình tu luyện của hắn trong suốt thời gian qua tại Ma Thú Sơn Mạch.' },
        { text: 'Hắn bình tĩnh đáp lại từng câu một cách dứt khoát và không hề nao núng trước ánh nhìn soi xét của đám người kia.' }
    ];

    const packed = Array.from(helpers.packSegmentsForExport(shortLines, 210));
    assert.ok(packed.length >= 2 && packed.length <= 3, `Expected 2-3 packed chunks, got ${packed.length}`);
    for (const seg of packed) {
        assert.ok(seg.text.length <= 210, `Packed segment length ${seg.text.length} exceeds 210`);
    }
    const joined = packed.map((s) => s.text).join(' ');
    assert.ok(joined.includes('Tiêu Viêm bước vào đại điện. Mọi người đều quay sang nhìn hắn.'));
    assert.ok(joined.includes('đám người kia.'));
});

test('AMD GPU DirectML backend option is wired across popup.html, i18n.js, tts-player.js, and native host', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const hostPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_host.py'), 'utf8');
    const runnerPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_server_runner.py'), 'utf8');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const i18n = require(path.join(root, 'i18n.js'));

    assert.ok(html.includes('value="amd_gpu"'), 'popup.html must offer amd_gpu option');
    assert.ok(html.includes('data-i18n="optBackendAmdGpu"'), 'popup.html must localize amd_gpu option');
    assert.ok(typeof i18n.DICTIONARY.vi.optBackendAmdGpu === 'string' && i18n.DICTIONARY.vi.optBackendAmdGpu.length > 0);
    assert.ok(typeof i18n.DICTIONARY.en.optBackendAmdGpu === 'string' && i18n.DICTIONARY.en.optBackendAmdGpu.length > 0);

    assert.ok(hostPy.includes('backend == "amd_gpu"'), 'vieneu_host.py must handle amd_gpu backend');
    assert.ok(hostPy.includes('env["VIENEU_PRECISION"] = "amd_gpu"'));
    assert.ok(hostPy.includes('env["VIENEU_MAX_STREAMS"] = "3"'), 'vieneu_host.py must allocate 3 streams (2 GPU + 1 CPU)');
    assert.ok(runnerPy.includes('detect_amd_dml_device_id'), 'vieneu_server_runner.py must detect discrete DirectML adapter');
    assert.ok(runnerPy.includes('SubprocessDmlWorker'), 'vieneu_server_runner.py must support isolated second GPU process');
    assert.ok(runnerPy.includes('DmlExecutionProvider'));
    assert.ok(runnerPy.includes('eng._ac_pos_steps[ch]'), 'acoustic frame step must index _ac_pos_steps[ch] cleanly');
    assert.ok(!runnerPy.includes('eng._ac_pos_steps[ch - 1]'), 'must not shift acoustic RoPE position_ids by -1');
    assert.ok(!/sess_codec_dec[\s\S]{0,120}providers=dml_prov/.test(runnerPy), 'MOSS codec decoder must stay on CPU to avoid DirectML ConvTranspose hum');
    assert.ok(playerJs.includes('const EXPORT_CONCURRENCY = 3;'), 'tts-player.js must permit 3 concurrent WAV export streams');
});

test('tts-player Shadow DOM enforces [hidden] over flex download bars and background falls back on pending nextUrl', () => {
    const root = path.resolve(__dirname, '..');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

    assert.ok(
        /#stv-tts-player\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(playerJs),
        'TTS_PLAYER_SHADOW_CSS must ensure [hidden] hides flex rows such as dlIdleRow and dlActiveBox'
    );
    assert.ok(
        backgroundJs.includes('extracted.pendingNextUrl') && backgroundJs.includes('extractChunksViaHiddenIframe'),
        'background preload must fall back to hidden iframe when raw HTML only has a pending placeholder nextUrl'
    );
});

test('packSegmentsForExport avoids multi-part rawText duplication and double icon wrapping', () => {
    const describerCode = fs.readFileSync(path.resolve(__dirname, '..', 'tts-icon-describer.js'), 'utf8');
    const playerCode = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const sandbox = {
        window: undefined,
        globalThis: {},
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Blob,
        Float32Array,
        Int16Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Math,
        Number,
        String,
        Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(describerCode, sandbox);
    vm.runInNewContext(playerCode, sandbox);
    const helpers = sandbox.STV_TTSHelpers;

    const longParagraph = [
        'Đoạn mở đầu rất dài nói về hành trình tu luyện gian khổ trong núi sâu qua nhiều năm tháng trường kỳ.',
        'Đoạn tiếp theo kể về việc hắn tìm thấy bí kíp cổ xưa dưới đáy vực thẳm lạnh lẽo đầy sương mù.',
        'Đoạn cuối cùng miêu tả cảnh hắn đột phá cảnh giới giữa cơn giông bão mịt mù trời đất.'
    ].join(' ');

    const segments = [];
    helpers.appendPackedSegment(segments, longParagraph, null, 0, { mode: 'auto', style: 'tagged' });
    assert.ok(segments.length >= 2, 'Long paragraph must split across multiple playback segments');

    const exported = helpers.packSegmentsForExport(segments, 210, { mode: 'auto', style: 'tagged' });
    const joined = exported.map((s) => s.text).join(' ');
    const firstSentenceCount = joined.split('Đoạn mở đầu rất dài').length - 1;
    assert.equal(firstSentenceCount, 1, 'Multi-part paragraph must not be duplicated when repacked for export');

    const kaomojiSegments = [];
    const iconOpts = { mode: 'auto', style: 'tagged' };
    helpers.appendPackedSegment(kaomojiSegments, 'Sở Oánh: "Con gái, sao thế?"', null, 0, iconOpts);
    helpers.appendPackedSegment(kaomojiSegments, 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', null, 0, iconOpts);
    helpers.appendPackedSegment(kaomojiSegments, 'Cô lao bổ vào Sở Oánh.', null, 0, iconOpts);

    const packedKaomoji = helpers.packSegmentsForExport(kaomojiSegments, 210, iconOpts);
    assert.equal(packedKaomoji.length, 3, 'Kaomoji segment must not merge into adjacent prose segments');
    assert.equal(packedKaomoji[1].needsAiIconResolve, true);
    assert.ok(!/biểu cảm\s+biểu cảm/i.test(packedKaomoji[1].text), `Must not double-wrap tag: ${packedKaomoji[1].text}`);
});
