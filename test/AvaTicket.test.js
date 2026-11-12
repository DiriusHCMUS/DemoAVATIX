const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("AVA-TIX Smart Contracts", function () {
  let avaTicket, marketplace;
  let admin, buyer, seller;

  beforeEach(async () => {
    [admin, buyer, seller] = await ethers.getSigners();

    const AvaTicket = await ethers.getContractFactory("AvaTicket");
    avaTicket = await AvaTicket.deploy();

    const Marketplace = await ethers.getContractFactory("TicketMarketplace");
    marketplace = await Marketplace.deploy(await avaTicket.getAddress());

    await avaTicket.setMarketplace(await marketplace.getAddress());
  });

  // ── 1. Mua vé sơ cấp ───────────────────────────────────────────────────
  it("Admin có thể mint vé cho buyer qua buyPrimaryTicket", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    const ticket = await avaTicket.getTicket(1);
    expect(ticket.owner).to.equal(buyer.address);
    expect(ticket.originalPrice).to.equal(500000n);
    expect(ticket.isCheckedIn).to.equal(false);
  });

  // ── 2. Chống phe vé — giá trần ─────────────────────────────────────────
  it("Từ chối đăng bán lại nếu giá > giá gốc + 10%", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    await expect(
      marketplace.listResale(1, buyer.address, 600000)
    ).to.be.revertedWith("Chong phe ve: Gia ban lai khong duoc vuot gia goc + 10%!");
  });

  it("Cho phép đăng bán lại nếu giá <= giá gốc + 10%", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    await expect(marketplace.listResale(1, buyer.address, 550000))
      .to.emit(marketplace, "TicketListedForResale")
      .withArgs(1n, buyer.address, 550000n);
  });

  it("Cho phép hủy đăng bán lại (unlistResale)", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    await marketplace.listResale(1, buyer.address, 550000);
    await expect(marketplace.unlistResale(1, buyer.address))
      .to.emit(marketplace, "TicketUnlisted")
      .withArgs(1n, buyer.address);
    await expect(
      marketplace.buyResale(1, seller.address)
    ).to.be.revertedWith("Ve khong con duoc rao ban");
  });

  // ── 3. Atomic Swap bán lại ─────────────────────────────────────────────
  it("buyResale chuyển ownership NFT sang buyer mới", async () => {
    await marketplace.buyPrimaryTicket(seller.address, 1, 500000, "General");
    await marketplace.listResale(1, seller.address, 500000);
    await marketplace.buyResale(1, buyer.address);
    const ticket = await avaTicket.getTicket(1);
    expect(ticket.owner).to.equal(buyer.address);
  });

  it("Không thể tự mua vé của chính mình", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    await marketplace.listResale(1, buyer.address, 500000);
    await expect(
      marketplace.buyResale(1, buyer.address)
    ).to.be.revertedWith("Khong the tu mua ve cua chinh minh");
  });

  // ── 4. QR động & Check-in ──────────────────────────────────────────────
  it("Scan vé thành công với timestamp hợp lệ (<= 60s)", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    const now = Math.floor(Date.now() / 1000) - 10;
    await marketplace.scanTicket(1, now);
    const ticket = await avaTicket.getTicket(1);
    expect(ticket.isCheckedIn).to.equal(true);
  });

  it("Từ chối scan nếu QR timestamp > 60 giây", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    const oldTs = Math.floor(Date.now() / 1000) - 90;
    await expect(
      marketplace.scanTicket(1, oldTs)
    ).to.be.revertedWith("Loi: Ma QR dong da het han (qua 60s)!");
  });

  it("Không thể scan vé đã check-in", async () => {
    await marketplace.buyPrimaryTicket(buyer.address, 1, 500000, "General");
    const now = Math.floor(Date.now() / 1000) - 5;
    await marketplace.scanTicket(1, now);
    await expect(
      marketplace.scanTicket(1, now)
    ).to.be.revertedWith("Loi: Ve nay da duoc check-in truoc do!");
  });

  // ── 5. Chỉ Admin được gọi Marketplace ─────────────────────────────────
  it("Non-admin không thể gọi buyPrimaryTicket", async () => {
    await expect(
      marketplace.connect(buyer).buyPrimaryTicket(buyer.address, 1, 500000, "General")
    ).to.be.revertedWith("Chi Admin duoc goi");
  });
});
