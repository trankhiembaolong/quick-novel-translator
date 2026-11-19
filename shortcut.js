// Shortcut listener chạy trên trang, không đọc storage trực tiếp vì storage.local bị giới hạn Trusted Contexts.
let currentShortcut = 'Ctrl+Q';

chrome.runtime.sendMessage({ action: 'get_shortcut' }, (res) => {
    if (!chrome.runtime.lastError && res && res.shortcut) currentShortcut = res.shortcut;
});

document.addEventListener('keydown', (e) => {
    // Không nhận phím tắt nếu user đang gõ văn bản trong khung nhập liệu
    const tagName = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || (e.target && e.target.isContentEditable)) {
        return;
    }

    let keys = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey) keys.push('Shift');
    if (e.metaKey) keys.push('Meta');
    
    // Nếu phím bấm chỉ là phím chức năng (Ctrl, Alt...) thì bỏ qua
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    
    // Convert phím chữ thành viết hoa, thêm vào tổ hợp
    keys.push(e.key.toUpperCase());
    
    const pressedCombo = keys.join('+');
    
    // Kiểm tra có khớp với phím cài đặt không
    if (pressedCombo === currentShortcut && pressedCombo.length > 0) {
        e.preventDefault();
        
        // Hiện thông báo cục bộ (Toast nhỏ) để background.js ghi log
        let toast = document.getElementById('stv-shortcut-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'stv-shortcut-toast';
            document.body.appendChild(toast);
        }
        
        toast.innerText = 'Đã nhận lệnh phím tắt. Đang gọi Background...';
        toast.style.cssText = `
            position: fixed; 
            top: 20px; 
            right: 20px; 
            background: #4CAF50; 
            color: white; 
            padding: 10px 15px; 
            border-radius: 5px; 
            z-index: 9999999; 
            font-family: sans-serif;
            font-size: 14px;
            font-weight: bold; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.2); 
            transition: opacity 0.5s;
            opacity: 1;
        `;

        // Tự động xoá sau 10 giây (hoặc tắt sớm tùy vào thông báo)
        clearTimeout(window.stvToastTimeout1);
        clearTimeout(window.stvToastTimeout2);
        window.stvToastTimeout1 = setTimeout(() => { 
            if(toast) toast.style.opacity = '0'; 
            window.stvToastTimeout2 = setTimeout(() => { if(toast) toast.remove(); }, 500); 
        }, 8000);

        // Phát tín hiệu cho Background Service Worker
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.sendMessage !== 'function') {
            toast.innerText = 'Extension vừa được cập nhật. Hãy bấm F5 tải lại trang web này rồi thử lại!';
            toast.style.backgroundColor = '#f44336';
            return;
        }

        try {
            chrome.runtime.sendMessage({ action: 'shortcut_triggered' }, (response) => {
                if (chrome.runtime.lastError) {
                    toast.innerText = "Lỗi Extension: " + chrome.runtime.lastError.message;
                    toast.style.backgroundColor = '#f44336';
                }
            });
        } catch (err) {
            toast.innerText = 'Extension vừa được cập nhật. Hãy bấm F5 tải lại trang web này rồi thử lại!';
            toast.style.backgroundColor = '#f44336';
        }
    }
});
