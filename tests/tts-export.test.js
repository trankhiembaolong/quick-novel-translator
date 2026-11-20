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

test('AMD GPU DirectML backend option is wired across popup.html, i18n.js, tts-player.js, background.js, and native host', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const hostPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_host.py'), 'utf8');
    const runnerPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_server_runner.py'), 'utf8');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const i18n = require(path.join(root, 'i18n.js'));

    assert.ok(html.includes('value="amd_gpu"'), 'popup.html must offer amd_gpu option');
    assert.ok(html.includes('data-i18n="optBackendAmdGpu"'), 'popup.html must localize amd_gpu option');
    assert.ok(typeof i18n.DICTIONARY.vi.optBackendAmdGpu === 'string' && i18n.DICTIONARY.vi.optBackendAmdGpu.length > 0);
    assert.ok(typeof i18n.DICTIONARY.en.optBackendAmdGpu === 'string' && i18n.DICTIONARY.en.optBackendAmdGpu.length > 0);

    assert.ok(hostPy.includes('backend == "amd_gpu"'), 'vieneu_host.py must handle amd_gpu backend');
    assert.ok(hostPy.includes('env["VIENEU_PRECISION"] = "amd_gpu"'));
    assert.ok(hostPy.includes('env["VIENEU_MAX_STREAMS"] = "1"'), 'vieneu_host.py must start web listening with 1 worker');
    assert.ok(hostPy.includes('env["VIENEU_EXPORT_MAX_STREAMS"] = "3"'), 'vieneu_host.py must allow 3-worker export scaling');
    assert.ok(hostPy.includes('env["OPENBLAS_NUM_THREADS"] = "1"'), 'vieneu_host.py must constrain BLAS threads to 1');
    assert.ok(!hostPy.includes('ABOVE_NORMAL_PRIORITY_CLASS'), 'vieneu_host.py must not starve Chrome/UI with ABOVE_NORMAL priority');

    assert.ok(runnerPy.includes('detect_amd_dml_device_id'), 'vieneu_server_runner.py must detect discrete DirectML adapter');
    assert.ok(runnerPy.includes('SubprocessDmlWorker'), 'vieneu_server_runner.py must support isolated second GPU process');
    assert.ok(runnerPy.includes('DmlExecutionProvider'));
    assert.ok(runnerPy.includes('ResizableGate'), 'vieneu_server_runner.py must use ResizableGate for live 1 <-> 3 scaling');
    assert.ok(runnerPy.includes('/v1/workers/mode'), 'vieneu_server_runner.py must expose /v1/workers/mode endpoint');
    assert.ok(runnerPy.includes('allow_spinning'), 'vieneu_server_runner.py must disable ORT busy spinning');
    assert.ok(runnerPy.includes('OPENBLAS_NUM_THREADS'), 'vieneu_server_runner.py must enforce OPENBLAS_NUM_THREADS=1');
    assert.ok(runnerPy.includes('eng._ac_pos_steps[ch]'), 'acoustic frame step must index _ac_pos_steps[ch] cleanly');
    assert.ok(!runnerPy.includes('eng._ac_pos_steps[ch - 1]'), 'must not shift acoustic RoPE position_ids by -1');
    assert.ok(!/sess_codec_dec[\s\S]{0,120}providers=dml_prov/.test(runnerPy), 'MOSS codec decoder must stay on CPU to avoid DirectML ConvTranspose hum');

    assert.ok(playerJs.includes('const EXPORT_CONCURRENCY = 3;'), 'tts-player.js must permit 3 concurrent WAV export streams');
    assert.ok(playerJs.includes('vieneu_set_worker_mode'), 'tts-player.js must scale VieNeu workers around WAV export');
    assert.ok(backgroundJs.includes("request.action === 'vieneu_set_worker_mode'"), 'background.js must proxy vieneu_set_worker_mode');
});

