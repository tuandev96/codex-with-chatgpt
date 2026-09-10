# Project changelog

## 2026-09-10 — Nhiều agent worker hơn (Codex / Cursor / Grok)

- ChatGPT vẫn là người điều phối; giờ có thể chọn worker local là Codex, Cursor Agent hoặc Grok.
- Thêm lệnh `agents_list` để xem agent nào đã cài trên máy, và `agent_run` để giao một vòng thực thi cho agent đã chọn.
- `codex_run` vẫn hoạt động như cũ (bản gọi nhanh tới Codex), không phá phiên đang chạy.
- Cùng một nhiệm vụ nhưng đổi agent là lượt chạy riêng; vẫn một workspace một worker tại một thời điểm.

## 2026-09-09 — Theo dõi lượt Codex chạy dài

- ChatGPT có thể nhận trạng thái “đang chạy” và kiểm tra tiến độ trong khi Codex tiếp tục làm việc.
- Gửi lại cùng nhiệm vụ/lượt chạy không tạo thêm worker; kết quả được giữ để đọc lại.
- Nếu dịch vụ mất theo dõi giữa chừng, trạng thái được báo chưa xác minh và chặn chạy trùng cho đến khi đối chiếu.
- Thay đổi này không tự đánh thức ChatGPT khi cuộc trò chuyện đã kết thúc, và không thay thế việc kiểm tra từng tiêu chí nghiệm thu.
