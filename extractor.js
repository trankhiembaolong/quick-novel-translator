// extractor.js - Tiêm vào trang web để tìm truyện

// Helper: Giải mã HTML entities thuần túy (an toàn, không dùng innerHTML)
function STV_decodeHtmlEntitiesFallback(str) {
    const named = {
        '&nbsp;': ' ',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'"
    };
    return String(str || '')
        .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (m) => named[m.toLowerCase()] || m)
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = Number(dec);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
        });
}

// Helper: Lọc HTML thành dòng text an toàn (không dùng innerHTML lên DOM thật, chống DOM XSS)
window.STV_convertHtmlToTextChunks = function(htmlString) {
    const BLOCK_TAGS = new Set([
        'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TR', 'PRE'
    ]);
    const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

    let rawText = '';
    const input = String(htmlString || '');

    if (typeof DOMParser !== 'undefined') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(input, 'text/html');
            const root = doc && doc.body;
            if (root) {
                const walk = (node, out) => {
                    if (!node) return;
                    if (node.nodeType === 3) { // TEXT_NODE
                        out.push(node.nodeValue || '');
                        return;
                    }
                    if (node.nodeType !== 1) return; // ELEMENT_NODE
                    const tag = (node.tagName || '').toUpperCase();
                    if (IGNORED_TAGS.has(tag)) return;
                    if (node.classList && node.classList.contains('spinner-border')) return;
                    if (tag === 'BR') {
                        out.push('\n');
                        return;
                    }
                    const isBlock = BLOCK_TAGS.has(tag);
                    if (isBlock) out.push('\n');
                    const children = node.childNodes || [];
                    for (let i = 0; i < children.length; i++) {
                        walk(children[i], out);
                    }
                    if (isBlock) out.push('\n');
                };
                const parts = [];
                walk(root, parts);
                rawText = parts.join('');
            }
        } catch {
            rawText = '';
        }
    }

    if (!rawText && input) {
        const stripped = input
            .replace(/<(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '\n')
            .replace(/<[^>]+>/g, '\n');
        rawText = STV_decodeHtmlEntitiesFallback(stripped);
    }

    const normalized = rawText.replace(/\r/g, '').replace(/\u00A0/g, ' ').replace(/\n+/g, '\n').trim();
    if (!normalized) return [];

    // Cắt thành mảng các dòng
    let lines = normalized.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    // Lọc bỏ rác hệ thống thông báo bảo vệ nội dung ở đầu truyện
    while (lines.length > 0) {
        let first = lines[0];
        if (first.includes('@Bạn đang đọc bản lưu trong hệ thống') ||
            first.includes('Bạn đang xem văn bản gốc chưa dịch')) {
            lines.shift();
        } else {
            break;
        }
    }

    // Nhân đôi xuống dòng để dễ nhìn (1 khoảng trắng giữa các đoạn)
    let spacedLines = [];
    lines.forEach(line => {
        spacedLines.push(line);
        spacedLines.push("");
    });

    return spacedLines;
}

// 1. Phép Thử Bằng Selectors Thường Gặp (hỗ trợ cả live document lẫn DOMParser document)
var STV_COMMON_CONTENT_SELECTORS = window.STV_COMMON_CONTENT_SELECTORS || [
    '#content-container .contentbox', // Trang cũ (STV)
    '#chapter-content',
    '.chapter-content',
    '.reading-content',
    '.story-body',
    '.entry-content',
    '#chapter-c',
    '.box-chap',
    'article.chapter-content',
    'div.content-body',
    '.txt-box',
    '.read-content'
];
window.STV_COMMON_CONTENT_SELECTORS = STV_COMMON_CONTENT_SELECTORS;