test('optimized decodePcm16Base64ToFloat32, createAnchorTrimmer, and WSOLAProcessor preserve accuracy', () => {
    const helpers = loadTtsHelpers();

    // 1. decodePcm16Base64ToFloat32 exact conversion
    const pcm = new Int16Array([0, 16384, -32768, 32767]);
    const b64 = Buffer.from(pcm.buffer).toString('base64');
    const f32 = helpers.decodePcm16Base64ToFloat32(b64);
    assert.equal(f32.length, 4);
    assert.equal(f32[0], 0);
    assert.ok(Math.abs(f32[1] - 0.5) < 1e-6);
    assert.equal(f32[2], -1);
    assert.ok(Math.abs(f32[3] - (32767 / 32768)) < 1e-6);

    // 2. incremental createAnchorTrimmer detects anchor + valley across uneven chunk boundaries
    const sr = 16000; // hop = 160 samples (10ms)
    const trimmer = helpers.createAnchorTrimmer(sr);
    const hop = 160;
    const totalFrames = 30; // 10 active anchor, 10 silence valley, 10 speech
    const full = new Float32Array(totalFrames * hop);
    for (let f = 0; f < 10; f++) {
        for (let k = 0; k < hop; k++) full[f * hop + k] = 0.2;
    }
    // frames 10..19 stay 0.0 (valley >= 7 frames)
    for (let f = 20; f < 30; f++) {
        for (let k = 0; k < hop; k++) full[f * hop + k] = 0.25;
    }
    // Push in awkward non-hop-aligned slices (e.g. 250 samples)
    const emitted = [];
    for (let off = 0; off < full.length; off += 250) {
        const piece = full.subarray(off, Math.min(full.length, off + 250));
        const res = trimmer.push(piece);
        if (res && res.length > 0) emitted.push(res);
    }
    const rest = trimmer.flush();
    if (rest && rest.length > 0) emitted.push(rest);
    const totalEmitted = emitted.reduce((sum, c) => sum + c.length, 0);
    assert.ok(totalEmitted > 0, 'Anchor trimmer must emit trimmed speech audio');
    assert.ok(totalEmitted <= (totalFrames - 12) * hop, `Anchor prefix must be trimmed (got ${totalEmitted})`);
    assert.ok(totalEmitted >= 10 * hop, `Speech body must be preserved (got ${totalEmitted})`);

    // 3. hierarchical WSOLAProcessor at 1.5x and 0.8x produces finite output at expected duration ratio
    for (const speed of [1.5, 0.8]) {
        const wsola = new helpers.WSOLAProcessor(48000, speed);
        const src = new Float32Array(48000); // 1 second 440Hz sine
        for (let i = 0; i < src.length; i++) {
            src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
        }
        const out1 = wsola.process(src.subarray(0, 24000));
        const out2 = wsola.process(src.subarray(24000));
        const out3 = wsola.flush();
        const totalOut = out1.length + out2.length + out3.length;
        const expected = 48000 / speed;
        assert.ok(Math.abs(totalOut - expected) < 6000, `Expected ~${expected} samples at ${speed}x, got ${totalOut}`);
        for (const chunk of [out1, out2, out3]) {
            for (let i = 0; i < chunk.length; i++) {
                assert.ok(Number.isFinite(chunk[i]), 'WSOLA output samples must be finite');
            }
        }
    }
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

test('getColabGpuExportConfig returns exact workers and maxChunkChars per GPU tier and auto-scales from healthData', () => {
    const helpers = loadTtsHelpers();
    assert.equal(typeof helpers.getColabGpuExportConfig, 'function');

    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('T4') }, { tier: 'T4', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('L4') }, { tier: 'L4', workers: 8, maxChunkChars: 320 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('A100') }, { tier: 'A100', workers: 12, maxChunkChars: 350 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto') }, { tier: 'auto', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 8 }) }, { tier: 'auto', workers: 8, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 12 }) }, { tier: 'auto', workers: 12, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 24 }) }, { tier: 'auto', workers: 12, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('T4', { export_max_streams: 12 }) }, { tier: 'T4', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('unknown-tier') }, { tier: 'T4', workers: 6, maxChunkChars: 300 });

    assert.equal(typeof helpers.getColabGpuBatchSize, 'function');
    assert.equal(helpers.getColabGpuBatchSize('T4'), 16);
    assert.equal(helpers.getColabGpuBatchSize('L4'), 32);
    assert.equal(helpers.getColabGpuBatchSize('A100'), 32);
    assert.equal(helpers.getColabGpuBatchSize('auto'), 16);
    assert.equal(helpers.getColabGpuBatchSize('auto', { batch_max_size: 32 }), 32);
    assert.equal(helpers.getColabGpuBatchSize('auto', { batch_max_size: 64 }), 32);
    assert.equal(helpers.getColabGpuBatchSize('L4', { batch_max_size: 16 }), 16);
});

test('Google Colab GPU export option and GPU tier selector are wired across popup, i18n, background, tts-player, and colab assets', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const runnerPy = fs.readFileSync(path.join(root, 'colab', 'vieneu_colab_runner.py'), 'utf8');
    const notebook = JSON.parse(fs.readFileSync(path.join(root, 'colab', 'VieNeu_Colab_GPU.ipynb'), 'utf8'));
    const i18n = require(path.join(root, 'i18n.js'));

    // Popup controls & GPU tier options
    for (const id of [
        'tts-download-source', 'tts-colab-panel', 'tts-colab-badge', 'tts-colab-status-label',
        'tts-colab-gpu-pill', 'btn-tts-colab-open', 'btn-tts-colab-copy', 'tts-colab-url',
        'btn-tts-colab-paste', 'tts-colab-voice', 'tts-colab-hint', 'tts-colab-gpu'
    ]) {
        assert.ok(html.includes(`id="${id}"`), `popup.html missing #${id}`);
    }
    assert.ok(html.includes('value="colab_gpu"'));
    for (const tier of ['value="T4"', 'value="L4"', 'value="A100"', 'value="auto"']) {
        assert.ok(html.includes(tier), `popup.html missing Colab GPU tier ${tier}`);
    }

    assert.ok(popupJs.includes('https://*.trycloudflare.com/*'));
    assert.ok(popupJs.includes('ensureColabTunnelPermission'));
    assert.ok(popupJs.includes('ttsDownloadSource') && popupJs.includes('ttsColabUrl') && popupJs.includes('ttsColabGpu'));

    // Background & Player
    assert.ok(backgroundJs.includes('Math.min(12, Math.floor(Number(request.workers)))'));
    assert.ok(backgroundJs.includes('ngrok-skip-browser-warning'));
    assert.ok(backgroundJs.includes('syncColabOriginStripRule'));
    assert.ok(backgroundJs.includes('stv-tts-batch'));
    assert.ok(playerJs.includes('COLAB_TIER_CONFIG') && playerJs.includes('getColabGpuExportConfig'));
    assert.ok(playerJs.includes('getColabGpuBatchSize'));
    assert.ok(playerJs.includes("requestedSource === 'colab_gpu'"));

    // Colab notebook & runner
    assert.equal(notebook.metadata.accelerator, 'GPU');
    assert.equal(notebook.metadata.colab.gpuType, 'T4');
    assert.equal(notebook.cells[0].metadata.cellView, 'form');
    assert.ok(runnerPy.includes('CORSMiddleware'));
    assert.ok(runnerPy.includes('le=12'));
    assert.ok(runnerPy.includes('"colab": True'));
    assert.ok(runnerPy.includes('/v1/audio/batch'));

    // i18n keys
    for (const key of [
        'tts_download_source_colab', 'tts_colab_btn_open', 'tts_colab_btn_paste',
        'settings_colab_gpu_label', 'optColabGpuT4', 'optColabGpuL4', 'optColabGpuA100', 'optColabGpuAuto'
    ]) {
        assert.ok(typeof i18n.DICTIONARY.vi[key] === 'string' && i18n.DICTIONARY.vi[key].length > 0, `Missing vi key ${key}`);
        assert.ok(typeof i18n.DICTIONARY.en[key] === 'string' && i18n.DICTIONARY.en[key].length > 0, `Missing en key ${key}`);
    }
});

async function runColabDownloadTest({
    lines = ['Tiêu Viêm bước ra khỏi đại điện.'],
    initialTranslated = true,
    hasTranslationApiKey = false,
    contentBoxText = '',
    ttsColabGpu = 'A100',
    downloadMinutes = 1,
    ttsExportTranslateConcurrency = 3,
    healthData = { status: 'ok', gpu_name: 'NVIDIA A100', export_max_streams: 12 },
    workerModeHandler = (msg) => ({ ok: true, data: { mode: msg.mode, max_streams: msg.workers || 6, active_workers: msg.workers || 6 } }),
    batchPortHandler = null,
    onSendMessage = null,
    onConnectPort = null,
    beforeDownload = null,
    extraSandbox = null,
    asyncDelayMs = 0
} = {}) {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const messages = [];
    const portStarts = [];
    const createdAnchorClicks = [];
    let activeStreams = 0;
    let maxConcurrentStreams = 0;

    const makeEl = (tag) => ({
        tagName: tag.toUpperCase(),
        style: {},
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        getAttribute() { return ''; },
        appendChild() {},
        append() {},
        remove() {},
        click() { createdAnchorClicks.push(this.download); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    });

    const makeLineEl = (textContent) => {
        const cls = new Set(['stv-line']);
        return {
            textContent,
            innerText: textContent,
            scrollIntoView() {},
            classList: {
                contains: (c) => cls.has(c),
                add: (c) => cls.add(c),
                remove: (c) => cls.delete(c)
            }
        };
    };

    const lineEls = initialTranslated ? lines.map(makeLineEl) : [];
    const setTranslatedLines = (newLines) => {
        lineEls.length = 0;
        for (const text of newLines) {
            lineEls.push(makeLineEl(text));
        }
    };
    const windowListeners = new Map();
    const doc = {
        head: { appendChild() {} },
        body: { appendChild() {} },
        documentElement: { appendChild() {} },
        contains: () => true,
        addEventListener() {},
        removeEventListener() {},
        getElementById(id) {
            if (id === 'stv-tts-root') return { shadowRoot: { innerHTML: '', append() {} } };
            return null;
        },
        querySelectorAll(sel) {
            if (sel && sel.includes('.stv-line')) return lineEls;
            return [];
        },
        createElement: makeEl
    };
    doc.body.querySelectorAll = doc.querySelectorAll;

    const sandbox = {
        window: undefined,
        globalThis: {},
        document: doc,
        location: { href: 'https://example.com/ch1' },
        URL: { createObjectURL: () => 'blob:mock-wav', revokeObjectURL() {} },
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
        Array,
        Set,
        Map,
        Promise,
        Error,
        CustomEvent: function CustomEvent(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        },
        setTimeout: (fn, ms, ...args) => {
            const handle = setTimeout(fn, ms, ...args);
            if (handle && typeof handle.unref === 'function') handle.unref();
            return handle;
        },
        clearTimeout,
        addEventListener(type, fn) {
            if (!windowListeners.has(type)) windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = windowListeners.get(type);
            if (set) set.delete(fn);
        },
        dispatchEvent(ev) {
            const set = windowListeners.get(ev && ev.type);
            if (!set) return true;
            for (const fn of Array.from(set)) {
                fn(ev);
            }
            return true;
        },
        ...(contentBoxText ? {
            STV_activeContentBox: {
                innerText: contentBoxText,
                querySelector: () => null,
                querySelectorAll: () => []
            }
        } : {}),
        chrome: {
            runtime: {
                id: 'test-ext-id',
                lastError: null,
                sendMessage(msg, cb) {
                    messages.push(msg);
                    if (typeof onSendMessage === 'function') {
                        const handled = onSendMessage({ msg, cb, sandbox, setTranslatedLines });
                        if (handled) return;
                    }
                    if (msg.action === 'get_tts_runtime_config') {
                        cb({
                            ok: true,
                            data: {
                                hasTranslationApiKey,
                                ttsEngine: 'webspeech',
                                ttsEndpoint: 'http://127.0.0.1:8000',
                                ttsDownloadSource: 'colab_gpu',
                                ttsColabUrl: 'https://fast-gpu.trycloudflare.com',
                                ttsColabVoice: 'Binh',
                                ttsColabGpu,
                                ttsExportTranslateConcurrency,
                                ttsIconMode: 'off'
                            }
                        });
                    } else if (msg.action === 'vieneu_check_health') {
                        cb({ ok: true, data: healthData });
                    } else if (msg.action === 'vieneu_set_worker_mode') {
                        cb(workerModeHandler(msg));
                    } else {
                        cb({ ok: true });
                    }
                },
                connect({ name }) {
                    const listeners = { msg: [], disc: [] };
                    if (typeof onConnectPort === 'function') {
                        const customPort = onConnectPort({ name, listeners });
                        if (customPort) return customPort;
                    }
                    return {
                        name,
                        onMessage: { addListener: (fn) => listeners.msg.push(fn) },
                        onDisconnect: { addListener: (fn) => listeners.disc.push(fn) },
                        disconnect() {},
                        postMessage(msg) {
                            if (msg.type === 'start') {
                                portStarts.push({ portName: name, ...msg });
                                activeStreams += 1;
                                maxConcurrentStreams = Math.max(maxConcurrentStreams, activeStreams);
                                const pcm = new Int16Array(2400).fill(500);
                                const b64 = Buffer.from(pcm.buffer).toString('base64');
                                if (name === 'stv-tts-batch' && typeof batchPortHandler === 'function') {
                                    const callNum = portStarts.filter((p) => p.portName === 'stv-tts-batch').length;
                                    queueMicrotask(() => {
                                        activeStreams -= 1;
                                        batchPortHandler({ msg, listeners, b64, callNum });
                                    });
                                    return;
                                }
                                const finish = () => {
                                    activeStreams -= 1;
                                    if (name === 'stv-tts-batch') {
                                        const inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
                                        inputs.forEach((_, idx) => {
                                            listeners.msg.forEach((fn) => fn({ type: 'item', index: idx, audio: b64, sampleRate: 24000 }));
                                        });
                                        listeners.msg.forEach((fn) => fn({ type: 'done', stats: { audioSec: 1.0, wallSec: 0.1, speedup: 10.0, dtype: 'float16' } }));
                                        return;
                                    }
                                    listeners.msg.forEach((fn) => fn({ type: 'chunk', audio: b64, sampleRate: 24000 }));
                                    listeners.msg.forEach((fn) => fn({ type: 'done' }));
                                };
                                if (asyncDelayMs > 0) {
                                    setTimeout(finish, asyncDelayMs);
                                } else {
                                    queueMicrotask(finish);
                                }
                            }
                        }
                    };
                }
            }
        }
    };
    if (extraSandbox && typeof extraSandbox === 'object') {
        Object.assign(sandbox, extraSandbox);
    }
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);

    if (typeof beforeDownload === 'function') {
        await beforeDownload({ sandbox, lineEls });
    }
    const res = await sandbox.STV_TTSController.startDownload({ downloadMinutes });
    return { res, sandbox, messages, portStarts, createdAnchorClicks, maxConcurrentStreams, lineEls };
}

test('startTTSDownload routes colab_gpu exports independently of webspeech listening engine', async () => {
    const { res, sandbox, messages, portStarts, createdAnchorClicks } = await runColabDownloadTest();
    assert.equal(res.ok, true, `Expected download ok, got: ${JSON.stringify(res)}`);
    assert.equal(sandbox.STV_TTSController.getState().engine, 'webspeech');
    assert.equal(portStarts.length, 1);
    assert.equal(portStarts[0].serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(portStarts[0].voice, 'Binh');

    const scaleExportMsg = messages.find((m) => m.action === 'vieneu_set_worker_mode' && m.mode === 'export');
    assert.ok(scaleExportMsg);
    assert.equal(scaleExportMsg.serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(scaleExportMsg.workers, 12);
    assert.equal(scaleExportMsg.gpuTier, 'A100');

    const scaleListenMsg = messages.find((m) => m.action === 'vieneu_set_worker_mode' && m.mode === 'listen');
    assert.ok(scaleListenMsg);
    assert.equal(scaleListenMsg.serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(createdAnchorClicks.length, 1);
});

test('colab_gpu fallback caps export concurrency to health.max_streams when scaling fails', async () => {
    // 6 distinct segments > 200 chars each so the exporter dispatches multiple concurrent requests
    const longParagraph = 'Tiêu Viêm vận chuyển đấu khí trong kinh mạch suốt một canh giờ không ngừng nghỉ, linh lực cuồn cuộn tụ lại thành vòng xoáy rực sáng khắp cả thạch thất rộng lớn trước ánh nhìn kinh ngạc của mọi người.';
    const lines = Array.from({ length: 6 }, (_, i) => `Đoạn ${i + 1}: ${longParagraph} ${longParagraph}`);
    const { res, portStarts, maxConcurrentStreams } = await runColabDownloadTest({
        lines,
        ttsColabGpu: 'L4',
        healthData: { status: 'ok', gpu_name: 'Tesla T4', max_streams: 2, export_max_streams: 8 },
        workerModeHandler: () => ({ ok: false, error: 'HTTP 422' }),
        asyncDelayMs: 10
    });
    assert.equal(res.ok, true, `Expected fallback download ok, got: ${JSON.stringify(res)}`);
    assert.ok(portStarts.length >= 4, `Expected >=4 segments, got ${portStarts.length}`);
    assert.ok(maxConcurrentStreams <= 2, `Expected concurrency <= health.max_streams (2), got ${maxConcurrentStreams}`);
});

test('startTTSDownload uses stv-tts-batch port and STV anchor prefix when Colab reports batch_supported', async () => {
    const longParagraph = 'Tiêu Viêm đứng trên đỉnh núi nhìn xuống hẻm núi sâu thẳm phía trước, đấu khí trong cơ thể chậm rãi vận chuyển qua từng kinh mạch khiến khí thế quanh thân càng thêm ngưng thực.';
    const lines = Array.from({ length: 5 }, (_, i) => `Khúc ${i + 1}: ${longParagraph} ${longParagraph}`);
    const { res, portStarts, createdAnchorClicks } = await runColabDownloadTest({
        lines,
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            model_dtype: 'float16',
            max_streams: 6,
            export_max_streams: 6
        }
    });
    assert.equal(res.ok, true, `Expected batch download ok, got: ${JSON.stringify(res)}`);
    assert.equal(createdAnchorClicks.length, 1);
    assert.equal(portStarts.length, 1, `Expected all segments sent in 1 batch call, got ${portStarts.length}`);
    assert.equal(portStarts[0].portName, 'stv-tts-batch');
    assert.equal(portStarts[0].batchSize, 16);
    assert.equal(portStarts[0].serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(portStarts[0].voice, 'Binh');
    assert.ok(Array.isArray(portStarts[0].inputs) && portStarts[0].inputs.length >= 4);
    assert.ok(portStarts[0].inputs.every((txt) => txt.startsWith('Một. ')), 'Every batch input must include anchor prefix');
});

test('STV_StvbStreamParser decodes fragmented STVB v1 streams including empty items and detects truncation', () => {
    const bgCode = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
    const noop = () => {};
    const sandbox = {
        globalThis: {},
        importScripts: noop,
        btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Uint8Array,
        ArrayBuffer,
        DataView,
        Buffer,
        Map,
        Set,
        Promise,
        Error,
        Object,
        Array,
        Number,
        String,
        Math,
        URL,
        URLSearchParams,
        TextDecoder,
        TextEncoder,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        console,
        chrome: {
            runtime: { lastError: null, onMessage: { addListener: noop }, onConnect: { addListener: noop } },
            tabs: { onUpdated: { addListener: noop }, onRemoved: { addListener: noop } },
            commands: { onCommand: { addListener: noop } },
            storage: { local: { get: noop, set: noop, remove: noop, setAccessLevel: noop } }
        }
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(bgCode, sandbox);

    const { createStvbStreamParser, uint8ArrayToBase64 } = sandbox.STV_StvbStreamParser;
    const item0 = Buffer.from([1, 2, 3, 4, 5, 6]);
    const item1 = Buffer.alloc(0);
    const item2 = Buffer.alloc(40000);
    for (let i = 0; i < item2.length; i++) item2[i] = i & 0xff;

    const hdr = Buffer.alloc(16);
    hdr.write('STVB', 0, 'ascii');
    hdr.writeUInt32LE(1, 4);
    hdr.writeUInt32LE(24000, 8);
    hdr.writeUInt32LE(3, 12);

    const wrap = (buf) => {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(buf.length, 0);
        return Buffer.concat([lenBuf, buf]);
    };
    const fullStream = Buffer.concat([hdr, wrap(item0), wrap(item1), wrap(item2)]);

    const received = [];
    const parser = createStvbStreamParser((idx, bytes, sr, codec) => {
        received.push({ idx, sr, codec, buf: Buffer.from(bytes), b64: uint8ArrayToBase64(bytes) });
        return true;
    }, 24000);

    // Feed odd chunk sizes: 1, 3, 7, 13, 1024...
    const stepSizes = [1, 3, 7, 13, 2, 5, 11, 1024];
    let pos = 0;
    let stepIdx = 0;
    while (pos < fullStream.length) {
        const sz = stepSizes[stepIdx % stepSizes.length];
        stepIdx += 1;
        parser.push(new Uint8Array(fullStream.subarray(pos, Math.min(fullStream.length, pos + sz))));
        pos += sz;
    }
    parser.finish();

    assert.equal(received.length, 3);
    assert.equal(received[0].sr, 24000);
    assert.equal(received[0].codec, 'pcm');
    assert.deepStrictEqual(received[0].buf, item0);
    assert.equal(received[1].buf.length, 0);
    assert.equal(received[1].b64, '');
    assert.deepStrictEqual(received[2].buf, item2);
    assert.deepStrictEqual(Buffer.from(received[2].b64, 'base64'), item2);

    // Verify STVB v2 (OGG/Opus) fragmented decoding
    const hdrV2 = Buffer.alloc(16);
    hdrV2.write('STVB', 0, 'ascii');
    hdrV2.writeUInt32LE(2, 4);
    hdrV2.writeUInt32LE(48000, 8);
    hdrV2.writeUInt32LE(2, 12);
    const v2Opus = Buffer.from('OggS-mock-opus-payload', 'ascii');
    const v2Stream = Buffer.concat([hdrV2, wrap(v2Opus), wrap(Buffer.alloc(0))]);
    const v2Received = [];
    const v2Parser = createStvbStreamParser((idx, bytes, sr, codec) => {
        v2Received.push({ idx, sr, codec, buf: Buffer.from(bytes) });
        return true;
    }, 24000);
    for (let i = 0; i < v2Stream.length; i += 3) {
        v2Parser.push(new Uint8Array(v2Stream.subarray(i, Math.min(v2Stream.length, i + 3))));
    }
    v2Parser.finish();
    assert.equal(v2Received.length, 2);
    assert.equal(v2Received[0].codec, 'opus');
    assert.equal(v2Received[0].sr, 48000);
    assert.deepStrictEqual(v2Received[0].buf, v2Opus);
    assert.equal(v2Received[1].buf.length, 0);

    const truncParser = createStvbStreamParser(() => true, 24000);
    truncParser.push(new Uint8Array(fullStream.subarray(0, fullStream.length - 5)));
    assert.throws(() => truncParser.finish(), /cắt cụt/);
});

test('synthesizeBatchForExport ignores keepalive and resumes remaining items after mid-batch port disconnect', async () => {
    const longParagraph = 'Tiêu Viêm vận chuyển đấu khí suốt nhiều canh giờ liền, dòng linh lực tinh thuần cuộn trào qua từng kinh mạch khiến khí thế quanh người tăng vọt.';
    const lines = Array.from({ length: 5 }, (_, i) => `Đoạn ${i + 1}: ${longParagraph} ${longParagraph}`);
    const seenInputsPerCall = [];

    const { res, createdAnchorClicks } = await runColabDownloadTest({
        lines,
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            model_dtype: 'float16'
        },
        batchPortHandler({ msg, listeners, b64, callNum }) {
            seenInputsPerCall.push(msg.inputs.slice());
            if (callNum === 1) {
                listeners.msg.forEach((fn) => fn({ type: 'keepalive' }));
                listeners.msg.forEach((fn) => fn({ type: 'item', index: 0, audio: b64, sampleRate: 24000 }));
                listeners.msg.forEach((fn) => fn({ type: 'item', index: 1, audio: b64, sampleRate: 24000 }));
                listeners.disc.forEach((fn) => fn());
                return;
            }
            msg.inputs.forEach((_, idx) => {
                listeners.msg.forEach((fn) => fn({ type: 'keepalive' }));
                listeners.msg.forEach((fn) => fn({ type: 'item', index: idx, audio: b64, sampleRate: 24000 }));
            });
            listeners.msg.forEach((fn) => fn({ type: 'done', stats: { audioSec: 1.0, wallSec: 0.2, speedup: 5.0, dtype: 'float16' } }));
        }
    });

    assert.equal(res.ok, true, `Expected resumed batch ok, got: ${JSON.stringify(res)}`);
    assert.equal(createdAnchorClicks.length, 1);
    assert.equal(seenInputsPerCall.length, 2, 'Should reconnect exactly once after partial disconnect');
    assert.equal(seenInputsPerCall[1].length, seenInputsPerCall[0].length - 2, 'Retry must request ONLY remaining items');
});

test('startTTSDownload uses OGG/Opus audioFormat and pipelines 2 concurrent stv-tts-batch requests', async () => {
    const longParagraph = 'Tiêu Viêm đứng trước cửa đá cổ xưa, đấu khí ngưng tụ nơi đầu ngón tay chuẩn bị phá giải phong ấn đã ngủ yên suốt ngàn năm.';
    // 25 distinct long segments -> with T4 batch_max_size=16 -> 2 batches (16 + 9)
    const lines = Array.from({ length: 25 }, (_, i) => `Mục ${i + 1}: ${longParagraph} ${longParagraph}`);
    let inFlightBatches = 0;
    let maxConcurrentBatches = 0;
    const decodeCalls = [];
    const opusB64 = Buffer.from('OggS-fake-opus-stream').toString('base64');

    const { res, portStarts, createdAnchorClicks } = await runColabDownloadTest({
        lines,
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            batch_codecs: ['opus', 'pcm'],
            model_dtype: 'float16'
        },
        extraSandbox: {
            OfflineAudioContext: class MockOfflineAudioContext {
                decodeAudioData(arrayBuf) {
                    decodeCalls.push(arrayBuf.byteLength);
                    const samples = new Float32Array(9600);
                    samples.fill(0.15);
                    return Promise.resolve({
                        sampleRate: 48000,
                        getChannelData: () => samples
                    });
                }
            }
        },
        batchPortHandler({ msg, listeners }) {
            inFlightBatches += 1;
            maxConcurrentBatches = Math.max(maxConcurrentBatches, inFlightBatches);
            setTimeout(() => {
                msg.inputs.forEach((_, idx) => {
                    listeners.msg.forEach((fn) => fn({
                        type: 'item',
                        index: idx,
                        audio: opusB64,
                        sampleRate: 48000,
                        codec: 'opus'
                    }));
                });
                inFlightBatches -= 1;
                listeners.msg.forEach((fn) => fn({
                    type: 'done',
                    stats: { audioSec: 5.0, wallSec: 0.2, speedup: 25.0, dtype: 'float16', codec: 'opus' }
                }));
            }, 20);
        }
    });

    assert.equal(res.ok, true, `Expected pipelined opus batch ok, got: ${JSON.stringify(res)}`);
    assert.equal(createdAnchorClicks.length, 1);
    assert.equal(portStarts.length, 2, `Expected 2 batches for 25 segments, got ${portStarts.length}`);
    assert.ok(portStarts.every((p) => p.audioFormat === 'opus'), 'Every batch request must request audioFormat=opus');
    assert.equal(maxConcurrentBatches, 2, `Expected 2 concurrent pipelined batches, got ${maxConcurrentBatches}`);
    assert.equal(decodeCalls.length, 25, `Expected OfflineAudioContext.decodeAudioData called 25 times, got ${decodeCalls.length}`);
});

test('containsForeignCjkText distinguishes CJK/Kana/Hangul prose from Vietnamese text', () => {
    const helpers = loadTtsHelpers();
    assert.equal(helpers.containsForeignCjkText([{ text: '萧炎站在大殿之外，凝视着远方的火焰山脉，心中却涌起一阵莫名的悸动。' }]), true);
    assert.equal(helpers.containsForeignCjkText(['ひらがなとカタカナと漢字が混ざった短い文章です。']), true);
    assert.equal(helpers.containsForeignCjkText(['Tiêu Viêm đứng ngoài đại điện, chăm chú nhìn dãy núi lửa ở phương xa.']), false);
    assert.equal(
        helpers.containsForeignCjkText(['Dịch giả ghi chú: chữ 好 xuất hiện một lần ở giữa đoạn văn rất dài tiếng Việt này để kiểm tra bộ lọc.']),
        false
    );
});

test('startTTSDownload exports full chapter from line 0 even when live playback highlights a later line', async () => {
    const pad = 'Linh khí cuộn trào khắp kinh mạch khiến khung cảnh xung quanh rung chuyển dữ dội, từng luồng ánh sáng lan tỏa khắp đại điện cổ xưa suốt một canh giờ.';
    const lines = [
        `Đoạn mở đầu một: ${pad}`,
        `Đoạn tiếp hai: ${pad}`,
        `Đoạn giữa ba: ${pad}`,
        `Đoạn cuối bốn: ${pad}`
    ];

    class MockSpeechUtterance {
        constructor(text) {
            this.text = text;
            this.rate = 1;
            this.lang = '';
        }
    }

    let highlightedBeforeDownload = false;
    const { res, portStarts, lineEls, createdAnchorClicks } = await runColabDownloadTest({
        lines,
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            model_dtype: 'float16'
        },
        extraSandbox: {
            SpeechSynthesisUtterance: MockSpeechUtterance,
            speechSynthesis: {
                cancel() {},
                speak() {},
                getVoices() { return []; }
            }
        },
        async beforeDownload({ sandbox, lineEls: els }) {
            const playRes = await sandbox.STV_TTSController.start({ engine: 'webspeech', startIndex: 2 });
            assert.equal(playRes.ok, true);
            assert.equal(playRes.totalSegments, 4);
            highlightedBeforeDownload = els[2].classList.contains('stv-tts-speaking');
        }
    });

    assert.equal(highlightedBeforeDownload, true, 'Segment 2 should be highlighted before download starts');
    assert.equal(lineEls[2].classList.contains('stv-tts-speaking'), false, 'Download should clear live highlight');
    assert.equal(res.ok, true, `Expected full export ok, got: ${JSON.stringify(res)}`);
    assert.equal(createdAnchorClicks.length, 1);
    assert.equal(portStarts.length, 1);
    const exportedInputs = portStarts[0].inputs.join('\n');
    for (const prefix of ['Đoạn mở đầu một', 'Đoạn tiếp hai', 'Đoạn giữa ba', 'Đoạn cuối bốn']) {
        assert.ok(exportedInputs.includes(prefix), `Missing full-chapter segment "${prefix}" in exported batch`);
    }
});

test('startTTSDownload auto-translates untranslated chapter with suppressAutoPlay before exporting', async () => {
    const translatedLines = [
        'Đoạn dịch thứ nhất: Tiêu Viêm nhẹ nhàng đẩy cánh cửa đá cổ xưa bước vào sảnh lớn.',
        'Đoạn dịch thứ hai: Ánh lửa lập lòe chiếu rọi khắp vách đá khắc đầy minh văn kỳ bí.'
    ];

    const { res, messages, portStarts, createdAnchorClicks } = await runColabDownloadTest({
        initialTranslated: false,
        hasTranslationApiKey: true,
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            model_dtype: 'float16'
        },
        onSendMessage({ msg, cb, sandbox, setTranslatedLines }) {
            if (msg.action !== 'translate_active_tab') return false;
            sandbox.STV_translationState = { active: true, runId: 7 };
            cb({ ok: true, data: 'success' });
            setTimeout(() => {
                setTranslatedLines(translatedLines);
                sandbox.STV_translationState = { active: false, runId: 7 };
                sandbox.dispatchEvent(new sandbox.CustomEvent('stv-translation-progress', {
                    detail: { runId: 7, active: false }
                }));
            }, 15);
            return true;
        }
    });

    assert.equal(res.ok, true, `Expected auto-translate download ok, got: ${JSON.stringify(res)}`);
    const transMsg = messages.find((m) => m.action === 'translate_active_tab');
    assert.ok(transMsg, 'Expected translate_active_tab to be dispatched for untranslated DOM');
    assert.equal(transMsg.suppressAutoPlay, true, 'Auto-translation during export must suppress live auto-play');
    assert.equal(createdAnchorClicks.length, 1);
    assert.equal(portStarts.length, 1);
    const exportedText = portStarts[0].inputs.join('\n');
    assert.ok(exportedText.includes('Đoạn dịch thứ nhất'));
    assert.ok(exportedText.includes('Đoạn dịch thứ hai'));
});

test('startTTSDownload stops cleanly without TTS requests when chapter is untranslated CJK without API key', async () => {
    const { res, messages, portStarts, createdAnchorClicks } = await runColabDownloadTest({
        initialTranslated: false,
        hasTranslationApiKey: false,
        contentBoxText: '萧炎站在大殿之外，凝视着远方的火焰山脉，心中却涌起一阵莫名的悸动。\n药老的声音在他识海中缓缓响起，提醒他小心四周潜伏的危机。',
        ttsColabGpu: 'T4',
        healthData: {
            status: 'ok',
            gpu_name: 'Tesla T4',
            batch_supported: true,
            batch_max_size: 16,
            model_dtype: 'float16'
        }
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, 'untranslated_foreign_text');
    assert.equal(messages.some((m) => m.action === 'translate_active_tab'), false);
    assert.equal(messages.some((m) => m.action === 'vieneu_set_worker_mode' && m.mode === 'export'), false);
    assert.equal(portStarts.length, 0, 'Must not dispatch TTS synthesis on raw foreign CJK prose');
    assert.equal(createdAnchorClicks.length, 0);
});

function loadGlossaryUtilsSandbox() {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'glossary-utils.js'), 'utf8');
    const sandbox = { window: undefined, globalThis: {}, console, Set, Object, Array, RegExp, String, Math };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return sandbox.STV_GlossaryUtils;
}

