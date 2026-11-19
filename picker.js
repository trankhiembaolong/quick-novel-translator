// picker.js - Module chọn vùng nội dung thủ công (Non-blocking Toast + ESC cancel)
(function () {
    if (window.STV_isPickerActive) return;
    window.STV_isPickerActive = true;

    const t = (key) => (window.STV_I18n && typeof window.STV_I18n.t === 'function')
        ? window.STV_I18n.t(key)
        : ({
            reader_picker_hint: 'Di chuột chọn vùng văn bản · Click trái để lưu · Bấm ESC để hủy',
            reader_picker_saved: 'Đã lưu vùng chọn! Bạn có thể bấm Dịch ngay.',
            reader_picker_cancelled: 'Đã hủy chọn vùng.'
        }[key] || key);

    const notify = (msg, type = 'info') => {
        if (typeof window.STV_showToast === 'function') {
            window.STV_showToast(msg, type, 3500);
        }
    };

    // Ngăn chặn tất cả các cú click mặc định của trang web
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        z-index: 2147483640; cursor: crosshair; background: rgba(15, 23, 42, 0.04);
    `;
    document.body.appendChild(overlay);

    const hintToast = document.createElement('div');
    hintToast.textContent = t('reader_picker_hint');
    hintToast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #4f46e5; color: #ffffff; padding: 10px 18px; border-radius: 999px;
        z-index: 2147483646; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.25); pointer-events: none;
    `;
    document.body.appendChild(hintToast);

    let currentTarget = null;
    let originalOutline = '';

    const cleanup = () => {
        if (currentTarget) {
            currentTarget.style.outline = originalOutline;
            currentTarget = null;
        }
        document.removeEventListener('mousemove', mouseMoveHandler);
        document.removeEventListener('click', mouseClickHandler, true);
        document.removeEventListener('keydown', keyDownHandler, true);
        if (overlay.parentNode) overlay.remove();
        if (hintToast.parentNode) hintToast.remove();
        window.STV_isPickerActive = false;
    };

    const mouseMoveHandler = (e) => {
        overlay.style.display = 'none';
        const el = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.display = 'block';

        if (el && el !== currentTarget && el !== document.body && el !== document.documentElement) {
            if (currentTarget) {
                currentTarget.style.outline = originalOutline;
            }
            currentTarget = el;
            originalOutline = currentTarget.style.outline;
            currentTarget.style.outline = '2px dashed #4f46e5';
        }
    };

    const keyDownHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
            notify(t('reader_picker_cancelled'), 'info');
        }
    };

    function getCssPath(el) {
        if (!(el instanceof Element)) return '';
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                selector += '#' + CSS.escape(el.id);
                path.unshift(selector);
                break;
            } else {
                let sib = el;
                let nth = 1;
                while ((sib = sib.previousElementSibling)) {
                    if (sib.nodeName.toLowerCase() === selector) nth++;
                }
                if (nth !== 1) selector += `:nth-of-type(${nth})`;
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(' > ');
    }

    const mouseClickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!currentTarget) {
            cleanup();
            return;
        }

        const pickedEl = currentTarget;
        pickedEl.style.outline = originalOutline;

        let container = pickedEl;
        let bestContainer = container;

        while (container && container.tagName !== 'BODY' && container.tagName !== 'HTML') {
            const textLen = container.innerText ? container.innerText.trim().length : 0;
            const paragraphs = container.querySelectorAll('p, div, br').length;

            if (textLen > 300 && paragraphs >= 2) {
                bestContainer = container;
                const grandParentTextLen = container.parentNode && container.parentNode.innerText
                    ? container.parentNode.innerText.trim().length
                    : 0;
                if (grandParentTextLen - textLen < 200 || textLen > 5000) {
                    break;
                }
            }
            container = container.parentNode;
        }

        window.STV_activeContentBox = bestContainer;
        bestContainer.style.outline = '2px dashed #10b981';
        setTimeout(() => { bestContainer.style.outline = ''; }, 1500);

        const cssSelector = getCssPath(bestContainer);
        if (cssSelector) {
            const hostname = window.location.hostname;
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ action: 'save_site_selector', hostname, selector: cssSelector }, () => {
                    void chrome.runtime.lastError;
                });
            } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    chrome.storage.local.set({ [`stv_selector_${hostname}`]: cssSelector });
                } catch {}
            }
        }

        cleanup();
        notify(t('reader_picker_saved'), 'success');
    };

    document.addEventListener('mousemove', mouseMoveHandler);
    document.addEventListener('click', mouseClickHandler, true);
    document.addEventListener('keydown', keyDownHandler, true);
})();
