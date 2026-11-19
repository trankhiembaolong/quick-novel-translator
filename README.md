# Quick Novel Translator (STV) — v1.0

Extension giúp dịch trực tiếp tiểu thuyết tiếng Trung/ngoại ngữ ngay trên trang web đang mở, quản lý từ điển khóa tên nhân vật/thuật ngữ và nghe truyện thông minh bằng giọng đọc AI (**VieNeu-TTS Local**).

## Tính năng chính
- **Dịch trực tiếp trên trang web**: Tự nhận diện vùng truyện hoặc chọn vùng thủ công, hỗ trợ đổi xem Bản dịch / Bản gốc, tùy chỉnh font, cỡ chữ, giãn dòng và phím tắt nhanh (`Ctrl+Q`).
- **Quản lý Từ điển (Glossary)**: Chia hồ sơ từ điển theo từng bộ truyện, khóa thuật ngữ cố định để dịch nhất quán, tìm kiếm tức thì, quét dọn thuật ngữ rác và nhập/xuất JSON.
- **Nghe truyện & Tải Audio WAV Offline**:
  - **WebSocket TTS** & **Web Speech API** (chạy ngay, không cần cài đặt).
  - **VieNeu Local Server (48kHz)**: Kết nối trực tiếp tới máy chủ `VieNeu-TTS` chạy trên máy cá nhân, hỗ trợ xuất file WAV nghe offline nhiều chương liên tiếp.
- **Song ngữ & Giao diện Sáng/Tối**: Hỗ trợ Tiếng Việt / English và Dark / Light Mode.

## Cài đặt VieNeu-TTS cục bộ (tùy chọn)
Mở tiện ích → tab **Nghe** → chọn **VieNeu Local Server** → bấm **Hướng dẫn & Cài đặt VieNeu** để mở trang hướng dẫn tương tác từng bước (chọn CPU / NVIDIA GPU / AMD GPU / macOS / Linux và kiểm tra kết nối trực tiếp).

- **Gói Windows Companion v1.0** (tùy chọn, dùng cho nút Bật/Tắt Server 1-click trong Popup):
  Tải tại [GitHub Releases v1.0](https://github.com/trankhiembaolong/quick-novel-translator/releases/download/v1.0/STV-VieNeu-Companion-Windows-v1.0.zip).

## Quyền riêng tư & Hỗ trợ
- **Chính sách quyền riêng tư (Privacy Policy)**:
  - GitHub Pages: https://trankhiembaolong.github.io/quick-novel-translator/privacy.html
  - Markdown: [PRIVACY.md](PRIVACY.md)
- **Liên hệ**: `long38128@gmail.com` hoặc mở [GitHub Issues](https://github.com/trankhiembaolong/quick-novel-translator/issues).

## Đóng gói & Kiểm thử
```powershell
# Chạy toàn bộ 174 bài kiểm thử đơn vị & E2E
node --test tests/*.test.js test-e2e/tier1-features/*.test.js test-e2e/tier2-boundaries/*.test.js test-e2e/tier3-pairwise/*.test.js test-e2e/tier4-scenarios/*.test.js

# Đóng gói file ZIP phát hành Chrome Web Store & Windows Companion vào dist/
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
```