test('glossary-utils buildGlossaryPreExtractPromptPayload and extractGlossaryTermsFromResponseText handle multi-chapter pre-extraction', () => {
    const utils = loadGlossaryUtilsSandbox();
    const raw = '萧炎和云韵进入落神涧寻找紫灵晶。';
    const existing = {
        '萧炎': { hanviet: 'Tiêu Viêm', locked: true },
        '药老': { hanviet: 'Dược Lão', locked: false }
    };

    const payload = utils.buildGlossaryPreExtractPromptPayload(raw, existing);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.matchedGlossary)), { '萧炎': 'Tiêu Viêm' });
    assert.ok(payload.finalSystemPrompt.includes('萧炎 = Tiêu Viêm'));
    assert.ok(!payload.finalSystemPrompt.includes('药老 = Dược Lão'));
    assert.ok(payload.userMessage.includes('Không dịch') || payload.userMessage.includes('không dịch'));

    const extractedTagged = utils.extractGlossaryTermsFromResponseText(
        '```text\n[GLOSSARY]\n云韵 = Vân Vận\n长老 = trưởng lão\n紫灵晶 = Tử Linh Tinh\n```'
    );
    assert.deepEqual(JSON.parse(JSON.stringify(extractedTagged.newTerms)), {
        '云韵': { hanviet: 'Vân Vận', locked: false },
        '紫灵晶': { hanviet: 'Tử Linh Tinh', locked: false }
    });
    assert.ok(extractedTagged.skippedTerms.some((s) => s.includes('长老')));

    const extractedBare = utils.extractGlossaryTermsFromResponseText('落神涧 = Lạc Thần Giản\n弟子 = đệ tử');
    assert.deepEqual(JSON.parse(JSON.stringify(extractedBare.newTerms)), {
        '落神涧': { hanviet: 'Lạc Thần Giản', locked: false }
    });
});

