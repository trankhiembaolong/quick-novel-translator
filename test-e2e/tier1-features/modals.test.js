/**
 * test-e2e/tier1-features/modals.test.js
 * Feature 7: Accessible Modals & Non-Blocking Toast Notifications
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, UIModal, ReaderUI } from '../harness/index.js';

describe('Feature 7: Accessible Modals & Non-Blocking Toast Notifications', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.37: custom modal renders with accessible WAI-ARIA role="dialog" and aria-modal="true"', () => {
        const modalPromise = UIModal.alert({
            title: 'Thông báo lỗi',
            message: 'Không tìm thấy chương truyện.'
        });

        const overlay = document.querySelector('.stv-modal-overlay');
        assert.ok(overlay, 'Modal overlay must be mounted in DOM');
        assert.strictEqual(overlay.getAttribute('role'), 'dialog');
        assert.strictEqual(overlay.getAttribute('aria-modal'), 'true');
        assert.strictEqual(overlay.getAttribute('aria-label'), 'Thông báo lỗi');

        const okBtn = overlay.querySelector('#modal-btn-ok');
        assert.ok(okBtn);
        okBtn.click();

        return modalPromise.then((result) => {
            assert.strictEqual(result, true);
            assert.strictEqual(document.querySelector('.stv-modal-overlay'), null, 'Modal should be unmounted');
        });
    });

    it('T1.38: confirm modal resolves true on confirm and false on cancel', async () => {
        // Test confirm click
        const confirmPromise = UIModal.confirm({
            title: 'Xóa hồ sơ',
            message: 'Bạn có chắc chắn muốn xóa bộ từ điển này?'
        });
        const overlay1 = document.querySelector('.stv-modal-overlay');
        const btnConfirm = overlay1.querySelector('#modal-btn-confirm');
        btnConfirm.click();
        const resConfirm = await confirmPromise;
        assert.strictEqual(resConfirm, true, 'Confirm button click must resolve true');

        // Test cancel click
        const cancelPromise = UIModal.confirm({
            title: 'Xóa hồ sơ',
            message: 'Bạn có chắc chắn?'
        });
        const overlay2 = document.querySelector('.stv-modal-overlay');
        const btnCancel = overlay2.querySelector('#modal-btn-cancel');
        btnCancel.click();
        const resCancel = await cancelPromise;
        assert.strictEqual(resCancel, false, 'Cancel button click must resolve false');
    });

    it('T1.39: modal dismisses immediately when ESC key is dispatched on overlay', async () => {
        const modalPromise = UIModal.confirm({
            title: 'Hủy thao tác',
            message: 'Nhấn Escape để thoát'
        });

        const overlay = document.querySelector('.stv-modal-overlay');
        assert.ok(overlay);

        // Dispatch Escape keydown event
        const escEvent = new CustomEvent('keydown');
        escEvent.key = 'Escape';
        overlay.dispatchEvent(escEvent);

        const result = await modalPromise;
        assert.strictEqual(result, false, 'Escape dismissal must resolve false');
        assert.strictEqual(document.querySelector('.stv-modal-overlay'), null, 'Overlay must be removed');
    });

    it('T1.40: Shadow DOM toast renders non-blocking notification with role="status"', () => {
        ReaderUI.init();

        const toast = ReaderUI.showToast('Đang kết nối lại máy chủ TTS...', 'warning', 0);
        assert.ok(toast, 'Toast element must be created');
        assert.strictEqual(toast.getAttribute('role'), 'status');
        assert.ok(toast.classList.contains('stv-toast-warning'));
        assert.strictEqual(toast.textContent, 'Đang kết nối lại máy chủ TTS...');

        const root = document.getElementById('stv-reader-root');
        assert.ok(root.shadowRoot.contains(toast), 'Toast must be encapsulated in Shadow DOM');
    });

    it('T1.41: toast automatically dismisses after specified duration', async () => {
        ReaderUI.init();

        const toast = ReaderUI.showToast('Tự động đóng sau 50ms', 'info', 50);
        const root = document.getElementById('stv-reader-root');
        assert.ok(root.shadowRoot.contains(toast));

        await new Promise(r => setTimeout(r, 200));

        assert.strictEqual(root.shadowRoot.contains(toast), false, 'Toast must be removed after duration timeout');
    });

    it('T1.42: toast queue handles multiple rapid toast messages without overlapping DOM collisions', () => {
        ReaderUI.init();

        const t1 = ReaderUI.showToast('Thông báo 1', 'info', 0);
        const t2 = ReaderUI.showToast('Thông báo 2', 'success', 0);
        const t3 = ReaderUI.showToast('Thông báo 3', 'error', 0);

        const root = document.getElementById('stv-reader-root');
        const container = root.shadowRoot.getElementById('stv-toast-container');
        const children = container.querySelectorAll('.stv-toast');

        assert.strictEqual(children.length, 3, 'All 3 toasts must be present in queue container');
        assert.strictEqual(children[0].textContent, 'Thông báo 1');
        assert.strictEqual(children[1].textContent, 'Thông báo 2');
        assert.strictEqual(children[2].textContent, 'Thông báo 3');
    });
});