function STV_getCleanBoxText(el) {
    if (!el) return '';
    try {
        if (typeof el.cloneNode === 'function') {
            const clone = el.cloneNode(true);
            if (typeof clone.querySelectorAll === 'function') {
                const ignored = clone.querySelectorAll('script, style, noscript, iframe, .spinner-border');
                if (ignored && typeof ignored.forEach === 'function') {
                    ignored.forEach((n) => n.remove());
                } else if (ignored && ignored.length) {
                    for (let i = 0; i < ignored.length; i++) ignored[i].remove();
                }
            }
            return (clone.textContent || clone.innerText || '').replace(/\s+/g, ' ').trim();
        }
    } catch {
        // Fallback nếu là mock object không hỗ trợ clone
    }
    return (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
}

function STV_getMeaningfulTextLength(cleanText) {
    if (!cleanText) return 0;
    const stripped = String(cleanText)
        .replace(/@?bạn đang đọc bản lưu trong hệ thống\.?/gi, '')
        .replace(/bạn đang xem văn bản gốc chưa dịch[^.\n]*\.?/gi, '')
        .replace(/đọc trên web để có chất lượng dịch cao[^.\n]*\.?/gi, '')
        .trim();
    if (!stripped) return 0;
    if (/^(đang tải nội dung chương|nhấp vào để tải chương|vui lòng đợi|loading|please wait)[\s.!…]*$/i.test(stripped)) {
        return 0;
    }
    return stripped.length;
}

window.STV_detectCaptchaInDocument = function (doc, options = {}) {
    if (!doc || typeof doc.querySelector !== 'function') {
        return { detected: false, kind: '' };
    }
    const { isStaticHtml = false } = options || {};

    const hasModalClosedClass = (el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!/\bmodal\b/i.test(cls)) return false;
        if (/\b(show|in)\b/i.test(cls)) return false;
        const stDisplay = el.style && el.style.display;
        if (stDisplay && stDisplay !== 'none') return false;
        const rawStyle = typeof el.getAttribute === 'function' ? (el.getAttribute('style') || '') : '';
        if (/display\s*:\s*(block|flex|grid)/i.test(rawStyle)) return false;
        return true;
    };

    const isNodeVisible = (el, win) => {
        let cur = el;
        for (let depth = 0; depth < 6 && cur; depth += 1) {
            if (cur.hidden === true) return false;
            if (typeof cur.hasAttribute === 'function' && cur.hasAttribute('hidden')) return false;
            if (typeof cur.getAttribute === 'function' && cur.getAttribute('aria-hidden') === 'true') {
                return false;
            }
            const st = cur.style;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) {
                return false;
            }
            const rawStyle = typeof cur.getAttribute === 'function' ? (cur.getAttribute('style') || '') : '';
            if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s*;|\s*$)/i.test(rawStyle)) {
                return false;
            }
            if (isStaticHtml && hasModalClosedClass(cur)) {
                return false;
            }
            if (!isStaticHtml && win && typeof win.getComputedStyle === 'function') {
                try {
                    const cs = win.getComputedStyle(cur);
                    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) {
                        return false;
                    }
                } catch {}
            }
            if (!isStaticHtml && depth === 0 && typeof cur.getBoundingClientRect === 'function') {
                try {
                    const rect = cur.getBoundingClientRect();
                    if (rect && rect.width === 0 && rect.height === 0) {
                        return false;
                    }
                } catch {}
            }
            cur = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
        }
        return true;
    };

    const docView = doc.defaultView || null;

    // 1. Full-page Cloudflare / anti-bot interstitials
    const titleEl = doc.querySelector('title');
    const titleText = String(doc.title || (titleEl ? titleEl.textContent : '') || '').trim();
    if (/just a moment|attention required|verify you are human|security check|one more step|checking your browser|ddos-guard/i.test(titleText)) {
        return { detected: true, kind: 'cloudflare_interstitial' };
    }
    const interstitialSel = '#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running, #cf-wrapper, .cf-error-details';
    if (doc.querySelector(interstitialSel)) {
        return { detected: true, kind: 'cloudflare_interstitial' };
    }
    if (typeof doc.querySelectorAll === 'function') {
        const forms = doc.querySelectorAll('form');
        for (const form of forms) {
            const action = String(form.getAttribute?.('action') || form.action || '');
            if (/__cf_chl/i.test(action)) {
                return { detected: true, kind: 'cloudflare_interstitial' };
            }
        }

        // 2. Active CAPTCHA widget iframes
        const iframes = doc.querySelectorAll('iframe');
        for (const frame of iframes) {
            const src = String(frame.getAttribute?.('src') || frame.src || '').toLowerCase();
            if (/challenges\.cloudflare\.com|turnstile|hcaptcha\.com|google\.com\/recaptcha|recaptcha\.net/.test(src)) {
                if (isStaticHtml ? isNodeVisible(frame, null) : isNodeVisible(frame, docView)) {
                    return { detected: true, kind: 'turnstile_iframe' };
                }
            }
        }

        // 3. Visible CAPTCHA modals / widget containers
        const candidates = new Set();
        for (const el of doc.querySelectorAll('.cf-turnstile, .g-recaptcha, .h-captcha, .modal, [role="dialog"]')) {
            candidates.add(el);
        }
        for (const el of doc.querySelectorAll('div, section, aside, form')) {
            const idStr = String(el.id || '');
            const clsStr = typeof el.className === 'string' ? el.className : '';
            if (/captcha/i.test(idStr) || /captcha/i.test(clsStr)) {
                candidates.add(el);
            }
        }

        for (const el of candidates) {
            if (!isNodeVisible(el, docView)) continue;

            const clsStr = typeof el.className === 'string' ? el.className : '';
            const isWidgetClass = /\b(cf-turnstile|g-recaptcha|h-captcha)\b/i.test(clsStr);
            if (isWidgetClass) {
                const hasSitekey = Boolean(el.getAttribute?.('data-sitekey'));
                const hasChildren = Boolean(el.childNodes && el.childNodes.length > 0);
                if (hasSitekey || hasChildren) {
                    return { detected: true, kind: 'captcha_modal' };
                }
            }

            if (typeof el.querySelectorAll === 'function') {
                const inputs = el.querySelectorAll('input');
                for (const inp of inputs) {
                    const name = String(inp.getAttribute?.('name') || inp.name || '');
                    if (name === 'cf-turnstile-response' || name === 'h-captcha-response' || name === 'g-recaptcha-response') {
                        return { detected: true, kind: 'captcha_modal' };
                    }
                }
                const nestedFrames = el.querySelectorAll('iframe');
                for (const nf of nestedFrames) {
                    const src = String(nf.getAttribute?.('src') || nf.src || '').toLowerCase();
                    if (/cloudflare|turnstile|captcha|recaptcha|hcaptcha/.test(src)) {
                        return { detected: true, kind: 'captcha_modal' };
                    }
                }
            }

            const cleanText = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
            if (
                cleanText.length >= 4 &&
                cleanText.length <= 600 &&
                /verify you are human|xác minh.*(người|con người)|xác nhận.*robot|cloudflare.*privacy|captcha/i.test(cleanText)
            ) {
                return { detected: true, kind: 'captcha_modal' };
            }
        }
    }

    return { detected: false, kind: '' };
};