test('estimateRawChapterDurationSec models CJK expansion factor, speed, and Chapter-1 calibration', () => {
    const helpers = loadTtsHelpers();
    const hanzi100 = '萧'.repeat(100);
    const estHanzi1x = helpers.estimateRawChapterDurationSec([hanzi100], 1.0);
    assert.ok(Math.abs(estHanzi1x - (430 / 14)) < 0.05, `Expected ~30.71s for 100 Hanzi, got ${estHanzi1x}`);

    const estHanzi15x = helpers.estimateRawChapterDurationSec([hanzi100], 1.5);
    assert.ok(Math.abs(estHanzi15x - (430 / 21)) < 0.05, `Expected ~20.48s at 1.5x speed, got ${estHanzi15x}`);

    const estCalibrated = helpers.estimateRawChapterDurationSec([hanzi100], 1.0, { measuredViCharsPerSec: 20 });
    assert.ok(Math.abs(estCalibrated - (430 / 20)) < 0.05, `Expected 21.5s when calibrated to 20 chars/s, got ${estCalibrated}`);

    const vi100 = 'a'.repeat(100);
    const estVi = helpers.estimateRawChapterDurationSec([vi100], 1.0);
    assert.ok(Math.abs(estVi - (100 / 14)) < 0.05, `Expected ~7.14s for 100 Vietnamese chars, got ${estVi}`);
});

