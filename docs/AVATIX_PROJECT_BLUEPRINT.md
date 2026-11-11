# AVA-TIX — NEXT-GEN EVENT TICKETING PROTOCOL ON AVALANCHE

**Đề án Dự thi:** UniHack Avalanche 2026 (Team1 Vietnam)

**Hạn nộp bài:** 05:59 sáng ngày 25/11/2026 (Giờ Việt Nam)

**Định vị:** Giao thức phân phối & chuyển nhượng vé sự kiện thế hệ mới: Chống vé giả, Chống phe vé & Giao dịch 1-Chạm bằng Atomic Swap trên Avalanche C-Chain.

## 1. TỔNG QUAN DỰ ÁN & BÀI TOÁN THỊ TRƯỜNG

### 1.1. Nỗi đau thực tế tại Việt Nam

1. **Lừa đảo vé giả & Ảnh chụp màn hình (Screenshot Scam):** Khán giả mua lại vé qua mạng xã hội thường bị lừa vì một mã QR tĩnh có thể chụp màn hình gửi bán cho 5–10 người khác nhau.

2. **Kẹt cổng thanh toán giờ mở bán (Payment Gateway Crash):** Trong các đợt mở bán vé cao điểm (Concert Anh Trai, Blackpink), việc chuyển hướng sang VNPAY/Napas thường xuyên bị quá tải, nghẽn mạng, dẫn đến tình trạng: *Tài khoản ngân hàng bị trừ tiền nhưng không nhận được vé.*

3. **Phí cao & Rút tiền chậm trễ trên Web2:** Các nền tảng bán vé truyền thống thu phí dịch vụ từ 8% đến 12%, và giữ tiền bán vé từ 7 đến 14 ngày làm việc mới đối soát cho Ban tổ chức và người bán lại.

### 1.2. Giải pháp AVA-TIX

AVA-TIX kết hợp **Smart Contract trên Avalanche C-Chain** với **Account Abstraction (ERC-4337)** để tạo ra trải nghiệm mua sắm vé sự kiện hoàn toàn mới:

* **Dynamic QR Ticket:** Mã QR trên app xoay liên tục mỗi 15 giây (chống 100% việc chụp ảnh màn hình bán lại).

* **Pre-funded Smart Wallet:** Nạp tiền trước vào tài khoản qua VietQR $\rightarrow$ Giờ mở bán chỉ cần 1 cú chạm (1-Click Buy), không chuyển hướng ngân hàng, không lo kẹt mạng.

* **1-Click Atomic Resale:** Chợ sang nhượng vé chính thức với **giá bán trần** $\le$ **giá gốc** (chống phe vé). Tiền và vé hoán đổi tức thì trong 0.8 giây bằng Atomic Swap on-chain.

* **Tốc độ Check-in Sub-second:** Quét mã vào cửa cực nhanh dưới 1 giây, đáp ứng hàng ngàn người qua cổng cùng lúc.

## 2. KIẾN TRÚC KỸ THUẬT (MÌ ĂN LIỀN CHO 14 NGÀY)

### 2.1. Cấu trúc Smart Contracts (Solidity trên Avalanche Fuji)

#### Contract 1: `AvaTicket.sol` (Quản lý Vé NFT)

* Chuẩn ERC-721 mở rộng.

* **State:**

  * `ticketId => { eventId, originalPrice, seatInfo, isCheckedIn, currentOwner }`

  * `totpSecret`: Khóa mã hóa tạo QR động gắn với vé.

* **Functions:**

  * `mintTicket(address to, uint256 eventId, uint256 price)`: Chỉ Ban tổ chức / Marketplace contract được gọi.

  * `checkInTicket(uint256 ticketId, bytes signature, uint256 timestamp)`: Bảo vệ ở cổng quét mã, xác thực chữ ký số có thời hạn $\le$ 15 giây $\rightarrow$ Đổi trạng thái `isCheckedIn = true`.

#### Contract 2: `TicketMarketplace.sol` (Chợ Sơ cấp & Thứ cấp)

* **Chức năng Bán vé sơ cấp (Primary Drop):**

  * `buyTicket(uint256 eventId)`: Trừ số dư khả dụng $\rightarrow$ Mint vé mới cho người mua.

* **Chức năng Sang nhượng có giá trần (Capped Atomic Resale):**

  * `listResale(uint256 ticketId, uint256 resalePrice)`:

    * `require(resalePrice <= ticket.originalPrice, "Gia ban khong duoc vuot gia goc");`

    * Khóa vé vào Marketplace escrow.

  * `buyResaleTicket(uint256 ticketId)`:

    * Kiểm tra số dư người mua.

    * Chuyển quyền sở hữu vé sang người mua.

    * Tự động trừ 5% phí sàn + 5% phí bản quyền Ban tổ chức (Organizer Royalties).

    * Chuyển 90% tiền còn lại về ví người bán tức thì.

    * Tất cả diễn ra trong **1 transaction duy nhất (Atomic Swap)**.

### 2.2. Luồng Người dùng & Trải nghiệm Web3 "Vô hình" (Gasless & Social Login)