window.STV_findContentBoxInDocument = function (doc, savedSelector = '') {
    if (!doc || typeof doc.querySelector !== 'function') return null;

    if (savedSelector) {
        try {
            const savedEl = doc.querySelector(savedSelector);
            const len = STV_getMeaningfulTextLength(STV_getCleanBoxText(savedEl));
            if (len > 80) {
                return savedEl;
            }
        } catch {
            // Selector không hợp lệ
        }
    }

    for (const selector of STV_COMMON_CONTENT_SELECTORS) {
        const el = doc.querySelector(selector);
        const len = STV_getMeaningfulTextLength(STV_getCleanBoxText(el));
        if (len > 150) {
            return el;
        }
    }
    return null;
};

// Phân tích liên kết chương tiếp theo: vừa trả URL hợp lệ (nếu có), vừa phát hiện link giữ chỗ AJAX (/0/, #, javascript:)
function STV_inspectNextChapterLinks(doc = document, baseUrl = window.location.href) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
        return { nextUrl: null, pendingNextUrl: false };
    }

    const currentNormalized = (() => {
        try {
            const u = new URL(baseUrl);
            return `${u.origin}${u.pathname}${u.search}`;
        } catch {
            return baseUrl;
        }
    })();

    const isPlaceholderHref = (rawHref) => {
        const trimmed = String(rawHref || '').trim();
        if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return true;
        try {
            const resolved = new URL(trimmed, baseUrl);
            return /\/truyen\/.+\/0\/?$/i.test(resolved.pathname);
        } catch {
            return false;
        }
    };

    const resolveHttpUrl = (rawHref) => {
        if (!rawHref) return null;
        const trimmed = String(rawHref).trim();
        if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return null;
        try {
            const resolved = new URL(trimmed, baseUrl);
            if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
            // Tránh link giữ chỗ /0/ trên STV khi AJAX chưa cập nhật xong chương kế
            if (/\/truyen\/.+\/0\/?$/i.test(resolved.pathname)) return null;
            const norm = `${resolved.origin}${resolved.pathname}${resolved.search}`;
            if (norm === currentNormalized) return null;
            return resolved.href;
        } catch {
            return null;
        }
    };

    const relNext = doc.querySelector('link[rel="next"][href], a[rel="next"][href]');
    if (relNext) {
        const url = resolveHttpUrl(relNext.getAttribute('href'));
        if (url) return { nextUrl: url, pendingNextUrl: false };
    }

    const negPattern = /(chương\s*trước|trang\s*trước|prev(ious)?\b|mục\s*lục|danh\s*sách|giới\s*thiệu|bình\s*luận|trang\s*chủ|上一章|上一页|上章|目录|书页|返回|首页)/i;
    const strongTextPattern = /^(chương\s*(sau|tiếp(\s*theo)?|kế(\s*tiếp)?)|đọc\s*tiếp|trang\s*sau|tiếp\s*theo|下一章|下章|下一节|下一页|后一章|next\s*chapter)$/i;
    const partialTextPattern = /(chương\s*sau|chương\s*tiếp|đọc\s*tiếp|下一章|下一页|next\s*chapter)/i;
    const shortWordPattern = /^(sau|tiếp|next)$/i;
    const attrPattern = /(next[-_ ]?chap(ter)?|chap(ter)?[-_ ]?next|btn[-_ ]?next|nav[-_ ]?next|next[-_ ]?page|next_url|nextlink)/i;

    let bestUrl = null;
    let bestScore = 0;
    let pendingNextUrl = false;

    let baseOrigin = '';
    try { baseOrigin = new URL(baseUrl).origin; } catch {}

    const candidates = doc.querySelectorAll('a, button[data-href], button[data-url], [data-next-url]');
    for (const el of candidates) {
        const rawText = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
        const cleanText = rawText.replace(/^[\s<>‹›«»←→-]+|[\s<>‹›«»←→-]+$/g, '').trim();
        const attrText = `${el.id || ''} ${el.className || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`.trim();

        if (negPattern.test(cleanText) || negPattern.test(attrText)) continue;

        let score = 0;
        if (strongTextPattern.test(cleanText)) {
            score += 100;
        } else if (partialTextPattern.test(cleanText) && cleanText.length <= 32) {
            score += 80;
        } else if (shortWordPattern.test(cleanText)) {
            score += 55;
        }

        if (attrPattern.test(attrText)) {
            score += 50;
        }
        if (/chương\s*sau|chương\s*tiếp|next\s*chapter|下一章/i.test(attrText)) {
            score += 45;
        }
        if (score <= 0) continue;

        const rawHref = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-next-url');
        const url = resolveHttpUrl(rawHref);
        if (!url) {
            if (isPlaceholderHref(rawHref)) {
                pendingNextUrl = true;
            }
            continue;
        }

        if (baseOrigin) {
            try {
                if (new URL(url).origin === baseOrigin) score += 10;
            } catch {}
        }

        if (score > bestScore) {
            bestScore = score;
            bestUrl = url;
        }
    }

    return {
        nextUrl: bestScore > 0 ? bestUrl : null,
        pendingNextUrl: bestScore > 0 ? false : pendingNextUrl
    };
}