function createMultiChapterPreloadHarness({
    chaptersByUrl,
    preloadDelayMs = 25,
    onGlossaryPreExtract = null,
    onSubscribePreload = null,
    rateLimitedUrls = new Set()
}) {
    const eventLog = [];
    const subscribers = new Map();
    const completed = new Map();
    const cancelledIds = new Set();
    let inFlightTranslations = 0;
    let maxConcurrentTranslations = 0;
    let activeExportSessionId = '';

    const deliver = (preloadId, payload) => {
        const sub = subscribers.get(preloadId);
        if (sub && !sub.closed) {
            sub.listeners.msg.forEach((fn) => fn(payload));
        }
    };

    return {
        eventLog,
        getMaxConcurrentTranslations: () => maxConcurrentTranslations,
        onSendMessage({ msg, cb }) {
            if (msg.action === 'probe_chapter_raw') {
                const ch = chaptersByUrl[msg.url];
                if (!ch) {
                    cb({ ok: false, error: `Unknown probe url ${msg.url}` });
                    return true;
                }
                eventLog.push(`probe:${ch.id}`);
                cb({
                    ok: true,
                    preloadId: `tab1|${msg.url}`,
                    targetUrl: msg.url,
                    origChunks: ch.rawChunks,
                    nextUrl: ch.nextUrl || null,
                    alreadyReady: false,
                    alreadyTranslating: false
                });
                return true;
            }
            if (msg.action === 'pre_extract_export_glossary') {
                eventLog.push(`glossary:${msg.chapters.map((c) => c.chapterNumber).join(',')}`);
                if (typeof onGlossaryPreExtract === 'function') {
                    onGlossaryPreExtract(msg, cb);
                } else {
                    cb({ ok: true, addedCount: 2, updated: true });
                }
                return true;
            }
            if (msg.action === 'cancel_export_prefetches') {
                eventLog.push('cancel_export_prefetches');
                if (msg.exportSessionId) activeExportSessionId = msg.exportSessionId;
                for (const [pid, sub] of subscribers.entries()) {
                    if (!completed.has(pid) && !msg.keepReady === false) {
                        cancelledIds.add(pid);
                    }
                    if (!completed.has(pid)) {
                        sub.listeners.msg.forEach((fn) => fn({ type: 'error', error: 'Export cancelled', rateLimited: false }));
                    }
                }
                cb({ ok: true });
                return true;
            }
            if (msg.action === 'start_chapter_preload') {
                const preloadId = `tab1|${msg.url}`;
                const ch = chaptersByUrl[msg.url];
                activeExportSessionId = msg.exportSessionId || activeExportSessionId;
                cancelledIds.delete(preloadId);
                eventLog.push(`preload_start:${ch ? ch.id : msg.url}`);
                cb({ ok: true, preloadId, status: completed.has(preloadId) ? 'ready' : 'translating' });

                if (!completed.has(preloadId)) {
                    inFlightTranslations += 1;
                    maxConcurrentTranslations = Math.max(maxConcurrentTranslations, inFlightTranslations);
                    const t = setTimeout(() => {
                        inFlightTranslations = Math.max(0, inFlightTranslations - 1);
                        if (cancelledIds.has(preloadId)) return;
                        eventLog.push(`preload_done:${ch ? ch.id : msg.url}`);
                        const payload = {
                            type: 'delta',
                            fullText: `[TRANSLATION]\n${ch ? ch.translatedText : 'Nội dung mặc định.'}\n[GLOSSARY]\n`,
                            origChunks: ch ? ch.rawChunks : [],
                            nextUrl: ch ? (ch.nextUrl || null) : null,
                            done: true,
                            rateLimited: rateLimitedUrls.has(msg.url)
                        };
                        completed.set(preloadId, payload);
                        deliver(preloadId, payload);
                    }, preloadDelayMs);
                    if (typeof t.unref === 'function') t.unref();
                }
                return true;
            }
            return false;
        },
        onConnectPort({ name, listeners }) {
            if (name !== 'stv-preload-stream') return null;
            const portObj = {
                name,
                closed: false,
                onMessage: { addListener: (fn) => listeners.msg.push(fn) },
                onDisconnect: { addListener: (fn) => listeners.disc.push(fn) },
                disconnect() { this.closed = true; },
                postMessage(msg) {
                    if (msg && msg.type === 'subscribe') {
                        const preloadId = msg.preloadId;
                        const entry = { listeners, closed: false };
                        subscribers.set(preloadId, entry);
                        if (typeof onSubscribePreload === 'function') {
                            const customHandled = onSubscribePreload({ preloadId, listeners, deliver, completed, eventLog });
                            if (customHandled) return;
                        }
                        if (completed.has(preloadId)) {
                            const donePayload = completed.get(preloadId);
                            queueMicrotask(() => {
                                if (!portObj.closed) {
                                    listeners.msg.forEach((fn) => fn({ ...donePayload, type: 'snapshot' }));
                                }
                            });
                        }
                    }
                }
            };
            return portObj;
        }
    };
}

