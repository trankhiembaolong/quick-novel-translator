# Chrome Web Store Listing — Quick Novel Translator

> Last Updated: 2026-11-20

## Store Listing

**Extension Name** [REQUIRED]
Quick Novel Translator

**Short Description** [REQUIRED]
<!-- 99 chars (max 132). Matches manifest.json description verbatim. -->
Dịch trực tiếp chương tiểu thuyết trên web thông qua Popup an toàn bằng cách quét chọn nội dung.

**Detailed Description** [REQUIRED]
Quick Novel Translator giúp bạn đọc và dịch trực tiếp tiểu thuyết tiếng Trung (hoặc ngoại ngữ) ngay trên trang web đang mở với tốc độ nhanh, trình bày rõ ràng và giữ mạch truyện tự nhiên.

TÍNH NĂNG NỔI BẬT
• Dịch trực tiếp trên trang web — Tự động nhận diện vùng nội dung chương hoặc cho phép chọn vùng thủ công trên từng trang, chuyển đổi linh hoạt giữa bản dịch và bản gốc.
• Quản lý từ điển thuật ngữ (Glossary) — Tạo nhiều bộ từ điển theo từng bộ truyện, khóa tên nhân vật, công pháp, địa danh để bản dịch luôn đồng nhất, tìm kiếm nhanh, lọc từ khóa và nhập/xuất tệp JSON.
• Nghe truyện thông minh & tải audio WAV — Hỗ trợ giọng đọc có sẵn của trình duyệt, máy chủ đọc giọng trực tuyến, hoặc kết nối với VieNeu-TTS chạy cục bộ trên máy cá nhân để nghe giọng AI tiếng Việt 48kHz tự nhiên và xuất tệp WAV nghe ngoại tuyến.
• Trải nghiệm đọc thoải mái — Bảng điều khiển gọn nhẹ ngay trên trang đọc để chỉnh phông chữ, cỡ chữ, giãn dòng, tải trước chương tiếp theo và điều khiển bằng phím tắt nhanh.
• Giao diện song ngữ & hai chế độ màu — Chuyển đổi nhanh giữa Tiếng Việt / English và giao diện Sáng / Tối.

CÁCH SỬ DỤNG
1. Mở tiện ích từ thanh công cụ Chrome và nhập khóa AI của bạn (hỗ trợ OpenRouter và các dịch vụ tương thích).
2. Mở trang chương truyện bất kỳ, bấm cấp quyền cho trang web đó rồi chọn "Dịch chương này".
3. Mở thẻ "Nghe" để nghe đọc truyện hoặc xuất audio WAV. Nếu muốn dùng giọng AI tiếng Việt cục bộ VieNeu-TTS, bấm "Hướng dẫn & Cài đặt VieNeu" để xem hướng dẫn 3 bước kèm công cụ kiểm tra kết nối ngay trong trình duyệt.

QUYỀN RIÊNG TƯ & QUYỀN TRUY CẬP
• Tiện ích chỉ truy cập trang web khi bạn chủ động cấp quyền cho trang đó và bấm thao tác dịch hoặc nghe.
• Khóa truy cập, từ điển cá nhân và mọi tùy chỉnh được lưu cục bộ trên máy của bạn; nội dung chương chỉ được gửi trực tiếp tới nhà cung cấp AI/giọng đọc do chính bạn cấu hình.
• Hỏi đáp & Hỗ trợ: long38128@gmail.com hoặc https://github.com/trankhiembaolong/quick-novel-translator/issues

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Translates web novel chapters directly in the browser with custom terminology glossaries and integrated text-to-speech playback.