// Tìm URL chương tiếp theo trên trang hiện tại hoặc HTML đã tải trước
window.STV_findNextChapterUrl = function (doc = document, baseUrl = window.location.href) {
    return STV_inspectNextChapterLinks(doc, baseUrl).nextUrl;
};

function STV_extractChunksFromElement(box) {
    if (!box) return [];
    const clone = box.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, .spinner-border').forEach((n) => n.remove());
    return window.STV_convertHtmlToTextChunks(clone.innerHTML);
}

function STV_extractFromDocument(doc, pageUrl, savedSelector = '', options = {}) {
    const box = window.STV_findContentBoxInDocument(doc, savedSelector);
    const { nextUrl, pendingNextUrl } = STV_inspectNextChapterLinks(doc, pageUrl);
    if (!box) {
        const isStaticHtml = options && options.isStaticHtml !== undefined
            ? Boolean(options.isStaticHtml)
            : !(doc && doc.defaultView);
        const captcha = window.STV_detectCaptchaInDocument(doc, { isStaticHtml });
        return {
            ok: false,
            chunks: null,
            nextUrl,
            pendingNextUrl,
            reason: captcha.detected ? 'captcha_required' : 'not_ready',
            captchaRequired: Boolean(captcha.detected),
            captchaKind: captcha.kind || ''
        };
    }
    const chunks = STV_extractChunksFromElement(box);
    if (Array.isArray(chunks) && chunks.length > 0) {
        return { ok: true, chunks, nextUrl, pendingNextUrl, captchaRequired: false, captchaKind: '' };
    }
    const isStaticHtml = options && options.isStaticHtml !== undefined
        ? Boolean(options.isStaticHtml)
        : !(doc && doc.defaultView);
    const captcha = window.STV_detectCaptchaInDocument(doc, { isStaticHtml });
    return {
        ok: false,
        chunks,
        nextUrl,
        pendingNextUrl,
        reason: captcha.detected ? 'captcha_required' : 'not_ready',
        captchaRequired: Boolean(captcha.detected),
        captchaKind: captcha.kind || ''
    };
}
window.STV_extractFromDocument = STV_extractFromDocument;