test('multi-chapter WAV pipeline probes sequentially, pre-extracts glossary before wave, translates in parallel (cap 3), and exports in order', async () => {
    const ch1Text = 'Chương một mở đầu: Tiêu Viêm bước vào cổ điện tĩnh mịch. '.repeat(4).trim(); // ~224 chars (~16s at 14 chars/s)
    const rawHanzi = '萧炎站在大殿之外，凝视着远方的火焰山脉，心中却涌起一阵莫名的悸动。'.repeat(3); // 90 Hanzi + 9 punct (~28.3s est)
    const longPad = 'Linh khí cuộn trào khắp kinh mạch khiến thiên địa biến sắc dữ dội suốt canh giờ dài.';
    const chaptersByUrl = {
        'https://example.com/ch2': { id: 'ch2', rawChunks: [rawHanzi], translatedText: `Chương 2 nội dung: ${longPad}`, nextUrl: 'https://example.com/ch3' },
        'https://example.com/ch3': { id: 'ch3', rawChunks: [rawHanzi], translatedText: `Chương 3 nội dung: ${longPad}`, nextUrl: 'https://example.com/ch4' },
        'https://example.com/ch4': { id: 'ch4', rawChunks: [rawHanzi], translatedText: `Chương 4 nội dung: ${longPad}`, nextUrl: 'https://example.com/ch5' },
        'https://example.com/ch5': { id: 'ch5', rawChunks: [rawHanzi], translatedText: `Chương 5 nội dung: ${longPad}`, nextUrl: 'https://example.com/ch6' },
        'https://example.com/ch6': { id: 'ch6', rawChunks: [rawHanzi], translatedText: `Chương 6 nội dung: ${longPad}`, nextUrl: null }
    };

    const harness = createMultiChapterPreloadHarness({ chaptersByUrl, preloadDelayMs: 25 });
    const pcm16s = Buffer.from(new Int16Array(24000 * 16).buffer).toString('base64');
    const pcm38s = Buffer.from(new Int16Array(24000 * 38).buffer).toString('base64');

    const { res, sandbox, messages, portStarts } = await runColabDownloadTest({
        lines: [ch1Text],
        downloadMinutes: 2, // 120s target => Ch1 (16s) + Ch2 (38s) + Ch3 (38s) + Ch4 (38s) = 130s
        ttsExportTranslateConcurrency: 3,
        ttsColabGpu: 'T4',
        healthData: { status: 'ok', gpu_name: 'Tesla T4', batch_supported: true, batch_max_size: 16, model_dtype: 'float16' },
        onSendMessage: harness.onSendMessage,
        onConnectPort: harness.onConnectPort,
        extraSandbox: {
            STV_findNextChapterUrl: (_doc, url) => (url === 'https://example.com/ch1' ? 'https://example.com/ch2' : null)
        },
        batchPortHandler({ msg, listeners }) {
            const isCh1 = String(msg.inputs[0] || '').includes('Chương một mở đầu');
            const delayMs = isCh1 ? 520 : 20;
            const audioB64 = isCh1 ? pcm16s : pcm38s;
            const audioSec = isCh1 ? 16 : 38;
            const t = setTimeout(() => {
                msg.inputs.forEach((_, idx) => {
                    listeners.msg.forEach((fn) => fn({ type: 'item', index: idx, audio: audioB64, sampleRate: 24000 }));
                });
                listeners.msg.forEach((fn) => fn({ type: 'done', stats: { audioSec, wallSec: 0.1, speedup: 350, dtype: 'float16' } }));
            }, delayMs);
            if (typeof t.unref === 'function') t.unref();
        }
    });

    assert.equal(res.ok, true, `Expected pipeline export ok, got: ${JSON.stringify(res)}`);
    assert.equal(res.chapters, 4, 'Expected 4 chapters (130s) to hit 2m (120s) target');
    assert.equal(harness.getMaxConcurrentTranslations(), 3, 'Parallel translation pool must run 3 concurrent jobs');

    const lastWaveProbeIdx = Math.max(
        harness.eventLog.indexOf('probe:ch2'),
        harness.eventLog.indexOf('probe:ch3'),
        harness.eventLog.indexOf('probe:ch4'),
        harness.eventLog.indexOf('probe:ch5')
    );
    const glossaryIdx = harness.eventLog.indexOf('glossary:2,3,4,5');
    const firstPreloadIdx = harness.eventLog.indexOf('preload_start:ch2');
    assert.ok(lastWaveProbeIdx !== -1 && glossaryIdx > lastWaveProbeIdx, `Expected pre-extract glossary after probing wave: ${harness.eventLog}`);
    assert.ok(firstPreloadIdx > glossaryIdx, `Expected parallel translations after glossary pre-extract: ${harness.eventLog}`);
    assert.equal(harness.eventLog.includes('probe:ch6'), false, 'Should stop probing once wave projected duration covers target');

    const preloadStarts = messages.filter((m) => m.action === 'start_chapter_preload');
    assert.ok(preloadStarts.length >= 4 && preloadStarts.every((m) => m.preserveOtherPreloads === true));

    const synthOrder = portStarts.filter((p) => p.portName === 'stv-tts-batch').map((p) => p.inputs[0]);
    assert.equal(synthOrder.length, 4);
    assert.ok(synthOrder[0].includes('Chương một mở đầu'));
    assert.ok(synthOrder[1].includes('Chương 2 nội dung'));
    assert.ok(synthOrder[2].includes('Chương 3 nội dung'));
    assert.ok(synthOrder[3].includes('Chương 4 nội dung'));

    assert.equal(sandbox.STV_TTSController.getState().nextOpenUrl, 'https://example.com/ch5');
    const cancelMsg = messages.find((m) => m.action === 'cancel_export_prefetches');
    assert.ok(cancelMsg && cancelMsg.keepReady === true);
});

