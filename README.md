# AVA-TIX dApp v2 (UniHack Avalanche 2026)
## Chạy ứng dụng
```
npm install
npm start      # http://localhost:3000
```
Cơ sở dữ liệu SQLite (`avatix.db`) tự tạo. Đổi `SECRET` bằng biến môi trường khi triển khai.
- `/login.html` đăng nhập / đăng ký · `/customer.html` khách hàng · `/organizer.html` nhà cung cấp
- `contracts/`: AvaTicket.sol + TicketMarketplace.sol (đã bỏ phí BTC, giá bán lại ≤ giá gốc +10%, QR 60s). Deploy lên Fuji bằng Remix như hướng dẫn cũ.
## Lưu ý
Ví, nạp tiền (MoMo/Ngân hàng/VNPAY/VietQR) và xác minh CCCD đang mô phỏng trong SQL; chưa nối cổng thanh toán thật hay contract on-chain.
# DemoAVATIX