// Trích xuất nội dung chương từ chuỗi HTML thô (dùng cho preload ngầm chương sau)
window.STV_extractFromHtml = function (htmlString, pageUrl, savedSelector = '') {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString || '', 'text/html');
        return STV_extractFromDocument(doc, pageUrl, savedSelector, { isStaticHtml: true });
    } catch (err) {
        return { ok: false, chunks: null, nextUrl: null, error: err.message };
    }
};

// Trích xuất nội dung chương cho các site tải bằng AJAX (như STV) qua iframe ẩn cùng origin
window.STV_extractFromUrlViaIframe = function (targetUrl, savedSelector = '', timeoutMs = 12000) {
    return new Promise((resolve) => {
        let settled = false;
        let pollTimer = null;
        let deadlineTimer = null;
        let iframe = null;
        let bestResult = null;
        let nextUrlDeadline = 0;
        let captchaConfirmCount = 0;
        let lastCaptchaKind = '';
        let crossOriginErrCount = 0;
        let hasLoaded = false;

        try {
            const targetOrigin = new URL(targetUrl, window.location.href).origin;
            if (targetOrigin !== window.location.origin) {
                resolve({ ok: false, chunks: null, nextUrl: null, reason: 'cross_origin' });
                return;
            }
        } catch {
            resolve({ ok: false, chunks: null, nextUrl: null, reason: 'invalid_url' });
            return;
        }

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (pollTimer) clearInterval(pollTimer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (iframe && iframe.parentNode) {
                try { iframe.src = 'about:blank'; } catch {}
                iframe.remove();
            }
            resolve(result);
        };

        const stale = document.getElementById('stv-preload-iframe');
        if (stale) stale.remove();

        iframe = document.createElement('iframe');
        iframe.id = 'stv-preload-iframe';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1024px;height:768px;opacity:0;pointer-events:none;border:0;visibility:hidden;';

        const tryReadIframe = () => {
            if (settled || !iframe) return;
            try {
                const iWin = iframe.contentWindow;
                const iDoc = iframe.contentDocument;
                if (!iDoc || !iDoc.location || iDoc.location.href === 'about:blank') return;
                if (iWin) {
                    try {
                        iWin.alert = () => {};
                        iWin.confirm = () => false;
                    } catch {}
                }
                const res = STV_extractFromDocument(iDoc, targetUrl, savedSelector, { isStaticHtml: false });
                if (res.ok) {
                    captchaConfirmCount = 0;
                    if (res.nextUrl) {
                        finish(res);
                        return;
                    }
                    // Nội dung đã sẵn sàng nhưng link "Chương sau" AJAX có thể cập nhật trễ hơn chữ
                    if (!bestResult) {
                        bestResult = res;
                        nextUrlDeadline = Date.now() + (res.pendingNextUrl ? 2500 : 1200);
                    } else if (res.chunks.length >= bestResult.chunks.length) {
                        bestResult = res;
                    }
                    if (Date.now() >= nextUrlDeadline) {
                        finish(bestResult);
                    }
                    return;
                }
                if (res.captchaRequired) {
                    captchaConfirmCount += 1;
                    lastCaptchaKind = res.captchaKind || lastCaptchaKind || 'captcha_modal';
                    if (captchaConfirmCount >= 2) {
                        finish({
                            ok: false,
                            chunks: null,
                            nextUrl: null,
                            reason: 'captcha_required',
                            captchaRequired: true,
                            captchaKind: lastCaptchaKind
                        });
                    }
                } else {
                    captchaConfirmCount = 0;
                }
            } catch {
                // Trang có thể chặn same-origin (Cloudflare challenge) hoặc đang điều hướng
                if (hasLoaded) {
                    crossOriginErrCount += 1;
                    if (crossOriginErrCount >= 2) {
                        finish({
                            ok: false,
                            chunks: null,
                            nextUrl: null,
                            reason: 'captcha_cross_origin',
                            captchaRequired: true,
                            captchaKind: 'cross_origin_challenge'
                        });
                    }
                }
            }
        };

        iframe.addEventListener('load', () => {
            hasLoaded = true;
            tryReadIframe();
        });
        pollTimer = setInterval(tryReadIframe, 150);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
        deadlineTimer = setTimeout(() => {
            if (bestResult) {
                finish(bestResult);
                return;
            }
            let stuckLoading = Boolean(lastCaptchaKind);
            let finalKind = lastCaptchaKind;
            if (!stuckLoading && iframe) {
                try {
                    const iDoc = iframe.contentDocument;
                    const bodyText = String(iDoc?.body?.textContent || iDoc?.body?.innerText || '').trim();
                    const hasSpinner = Boolean(iDoc?.querySelector?.('.spinner-border'));
                    if (
                        hasSpinner ||
                        /(đang tải nội dung chương|nhấp vào để tải chương|vui lòng đợi|loading|please wait)/i.test(bodyText)
                    ) {
                        stuckLoading = true;
                        finalKind = finalKind || 'stuck_loading';
                    }
                } catch {
                    stuckLoading = true;
                    finalKind = finalKind || 'cross_origin_challenge';
                }
            }
            finish({
                ok: false,
                chunks: null,
                nextUrl: null,
                reason: 'iframe_timeout',
                captchaRequired: stuckLoading,
                captchaKind: finalKind
            });
        }, Math.max(2000, timeoutMs));
        if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

        iframe.src = targetUrl;
        (document.body || document.documentElement).appendChild(iframe);
    });
};