test('stv-preload-stream ignores keepalive and auto-reconnects after mid-stream port disconnect', async () => {
    const ch1Text = 'Chương một nội dung đủ dài cho bài kiểm tra. '.repeat(4).trim(); // ~180 chars (< 300)
    const rawHanzi = '萧炎站在大殿之外，凝视着远方的火焰山脉，心中却涌起一阵莫名的悸动。'.repeat(2);
    const chaptersByUrl = {
        'https://example.com/ch2': {
            id: 'ch2',
            rawChunks: [rawHanzi],
            translatedText: 'Chương 2 sau khi tự kết nối lại background thành công.',
            nextUrl: 'https://example.com/ch3'
        },
        'https://example.com/ch3': {
            id: 'ch3',
            rawChunks: [rawHanzi],
            translatedText: 'Chương 3 dự phòng.',
            nextUrl: null
        }
    };
    let ch2SubscribeCount = 0;
    const harness = createMultiChapterPreloadHarness({
        chaptersByUrl,
        preloadDelayMs: 30,
        onSubscribePreload({ preloadId, listeners, deliver, eventLog }) {
            if (!preloadId.endsWith('/ch2')) return false;
            ch2SubscribeCount += 1;
            if (ch2SubscribeCount === 1) {
                eventLog.push('ch2_first_subscribe_keepalive_then_disconnect');
                queueMicrotask(() => {
                    listeners.msg.forEach((fn) => fn({ type: 'keepalive' }));
                    listeners.disc.forEach((fn) => fn());
                });
                return true;
            }
            eventLog.push('ch2_second_subscribe_keepalive_then_done');
            const t = setTimeout(() => {
                listeners.msg.forEach((fn) => fn({ type: 'keepalive' }));
                deliver(preloadId, {
                    type: 'delta',
                    fullText: `[TRANSLATION]\n${chaptersByUrl['https://example.com/ch2'].translatedText}\n[GLOSSARY]\n`,
                    origChunks: [rawHanzi],
                    nextUrl: 'https://example.com/ch3',
                    done: true,
                    rateLimited: false
                });
            }, 25);
            if (typeof t.unref === 'function') t.unref();
            return true;
        }
    });

    const pcm35s = Buffer.from(new Int16Array(24000 * 35).buffer).toString('base64');
    const { res, sandbox } = await runColabDownloadTest({
        lines: [ch1Text],
        downloadMinutes: 1, // 60s -> Ch1 (35s) + Ch2 (35s) = 70s
        ttsExportTranslateConcurrency: 2,
        ttsColabGpu: 'T4',
        healthData: { status: 'ok', gpu_name: 'Tesla T4', batch_supported: true, batch_max_size: 16, model_dtype: 'float16' },
        onSendMessage: harness.onSendMessage,
        onConnectPort: harness.onConnectPort,
        extraSandbox: {
            STV_findNextChapterUrl: (_doc, url) => (url === 'https://example.com/ch1' ? 'https://example.com/ch2' : null)
        },
        batchPortHandler({ msg, listeners }) {
            queueMicrotask(() => {
                msg.inputs.forEach((_, idx) => {
                    listeners.msg.forEach((fn) => fn({ type: 'item', index: idx, audio: pcm35s, sampleRate: 24000 }));
                });
                listeners.msg.forEach((fn) => fn({ type: 'done', stats: { audioSec: 35, wallSec: 0.1, speedup: 350, dtype: 'float16' } }));
            });
        }
    });

    assert.equal(res.ok, true, `Expected auto-reconnect export ok, got: ${JSON.stringify(res)}`);
    assert.equal(res.chapters, 2);
    assert.equal(ch2SubscribeCount, 2, 'Expected stv-preload-stream to reconnect for ch2 after transient disconnect');
    assert.equal(sandbox.STV_TTSController.getState().nextOpenUrl, 'https://example.com/ch3');
});

