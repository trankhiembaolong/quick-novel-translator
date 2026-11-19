# Chính sách quyền riêng tư — Quick Novel Translator (STV)

> Cập nhật lần cuối / Last updated: 2026-11-19

[Tiếng Việt](#tiếng-việt) | [English](#english)

---

## Tiếng Việt

**Quick Novel Translator** tôn trọng quyền riêng tư của bạn. Tiện ích hoạt động trực tiếp trên trình duyệt của bạn và **không** thu thập, theo dõi, mua bán hay gửi dữ liệu cá nhân về bất kỳ máy chủ nào của nhà phát triển.

### 1. Dữ liệu được lưu trữ cục bộ trên thiết bị của bạn
Tiện ích lưu các dữ liệu sau trong bộ nhớ cục bộ của trình duyệt (`chrome.storage.local`):
- **Thông tin xác thực do bạn tự nhập**: API Key của dịch vụ dịch AI (OpenRouter / OpenAI-compatible) và VieNeu API Key (nếu có). Dữ liệu nhạy cảm được cách ly bằng `TRUSTED_CONTEXTS` và không bị lộ ra trang web thông thường.
- **Cấu hình dịch và đọc**: URL endpoint AI/TTS, tên model đã chọn, cỡ chữ, font chữ, giãn dòng, tốc độ đọc, giọng đọc, giao diện sáng/tối và ngôn ngữ hiển thị.
- **Từ điển thuật ngữ (Glossary)** và **vùng chọn nội dung theo từng tên miền** do bạn tự lưu.

Tiện ích **không** sử dụng `chrome.storage.sync`, **không** dùng cookie theo dõi, **không** nhúng mã phân tích (analytics) hay quảng cáo.

### 2. Dữ liệu được truyền ra khỏi thiết bị khi nào?
Tiện ích chỉ gửi dữ liệu khi **bạn chủ động thao tác** (bấm Dịch chương, Tải danh sách model, Nghe truyện hoặc Tải audio WAV):
- **Nội dung chương truyện trên trang bạn đang mở** (và các thuật ngữ khớp trong từ điển của bạn) được gửi trực tiếp từ trình duyệt tới **AI Endpoint URL** do chính bạn cấu hình (mặc định là `https://openrouter.ai/api/v1/chat/completions`), kèm API Key của bạn trong header `Authorization`.
- **Văn bản cần đọc** được gửi tới dịch vụ đọc giọng (TTS) mà bạn lựa chọn:
  - *Web Speech API*: xử lý bởi trình duyệt/hệ điều hành.
  - *WebSocket TTS*: gửi tới WebSocket TTS URL do bạn cấu hình.
  - *VieNeu Local Server*: gửi tới máy chủ cục bộ trên máy của bạn (mặc định `http://127.0.0.1:8000`) — dữ liệu giọng nói không rời khỏi máy tính của bạn.

### 3. Quyền truy cập (Permissions)
- **`storage`**: Lưu cấu hình, từ điển và API Key cục bộ trên máy.
- **`activeTab` & `scripting`**: Chỉ đọc nội dung và hiển thị bản dịch / trình phát âm thanh trên tab đang mở khi bạn bấm thao tác.
- **Quyền truy cập trang web theo từng tên miền (`optional_host_permissions: *://*/*`)**: Chỉ được yêu cầu khi bạn bấm cấp quyền cho trang truyện bạn đang đọc để dịch và tải trước chương kế tiếp.
- **Quyền `nativeMessaging` (tùy chọn)**: Chỉ được yêu cầu nếu bạn bấm nút "Bật Server" hoặc "Kiểm tra Native Host" để điều khiển gói VieNeu Windows Companion chạy ngầm trên máy cá nhân.

### 4. Chia sẻ dữ liệu & Lưu giữ / Xóa dữ liệu
- Nhà phát triển **không** thu thập, lưu giữ hay chia sẻ dữ liệu của bạn với bất kỳ bên thứ ba nào (ngoài nhà cung cấp AI/TTS do chính bạn chọn và cấu hình).
- Bạn có thể xuất từ điển ra file JSON, xóa từng từ điển/cài đặt hoặc gỡ bỏ tiện ích bất kỳ lúc nào để xóa toàn bộ dữ liệu đã lưu trên trình duyệt.

### 5. Thay đổi chính sách & Liên hệ
Nếu chính sách này có thay đổi, ngày cập nhật ở đầu trang sẽ được điều chỉnh tương ứng. Mọi thắc mắc về quyền riêng tư vui lòng liên hệ:
- **Email**: [long38128@gmail.com](mailto:long38128@gmail.com)
- **GitHub Issues**: https://github.com/trankhiembaolong/quick-novel-translator/issues

---

## English

**Quick Novel Translator** respects your privacy. The extension runs locally in your browser and does **not** collect, track, sell, or transmit personal data to any developer-operated server.

### 1. Data Stored Locally on Your Device
The extension stores the following data strictly in local browser storage (`chrome.storage.local`):
- **User-provided credentials**: Your AI API Key (OpenRouter / OpenAI-compatible) and optional VieNeu API Key. Storage access is restricted to trusted extension contexts (`TRUSTED_CONTEXTS`) and is not exposed to web pages.
- **Preferences & settings**: Configured AI/TTS endpoint URLs, selected model, reader typography (font, size, line height), TTS speed/voice, light/dark theme, and UI language.
- **Custom terminology glossaries** and **per-site content area selectors** you explicitly save.

The extension does **not** use `chrome.storage.sync`, tracking cookies, analytics, telemetry, or advertising SDKs.

### 2. When Data Leaves Your Device
Data is transmitted **only upon your explicit user action** (translating a chapter, fetching model lists, listening to TTS, or exporting WAV audio):
- **Extracted chapter text** from the active page (along with matched glossary entries) is sent directly from your browser to the **AI Endpoint URL** you configured (default: `https://openrouter.ai/api/v1/chat/completions`), authenticated with your own API Key.
- **Speech synthesis text** is routed strictly to the TTS engine you select:
  - *Web Speech API*: handled by your browser/OS.
  - *WebSocket TTS*: sent to the WebSocket TTS endpoint you configured.
  - *VieNeu Local Server*: sent to your local server (default `http://127.0.0.1:8000`) — voice audio never leaves your computer.

### 3. Permissions Usage
- **`storage`**: Persists your settings, glossaries, and API keys locally on your device.
- **`activeTab` & `scripting`**: Reads chapter text and renders translated paragraphs and the audio mini-player only when you trigger them.
- **Per-site host access (`optional_host_permissions: *://*/*`)**: Requested on a per-domain basis only when you explicitly grant permission for a novel site you are reading.
- **`nativeMessaging` (optional)**: Requested only if you click "Start Server" or "Test Native Host" for the optional local Windows VieNeu-TTS companion.

### 4. Data Sharing, Retention & User Controls
- The developer does **not** collect, store, or share your data with any third parties (only the AI/TTS provider you personally configure receives your requests).
- You can export or delete glossaries, edit/clear saved selectors and API keys in Settings, or uninstall the extension at any time to remove all local data.

### 5. Policy Updates & Contact
Updates to this policy will be reflected by the "Last updated" date above. For privacy questions or support, please contact:
- **Email**: [long38128@gmail.com](mailto:long38128@gmail.com)
- **GitHub Issues**: https://github.com/trankhiembaolong/quick-novel-translator/issues