// Chờ trang vừa chuyển tới tải xong nội dung AJAX (tránh đọc/dịch nhầm lúc web còn đang hiện spinner)
window.STV_waitForContentReady = function (savedSelector = '', timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (window.STV_findContentBoxInDocument(document, savedSelector)) {
            resolve({ ready: true });
            return;
        }
        let settled = false;
        let observer = null;
        let pollTimer = null;
        let deadlineTimer = null;

        const finish = (ready) => {
            if (settled) return;
            settled = true;
            if (observer) observer.disconnect();
            if (pollTimer) clearInterval(pollTimer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            resolve({ ready });
        };

        const check = () => {
            if (window.STV_findContentBoxInDocument(document, savedSelector)) {
                finish(true);
            }
        };

        const targetRoot = document.body || document.documentElement;
        if (targetRoot && typeof MutationObserver === 'function') {
            observer = new MutationObserver(check);
            observer.observe(targetRoot, { childList: true, subtree: true, characterData: true });
        }
        pollTimer = setInterval(check, 120);
        deadlineTimer = setTimeout(() => finish(false), Math.max(1000, timeoutMs));
    });
};

// 2. Khởi Dựng Toàn Cục
window.STV_extractChapterTextChunks = async function (savedSelectorArg = '') {
    try {
        let contentBox = null;
        const hostname = window.location.hostname;
        const storageKey = `stv_selector_${hostname}`;

        // 2.1 Ưu tiên 1: Đã được gán thủ công bằng picker.js trong phiên này
        if (
            window.STV_activeContentBox &&
            (typeof Element === 'undefined' || window.STV_activeContentBox instanceof Element) &&
            window.STV_activeContentBox.isConnected !== false
        ) {
            contentBox = window.STV_activeContentBox;
        } else {
            // 2.2 Ưu tiên 2: Nhận selector từ tham số / background (vì storage.local có thể ở chế độ TRUSTED_CONTEXTS)
            let savedSelector = savedSelectorArg || '';
            if (!savedSelector && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                try {
                    const bgRes = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: 'get_site_selector', hostname }, (resp) => {
                            if (chrome.runtime.lastError) { resolve(null); return; }
                            resolve(resp);
                        });
                    });
                    if (bgRes && bgRes.selector) {
                        savedSelector = bgRes.selector;
                    }
                } catch {
                    // ignore
                }
            }
            // storage.local is restricted to trusted extension contexts; selector lookup already uses background above.
            // Do not access chrome.storage.local directly from this content script.
            contentBox = window.STV_findContentBoxInDocument(document, savedSelector);
        }

        if (contentBox) {
            // Lưu đối tượng DOM này lại toàn cục để qua step sau (translation) có thể ghi đè
            window.STV_activeContentBox = contentBox;

            // Xử lý text đồng bộ với luồng preload (loại bỏ script, style, spinner...)
            return STV_extractChunksFromElement(contentBox);
        }

        return null;
    } catch (err) {
        console.error("Extractor Error: ", err);
        return null;
    }
};