test('export translation pool steps down concurrency on rateLimited (429) response', async () => {
    const ch1Text = 'Chương một nội dung chuẩn hóa độ dài. '.repeat(4).trim(); // ~160 chars (< 300)
    const rawHanzi = '萧炎站在大殿之外，凝视着远方的火焰山脉，心中却涌起一阵莫名的悸动。'.repeat(3);
    const pad = 'Tiêu Viêm vận chuyển đấu khí suốt nhiều canh giờ liền để phá phong ấn.';
    const chaptersByUrl = {
        'https://example.com/ch2': { id: 'ch2', rawChunks: [rawHanzi], translatedText: `Ch2: ${pad}`, nextUrl: 'https://example.com/ch3' },
        'https://example.com/ch3': { id: 'ch3', rawChunks: [rawHanzi], translatedText: `Ch3: ${pad}`, nextUrl: 'https://example.com/ch4' },
        'https://example.com/ch4': { id: 'ch4', rawChunks: [rawHanzi], translatedText: `Ch4: ${pad}`, nextUrl: 'https://example.com/ch5' },
        'https://example.com/ch5': { id: 'ch5', rawChunks: [rawHanzi], translatedText: `Ch5: ${pad}`, nextUrl: null }
    };

    const harness = createMultiChapterPreloadHarness({
        chaptersByUrl,
        preloadDelayMs: 25,
        onGlossaryPreExtract(_msg, cb) {
            // Simulate 429 rate limit on pre-extract -> pipeline falls back & steps down concurrency 3 -> 2
            cb({ ok: false, status: 429, error: 'Too Many Requests', rateLimited: true });
        }
    });
    const pcm35s = Buffer.from(new Int16Array(24000 * 35).buffer).toString('base64');

    const { res } = await runColabDownloadTest({
        lines: [ch1Text],
        downloadMinutes: 2,
        ttsExportTranslateConcurrency: 3,
        ttsColabGpu: 'T4',
        healthData: { status: 'ok', gpu_name: 'Tesla T4', batch_supported: true, batch_max_size: 16, model_dtype: 'float16' },
        onSendMessage: harness.onSendMessage,
        onConnectPort: harness.onConnectPort,
        extraSandbox: {
            STV_findNextChapterUrl: (_doc, url) => (url === 'https://example.com/ch1' ? 'https://example.com/ch2' : null)
        },
        batchPortHandler({ msg, listeners }) {
            queueMicrotask(() => {
                msg.inputs.forEach((_, idx) => {
                    listeners.msg.forEach((fn) => fn({ type: 'item', index: idx, audio: pcm35s, sampleRate: 24000 }));
                });
                listeners.msg.forEach((fn) => fn({ type: 'done', stats: { audioSec: 35, wallSec: 0.1, speedup: 350, dtype: 'float16' } }));
            });
        }
    });

    assert.equal(res.ok, true, `Expected graceful fallback after rate-limited pre-extract, got: ${JSON.stringify(res)}`);
    assert.equal(res.chapters, 4);
    assert.equal(harness.getMaxConcurrentTranslations(), 2, 'Concurrency should step down from 3 to 2 on rateLimited');
});

test('popup, i18n, and background expose parallel WAV translation wiring and MV3 keepalive contracts', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
    const i18n = require(path.resolve(__dirname, '..', 'i18n.js'));

    assert.ok(html.includes('id="tts-export-translate-concurrency"'));
    for (let i = 1; i <= 6; i++) {
        assert.ok(html.includes(`value="${i}"`), `popup.html missing concurrency option ${i}`);
    }
    assert.ok(popupJs.includes('ttsExportTranslateConcurrency'));
    assert.ok(popupJs.includes('normalizeExportTranslateConcurrency'));

    assert.ok(backgroundJs.includes('!redirectCheck.valid'));
    assert.equal(backgroundJs.includes('redirectCheck.allowed'), false);
    assert.ok(backgroundJs.includes('probe_chapter_raw'));
    assert.ok(backgroundJs.includes('pre_extract_export_glossary'));
    assert.ok(backgroundJs.includes('cancel_export_prefetches'));
    assert.ok(backgroundJs.includes('glossarySaveQueues'));
    assert.ok(backgroundJs.includes('ttsExportTranslateConcurrency'));
    assert.ok(backgroundJs.includes("safePortPost(port, { type: 'keepalive' })"));

    for (const key of [
        'tts_export_translate_concurrency_label',
        'optExportTransConc1', 'optExportTransConc2', 'optExportTransConc3',
        'optExportTransConc4', 'optExportTransConc5', 'optExportTransConc6',
        'tts_dl_pre_extract_glossary', 'tts_dl_progress_parallel'
    ]) {
        assert.ok(typeof i18n.DICTIONARY.vi[key] === 'string' && i18n.DICTIONARY.vi[key].length > 0, `Missing vi key ${key}`);
        assert.ok(typeof i18n.DICTIONARY.en[key] === 'string' && i18n.DICTIONARY.en[key].length > 0, `Missing en key ${key}`);
    }
});
