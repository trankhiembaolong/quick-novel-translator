/**
 * test-e2e/tier1-features/extractor.test.js
 * Feature 2: Safe Extraction & DOM XSS Remediation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupSandbox,
    teardownSandbox,
    STV_convertHtmlToTextChunks,
    STV_findContentBoxInDocument,
    STV_findNextChapterUrl
} from '../harness/index.js';

describe('Feature 2: Safe Extraction & DOM XSS Remediation', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.7: extracts clean text chunks from novel container', () => {
        const html = `
            <div id="chapter-content">
                <p>Tiêu Viêm thở dài một hơi, chậm rãi đứng dậy.</p>
                <p>Hắn nhìn về phía chân trời xa xôi, ánh mắt kiên định.</p>
                <p>Nạp Lan Yên Nhiên, ba năm ước hẹn, ta nhất định sẽ tới Vân Lam Tông!</p>
            </div>
        `;

        const raw = STV_convertHtmlToTextChunks(html);
        const chunks = raw.map(s => s.trim()).filter(Boolean);
        assert.strictEqual(chunks.length, 3);
        assert.strictEqual(chunks[0], 'Tiêu Viêm thở dài một hơi, chậm rãi đứng dậy.');
        assert.strictEqual(chunks[1], 'Hắn nhìn về phía chân trời xa xôi, ánh mắt kiên định.');
        assert.strictEqual(chunks[2], 'Nạp Lan Yên Nhiên, ba năm ước hẹn, ta nhất định sẽ tới Vân Lam Tông!');
    });

    it('T1.8: safely decodes HTML entities into literal text without executing script tags', () => {
        const html = `
            <div id="chapter-content">
                <p>&lt;b&gt;Thiên Đạo&lt;/b&gt; &amp; &quot;Luân Hồi&quot; &#39;Nghịch Mệnh&#39;</p>
                <p>Khoảng cách &nbsp;&nbsp; giữa các chữ.</p>
            </div>
        `;

        const raw = STV_convertHtmlToTextChunks(html);
        const chunks = raw.map(s => s.trim()).filter(Boolean);
        assert.strictEqual(chunks.length, 2);
        assert.strictEqual(chunks[0], '<b>Thiên Đạo</b> & "Luân Hồi" \'Nghịch Mệnh\'');
        assert.strictEqual(chunks[1], 'Khoảng cách    giữa các chữ.');
    });

    it('T1.9: separates paragraphs along block-level HTML tags', () => {
        const html = `
            <div id="chapter-content">
                <h1>Chương 1: Thiên Chi Kiều Tử</h1>
                <p>Đoạn văn thứ nhất trong chương.</p>
                <div>Đoạn văn thứ hai nằm trong thẻ div.</div>
                <blockquote>Lời bình luận của tác giả.</blockquote>
            </div>
        `;

        const raw = STV_convertHtmlToTextChunks(html);
        const chunks = raw.map(s => s.trim()).filter(Boolean);
        assert.strictEqual(chunks.length, 4);
        assert.strictEqual(chunks[0], 'Chương 1: Thiên Chi Kiều Tử');
        assert.strictEqual(chunks[1], 'Đoạn văn thứ nhất trong chương.');
        assert.strictEqual(chunks[2], 'Đoạn văn thứ hai nằm trong thẻ div.');
        assert.strictEqual(chunks[3], 'Lời bình luận của tác giả.');
    });

    it('T1.10: completely removes dangerous tags including script, style, and iframe', () => {
        const html = `
            <div id="chapter-content">
                <script>window.Pwned = true; alert('XSS');</script>
                <p>Nội dung chính truyện bình thường.</p>
                <style>.hidden { display: none; }</style>
                <iframe src="https://malicious.test/exploit"></iframe>
                <noscript>Vui lòng bật javascript</noscript>
                <p>Đoạn văn sau phần mã độc hại.</p>
            </div>
        `;

        const raw = STV_convertHtmlToTextChunks(html);
        const chunks = raw.map(s => s.trim()).filter(Boolean);
        assert.strictEqual(chunks.length, 2);
        assert.strictEqual(chunks[0], 'Nội dung chính truyện bình thường.');
        assert.strictEqual(chunks[1], 'Đoạn văn sau phần mã độc hại.');
        assert.strictEqual(globalThis.Pwned, undefined, 'Script must not execute during extraction');
    });

    it('T1.11: identifies chapter content container using priority selectors', () => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`
            <div class="sidebar">Sidebar quảng cáo không phải truyện</div>
            <div class="reading-content">
                <p>Nội dung thực sự của chương tiểu thuyết dài hơn 150 ký tự để vượt qua ngưỡng lọc văn bản thực sự của hệ thống extractor trong truyện tiểu thuyết này. Đoạn văn tiếp tục kéo dài để đảm bảo độ dài vượt ngưỡng tối thiểu.</p>
            </div>
        `, 'text/html');

        const candidate = STV_findContentBoxInDocument(doc);
        assert.ok(candidate, 'Candidate container must be located');
        assert.strictEqual(candidate.className, 'reading-content');
        assert.ok(candidate.textContent.includes('Nội dung thực sự của chương tiểu thuyết'));
    });

    it('T1.12: detects next chapter URL using rel=next and chapter links', () => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`
            <div class="navigation">
                <a href="/chap-1.html">Chương Trước</a>
                <a rel="next" href="/chap-3.html">Chương Sau</a>
            </div>
        `, 'text/html');

        const nextUrl = STV_findNextChapterUrl(doc, 'https://truyen.test/story/chap-2.html');
        assert.ok(nextUrl, 'Next chapter URL must be identified');
        assert.strictEqual(nextUrl, 'https://truyen.test/chap-3.html');
    });

    it('T1.12b: detects AJAX placeholder next-chapter links (/0/) as pendingNextUrl without breaking static last chapters', () => {
        const pendingHtml = `
            <div id="chapter-content">
                <p>Nội dung chương truyện đủ dài để vượt ngưỡng kiểm tra 150 ký tự của extractor trong chế độ tải ngầm nhiều chương liên tiếp trên các trang web dùng AJAX.</p>
            </div>
            <div class="nav">
                <a href="/truyen/demo/1/100/">Chương trước</a>
                <a href="/truyen/demo/1/0/">Chương sau &gt;</a>
            </div>
        `;
        const pendingRes = window.STV_extractFromHtml(pendingHtml, 'https://truyen.test/truyen/demo/1/101/');
        assert.strictEqual(pendingRes.ok, true);
        assert.strictEqual(pendingRes.nextUrl, null);
        assert.strictEqual(pendingRes.pendingNextUrl, true);

        const lastChapterHtml = `
            <div id="chapter-content">
                <p>Đây là chương cuối cùng của bộ truyện dài kỳ này, nội dung hoàn toàn không có nút chuyển sang chương sau nào trong DOM để kiểm chứng trang kết thúc bình thường vượt ngưỡng 150 ký tự của extractor.</p>
            </div>
            <div class="nav">
                <a href="/truyen/demo/1/100/">Chương trước</a>
            </div>
        `;
        const lastRes = window.STV_extractFromHtml(lastChapterHtml, 'https://truyen.test/truyen/demo/1/102/');
        assert.strictEqual(lastRes.ok, true);
        assert.strictEqual(lastRes.nextUrl, null);
        assert.strictEqual(lastRes.pendingNextUrl, false);
    });

    it('T1.12c: STV_detectCaptchaInDocument detects Cloudflare/Turnstile/STV modals while ignoring hidden templates and loaded chapters', () => {
        const interstitialDoc = new DOMParser().parseFromString(`
            <html><head><title>Just a moment...</title></head>
            <body><form id="challenge-form" action="/?__cf_chl_f_tk=abc"></form></body></html>
        `, 'text/html');
        assert.deepStrictEqual(
            { ...window.STV_detectCaptchaInDocument(interstitialDoc, { isStaticHtml: true }) },
            { detected: true, kind: 'cloudflare_interstitial' }
        );

        const turnstileDoc = new DOMParser().parseFromString(`
            <div class="box"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile"></iframe></div>
        `, 'text/html');
        assert.deepStrictEqual(
            { ...window.STV_detectCaptchaInDocument(turnstileDoc, { isStaticHtml: false }) },
            { detected: true, kind: 'turnstile_iframe' }
        );

        const visibleModalDoc = new DOMParser().parseFromString(`
            <div id="content-container">Đang tải nội dung chương...</div>
            <div class="modal show" id="captchaModal" style="display: block">
                <div>Captcha STV Verify you are human</div>
            </div>
        `, 'text/html');
        assert.deepStrictEqual(
            { ...window.STV_detectCaptchaInDocument(visibleModalDoc, { isStaticHtml: false }) },
            { detected: true, kind: 'captcha_modal' }
        );

        const dormantAjaxHtml = `
            <div id="content-container">Đang tải nội dung chương...</div>
            <div class="modal fade" id="captchaModal">
                <div>Captcha STV Verify you are human</div>
            </div>
        `;
        const dormantRes = window.STV_extractFromHtml(dormantAjaxHtml, 'https://truyen.test/truyen/demo/1/105/');
        assert.strictEqual(dormantRes.ok, false);
        assert.strictEqual(dormantRes.captchaRequired, false);

        const loadedChapterHtml = `
            <div id="chapter-content">
                <p>Nội dung chương tiểu thuyết đã được tải đầy đủ dài hơn 150 ký tự để chứng minh trình trích xuất luôn ưu tiên nội dung thực tế trước mọi dấu hiệu modal phụ trên trang web.</p>
            </div>
            <div class="modal show" id="captchaModal">Verify you are human</div>
        `;
        const loadedRes = window.STV_extractFromHtml(loadedChapterHtml, 'https://truyen.test/truyen/demo/1/106/');
        assert.strictEqual(loadedRes.ok, true);
        assert.strictEqual(loadedRes.captchaRequired, false);
    });
});