```
[Người dùng / Khán giả]
       │
       ▼ (Đăng nhập Google / Apple ID qua Web3Auth - Tự sinh ví Smart Account ngầm)
[Nạp tiền trước qua VietQR] ──► [Số dư khả dụng In-App (USDC / Token quy đổi)]
       │
       ├─► [Giờ mở bán]: Bấm [MUA NGAY] ──► Vé về ví trong 0.8 giây
       │
       ├─► [Đi xem show]: Mở app ──► Mã QR xoay liên tục mỗi 15 giây ──► Bảo vệ quét qua cổng
       │
       └─► [Bận không đi được]: Bấm [PASS VÉ] (Giá <= Giá gốc) ──► Tiền về số dư tức thì khi có người mua

```

## 3. ĐIỂM WOW TRONG KỊCH BẢN LIVE DEMO (3 PHÚT)

Khi thuyết trình trước Ban giám khảo UniHack, nhóm thực hiện live demo theo 4 bước trực quan:

1. **Bước 1 — Săn vé 1-Chạm (0.8 giây):**

   * Người mua mở giao diện, tài khoản đã có sẵn số dư 500.000đ.

   * Bấm nút **\[MUA VÉ\]** $\rightarrow$ Không cần chuyển sang app ngân hàng, màn hình ting ting hiện vé ngay lập tức.

2. **Bước 2 — Trình diễn QR động chống chụp màn hình:**

   * Mở vé: Hiển thị mã QR có thanh đếm ngược 15 giây chạy lùi.

   * Lấy điện thoại khác chụp lại bức ảnh đó mang đi quét $\rightarrow$ Scanner báo: **"Mã QR hết hạn / Không hợp lệ"**.

   * Quét mã trực tiếp từ app $\rightarrow$ Scanner báo xanh: **"Check-in thành công"**.

3. **Bước 3 — Atomic Resale chống phe vé:**

   * Người bán bấm pass vé với giá 600.000đ (cao hơn giá gốc 500.000đ) $\rightarrow$ Smart contract **từ chối giao dịch**.

   * Người bán để giá 500.000đ $\rightarrow$ Vé lên sàn chính thức.

   * Người mua B bấm **\[MUA LẠI\]** $\rightarrow$ Trong 1 giây: Vé biến mất khỏi máy A, xuất hiện trên máy B; tiền tài khoản máy A nhảy số tức thì.

4. **Bước 4 — Minh chứng Explorer:**

   * Mở giao dịch trên Avalanche Fuji Explorer (Snowtrace) để chứng minh tính Atomic và thời gian hoàn tất dưới 1 giây.

## 4. BỨC TRANH DOANH THU & KINH DOANH (BUSINESS MODEL)

| Nguồn thu | Cơ chế | Mức thu dự kiến | 
| ----- | ----- | ----- | 
| **Phí bán vé sơ cấp** | Thu từ mỗi vé bán ra đợt đầu | 3% – 5% giá trị vé | 
| **Phí giao dịch bán lại** | Thu khi vé đổi chủ trên chợ thứ cấp | 10% (Chia đôi: 5% cho Ban tổ chức, 5% cho AVA-TIX) | 
| **Gói giải pháp soát vé** | Cung cấp tài khoản scanner và dashboard tại chỗ | 5.000.000đ – 10.000.000đ / sự kiện | 

## 5. KẾ HOẠCH HÀNH ĐỘNG 14 NGÀY CHO NHÓM 3 NGƯỜI (11/11 – 24/11)

### Phân công vai trò

* **Thành viên 1 (Blockchain Developer):**

  * Viết contract `AvaTicket.sol` và `TicketMarketplace.sol`.

  * Viết script test trên Hardhat/Foundry (test case: mua vé, bán lại vượt giá trần bị chặn, check-in đổi trạng thái).

  * Deploy và verify code trên Avalanche Fuji Testnet (Chain ID: 43113).

* **Thành viên 2 (Frontend & UI/UX):**

  * Dựng giao diện Mobile Web trên Next.js / Tailwind CSS.

  * Tích hợp Web3Auth / Privy để người dùng đăng nhập bằng Google.

  * Tích hợp thư viện sinh Dynamic QR (TOTP) và giao diện quét mã QR qua camera (dùng thư viện `html5-qrcode`).

* **Thành viên 3 (Fullstack Integration & Pitching):**

  * Kết nối Frontend với Smart Contract (qua `viem` hoặc `ethers.js`).

  * Làm slide Pitch Deck bám sát tiêu chí UniHack (Value Proposition, Tech Complexity, Avalanche Usage).

  * Quay và biên tập video demo 3 phút, nộp hồ sơ trên Avalanche Builder Hub trước 25/11.

### Lộ trình chi tiết theo ngày

* **Ngày 1–3 (11/11 – 13/11):** Chốt giao diện wireframe; viết xong và test 2 smart contract trên máy local.

* **Ngày 4–7 (14/11 – 17/11):** Deploy contract lên Fuji Testnet; hoàn thiện giao diện Client (xem vé, nạp tiền, chợ pass vé).

* **Ngày 8–10 (18/11 – 20/11):** Tích hợp QR động và làm trang Scanner cho bảo vệ soát vé; test toàn diện luồng Atomic Resale.

* **Ngày 11–12 (21/11 – 22/11):** Tinh chỉnh UI mượt mà; hoàn thiện slide Pitch Deck.

* **Ngày 13–14 (23/11 – 24/11):** Quay video demo 3 phút; viết file README GitHub chuẩn chỉ; nộp hồ sơ chính thức lên [Avalanche Builder Hub](https://build.avax.network/events/596c0b2d-63aa-4cf0-a0ad-a7e34ddbfdc0).