**Primary Language** [REQUIRED]
Vietnamese (also supports English UI)

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-1-reader-translate.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-2-tts-listen.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-3-glossary.png` |
| Screenshot 4 | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-4-vieneu-setup.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 PNG | ✅ Ready | `store-assets/promo-small-440x280.png` |

### Screenshot Notes
- `screenshot-1-reader-translate.png`: Demonstrates direct chapter translation on a web novel page alongside the floating reader menu and Extension Translate popup.
- `screenshot-2-tts-listen.png`: Demonstrates the TTS Listen popup (with VieNeu Local Server & WAV export) and the floating in-page audio mini-player.
- `screenshot-3-glossary.png`: Demonstrates novel glossary profile management, locked character/term pairs, filtering, and JSON import/export.
- `screenshot-4-vieneu-setup.png`: Demonstrates the full-tab interactive VieNeu-TTS 3-step setup guide, hardware tabs, live diagnostics, and Windows Companion download.

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Stores the user's API key, translation model settings, reading typography preferences, custom novel glossaries, and per-site saved text selectors locally on the device. |
| `activeTab` | permissions | Grants temporary access to the currently active novel tab when the user explicitly triggers translation, content area selection, or text-to-speech playback. |
| `scripting` | permissions | Injects the chapter text extractor, in-page translation renderer, floating reader toolbar, and audio player only when the user requests translation or playback on a permitted page. |
| `declarativeNetRequestWithHostAccess` | permissions | Removes the browser `Origin` request header solely on extension-initiated AI API requests to user-permitted endpoints so third-party OpenAI-compatible AI gateways do not reject browser-originated requests with HTTP 403. |
| `nativeMessaging` | optional_permissions | Requested only when the user clicks "Start Server" or "Test Native Host" for the optional local VieNeu-TTS Windows companion (`com.stv.vieneu_host`). Not required for translation, Web Speech TTS, online TTS, or manually started local VieNeu servers. |
| `https://openrouter.ai/*` | host_permissions | Connects directly to the default OpenRouter AI service to fetch available models and stream chapter translations configured by the user. |
| `*://*/*` | optional_host_permissions | Requested per website only upon explicit user click so the extension can read chapter text and preload the next chapter on whichever web novel site the user chooses to read. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes — user-configured website chapter text and authentication keys are transmitted directly from the user's browser to their chosen AI/TTS endpoint solely when the user triggers translation, model listing, or speech synthesis. No developer-operated backend, analytics, or telemetry server exists.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | Stored locally (`apikey`, `ttsApiKey`) | Sent only in Authorization header to the user-configured AI/TTS endpoint | Authenticate user-owned API requests | Only the user-selected AI/TTS provider |
| Personal communications | No | No | N/A | No |
| Location | No | No | N/A | No |
| Web history | No | No | N/A | No |
| User activity | No | No | N/A | No |
| Website content | Read on user action | Chapter text sent only to the user-configured AI/TTS endpoint | Translate chapter text and synthesize speech on request | Only the user-selected AI/TTS provider |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
`https://trankhiembaolong.github.io/quick-novel-translator/privacy.html`

Backup GitHub Markdown URL:
`https://github.com/trankhiembaolong/quick-novel-translator/blob/main/PRIVACY.md`

---

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
trankhiembaolong

**Contact Email** [REQUIRED]
long38128@gmail.com

**Support URL / Email** [RECOMMENDED]
https://github.com/trankhiembaolong/quick-novel-translator/issues

**Homepage URL** [RECOMMENDED]
https://github.com/trankhiembaolong/quick-novel-translator

---

## Release Artifacts

Build command:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

Outputs in `dist/`:
- `dist/quick-novel-translator-cws-v1.0.zip` — Upload to Chrome Web Store Developer Dashboard.
- `dist/STV-VieNeu-Companion-Windows-v1.0.zip` — Attached to GitHub Release `v1.0` (`https://github.com/trankhiembaolong/quick-novel-translator/releases/download/v1.0/STV-VieNeu-Companion-Windows-v1.0.zip`).

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0 | 2026-11-19 | Initial public Chrome Web Store v1.0 release with redesigned icon, interactive VieNeu-TTS setup & diagnostics page (`vieneu-setup.html`), Windows Companion v1.0 release integration, and store screenshots. | Ready for Submission |
