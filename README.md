# AVA-TIX dApp v2 (UniHack Avalanche 2026)

## Chạy ứng dụng (Off-chain / Fallback)
```bash
npm install
npm start      # http://localhost:3000
```
Cơ sở dữ liệu SQLite (`avatix.db`) tự tạo và tự động migrate schema. Đổi `SECRET` trong `.env` khi triển khai.

- `/login.html`: đăng nhập / đăng ký (tự tạo ví EVM xác định cho mỗi user)
- `/customer.html`: khách hàng (mua vé, mở QR động 20s, bán lại giá trần +10%, xem NFT on-chain & lịch sử giao dịch)
- `/organizer.html`: nhà cung cấp (tạo sự kiện, thống kê, soát vé tại cổng, xem lịch sử on-chain)

## Tích hợp Smart Contract (Hybrid Relayer)

`contracts/AvaTicket.sol` + `contracts/TicketMarketplace.sol` đã được tích hợp vào `server.js` thông qua `blockchain.js` (mô hình Relayer gasless cho user).

### 1. Chạy test Smart Contract
```bash
npm run test:contracts
```

### 2. Chạy thử với Hardhat Local Node (không cần AVAX faucet)
Mở 2 terminal:
```bash
# Terminal 1: Khởi động local EVM node
npm run chain

# Terminal 2: Deploy contract (tự cập nhật .env) rồi chạy app
npm run deploy:local
npm start
```

### 3. Deploy lên Avalanche Fuji Testnet (Chain ID: 43113)
1. Sao chép `.env.example` thành `.env` (hoặc chạy `node scripts/gen-wallet.js` để tạo ví mới).
2. Nạp AVAX testnet cho địa chỉ `DEPLOYER_ADDRESS` tại [Avalanche Fuji Faucet](https://faucet.avax.network) hoặc [Core Faucet](https://core.app/tools/testnet-faucet/).
3. Deploy & khởi chạy:
```bash
npm run deploy:fuji
npm start
```
Mọi giao dịch mua vé, bán lại và check-in sẽ được ghi nhận on-chain và hiển thị link Snowtrace Testnet trong mục **Lịch sử on-chain** và **Xem On-chain**.

## Lưu ý
- Nạp tiền (MoMo/Ngân hàng/VNPAY/VietQR) và xác minh CCCD đang mô phỏng trong SQLite; các thao tác vé cốt lõi (mint, resale cap, atomic transfer, dynamic QR check-in) đã kết nối trực tiếp với smart contract qua Relayer.
