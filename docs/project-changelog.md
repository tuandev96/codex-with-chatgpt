# Project changelog

## 2026-09-10 — Codex worker toàn quyền trên máy cục bộ

- Mọi worker do ChatGPT điều phối đều có quyền truy cập đầy đủ vào máy cục bộ, kể cả khi tiếp tục cùng một phiên.
- Quyền đọc qua connector và quyền điều phối OAuth vẫn được kiểm soát riêng.

## 2026-09-09 — Theo dõi lượt Codex chạy dài

- ChatGPT có thể nhận trạng thái “đang chạy” và kiểm tra tiến độ trong khi Codex tiếp tục làm việc.
- Gửi lại cùng nhiệm vụ/lượt chạy không tạo thêm worker; kết quả được giữ để đọc lại.
- Nếu dịch vụ mất theo dõi giữa chừng, trạng thái được báo chưa xác minh và chặn chạy trùng cho đến khi đối chiếu.
- Thay đổi này không tự đánh thức ChatGPT khi cuộc trò chuyện đã kết thúc, và không thay thế việc kiểm tra từng tiêu chí nghiệm thu.
