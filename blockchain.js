/**
 * blockchain.js — AVA-TIX Blockchain Integration Layer
 *
 * Backend đóng vai trò Relayer (Gasless UX cho người dùng cuối):
 *   - Mỗi user có một địa chỉ ví EVM xác định (deterministic) trên Avalanche C-Chain
 *   - Backend dùng ví Relayer/Admin ký và trả gas cho các thao tác on-chain
 *   - Mọi hành động (buy, list, unlist, buy-resale, scan) đều:
 *       1. Thực thi atomic trong SQLite
 *       2. Ghi nhận on-chain qua TicketMarketplace -> AvaTicket
 *       3. Lưu tokenId + txHash vào SQLite để hiển thị minh chứng & link Snowtrace
 */

const crypto = require("crypto");
const { ethers } = require("ethers");

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const AvaTicketABI = [
  "function getTicket(uint256 ticketId) view returns (tuple(uint256 eventId, uint256 originalPrice, string seatInfo, bool isCheckedIn, uint256 checkInTime, address owner))",
  "function getOwnerTickets(address owner) view returns (uint256[])",
  "event TicketMinted(uint256 indexed ticketId, address indexed to, uint256 eventId, uint256 price)",
  "event TicketTransferred(uint256 indexed ticketId, address indexed from, address indexed to)",
  "event TicketCheckedIn(uint256 indexed ticketId, uint256 timestamp, address scanner)",
];

const MarketplaceABI = [
  "function buyPrimaryTicket(address buyer, uint256 eventId, uint256 price, string seat) returns (uint256)",
  "function listResale(uint256 ticketId, address seller, uint256 resalePrice)",
  "function unlistResale(uint256 ticketId, address seller)",
  "function buyResale(uint256 ticketId, address buyer)",
  "function scanTicket(uint256 ticketId, uint256 totpTimestamp)",
  "event TicketBought(uint256 indexed ticketId, address indexed buyer, uint256 eventId, uint256 price)",
  "event TicketListedForResale(uint256 indexed ticketId, address indexed seller, uint256 price)",
  "event TicketUnlisted(uint256 indexed ticketId, address indexed seller)",
  "event ResalePurchased(uint256 indexed ticketId, address indexed buyer, address indexed seller, uint256 price)",
  "event TicketScanned(uint256 indexed ticketId, address indexed scanner, uint256 timestamp)",
];

// ─── State ────────────────────────────────────────────────────────────────────
let provider = null;
let wallet = null;
let marketplace = null;
let avaTicket = null;
let enabled = false;
let chainId = 0;
let networkName = "Off-chain";
let avaTicketAddr = null;
let marketplaceAddr = null;
let txQueue = Promise.resolve();
let currentNonce = null;

function getWalletAddress(userId) {
  const secret = process.env.SECRET || "avatix-dev-secret-doi-khi-deploy";
  const privKey = crypto.createHmac("sha256", secret).update("wallet:" + String(userId)).digest("hex");
  return new ethers.Wallet("0x" + privKey).address;
}

async function init() {
  const rpc = process.env.RPC_URL || process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
  const privKey = process.env.RELAYER_KEY || process.env.DEPLOYER_KEY;
  marketplaceAddr = process.env.MARKETPLACE_ADDRESS || null;
  avaTicketAddr = process.env.AVA_TICKET_ADDRESS || null;
  chainId = Number(process.env.CHAIN_ID || 0);

  if (!privKey || !marketplaceAddr || !avaTicketAddr) {
    enabled = false;
    networkName = "Off-chain (chưa deploy contract)";
    console.warn(
      "[Blockchain] ⚠️  Chưa cấu hình CONTRACT/RELAYER trong .env\n" +
      "             → Chạy ở chế độ off-chain (SQLite only).\n" +
      "             → Chạy `npm run deploy:local` hoặc `npm run deploy:fuji` để kết nối smart contract."
    );
    return;
  }

  try {
    provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    wallet = new ethers.Wallet(privKey, provider);
    marketplace = new ethers.Contract(marketplaceAddr, MarketplaceABI, wallet);
    avaTicket = new ethers.Contract(avaTicketAddr, AvaTicketABI, provider);
    currentNonce = null;

    const net = await Promise.race([
      provider.getNetwork(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("RPC timeout")), 6000)),
    ]);
    chainId = Number(net.chainId);
    networkName = chainId === 43113 ? "Avalanche Fuji Testnet"
                : chainId === 31337 ? "Hardhat Local Node"
                : `EVM Chain #${chainId}`;

    const code = await provider.getCode(marketplaceAddr);
    if (!code || code === "0x") {
      throw new Error(`Không tìm thấy contract tại ${marketplaceAddr} trên ${networkName}`);
    }

    enabled = true;
    console.log(`[Blockchain] ✅ Kết nối ${networkName} (Chain ID: ${chainId})`);
    console.log(`[Blockchain]    AvaTicket        : ${avaTicketAddr}`);
    console.log(`[Blockchain]    TicketMarketplace: ${marketplaceAddr}`);
    console.log(`[Blockchain]    Relayer Wallet   : ${wallet.address}`);
  } catch (e) {
    enabled = false;
    networkName = "Off-chain (lỗi kết nối RPC)";
    console.error("[Blockchain] ⚠️  Không kết nối được chain, fallback về SQLite:", e.message);
  }
}

// ─── Serialized transaction runner (tránh đụng nonce khi nhiều request đồng thời) ──
function callContract(label, fn) {
  if (!enabled) return Promise.resolve(null);
  const run = txQueue.then(async () => {
    try {
      const rpcNonce = await provider.getTransactionCount(wallet.address, "pending");
      if (currentNonce === null || rpcNonce > currentNonce) currentNonce = rpcNonce;
      const nonce = currentNonce;
      const tx = await fn({ nonce });
      currentNonce = nonce + 1;
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("TX confirmation timeout (20s)")), 20000)),
      ]);
      console.log(`[Blockchain] ✅ ${label} → txHash: ${receipt.hash}`);
      return receipt;
    } catch (e) {
      currentNonce = null;
      console.error(`[Blockchain] ⚠️  ${label} failed:`, e.shortMessage || e.reason || e.message);
      return null;
    }
  });
  txQueue = run.catch(() => {});
  return run;
}

// ─── Contract Actions ─────────────────────────────────────────────────────────

async function onBuyPrimary(sqlTicketId, buyerAddr, eventId, price) {
  const receipt = await callContract(
    `BuyPrimary(sqlId=${sqlTicketId}, buyer=${buyerAddr.slice(0, 8)}...)`,
    (ov) => marketplace.buyPrimaryTicket(
      buyerAddr,
      BigInt(eventId),
      BigInt(price),
      `Ticket #${sqlTicketId}`,
      ov
    )
  );
  if (!receipt) return null;

  let tokenId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = marketplace.interface.parseLog(log);
      if (parsed && parsed.name === "TicketBought") {
        tokenId = Number(parsed.args.ticketId);
        break;
      }
    } catch {}
  }
  return { txHash: receipt.hash, tokenId };
}

async function onListResale(tokenId, sellerAddr, resalePrice) {
  const receipt = await callContract(
    `ListResale(tokenId=${tokenId}, price=${resalePrice})`,
    (ov) => marketplace.listResale(BigInt(tokenId), sellerAddr, BigInt(resalePrice), ov)
  );
  return receipt ? { txHash: receipt.hash } : null;
}

async function onUnlistResale(tokenId, sellerAddr) {
  const receipt = await callContract(
    `UnlistResale(tokenId=${tokenId})`,
    (ov) => marketplace.unlistResale(BigInt(tokenId), sellerAddr, ov)
  );
  return receipt ? { txHash: receipt.hash } : null;
}

async function onBuyResale(tokenId, buyerAddr) {
  const receipt = await callContract(
    `BuyResale(tokenId=${tokenId}, buyer=${buyerAddr.slice(0, 8)}...)`,
    (ov) => marketplace.buyResale(BigInt(tokenId), buyerAddr, ov)
  );
  return receipt ? { txHash: receipt.hash } : null;
}

async function onScanTicket(tokenId, totpTimestamp) {
  const receipt = await callContract(
    `ScanTicket(tokenId=${tokenId})`,
    (ov) => marketplace.scanTicket(BigInt(tokenId), BigInt(totpTimestamp), ov)
  );
  return receipt ? { txHash: receipt.hash } : null;
}

async function getOnChainTicket(tokenId) {
  if (!enabled || !avaTicket || !tokenId) return null;
  try {
    const t = await avaTicket.getTicket(BigInt(tokenId));
    return {
      tokenId: Number(tokenId),
      eventId: Number(t.eventId),
      originalPrice: Number(t.originalPrice),
      seatInfo: t.seatInfo,
      isCheckedIn: Boolean(t.isCheckedIn),
      checkInTime: Number(t.checkInTime),
      owner: t.owner,
    };
  } catch (e) {
    console.error(`[Blockchain] ⚠️  getOnChainTicket(${tokenId}) failed:`, e.message);
    return null;
  }
}

function explorerUrl(txHash) {
  if (!txHash) return null;
  if (chainId === 43113) return `https://testnet.snowtrace.io/tx/${txHash}`;
  return null;
}

function contractExplorerUrl(addr) {
  if (!addr) return null;
  if (chainId === 43113) return `https://testnet.snowtrace.io/address/${addr}`;
  return null;
}

function getStatus() {
  return {
    enabled,
    chainId,
    networkName,
    avaTicketAddress: avaTicketAddr,
    marketplaceAddress: marketplaceAddr,
    relayerAddress: wallet ? wallet.address : null,
    avaTicketExplorer: contractExplorerUrl(avaTicketAddr),
    marketplaceExplorer: contractExplorerUrl(marketplaceAddr),
  };
}

module.exports = {
  init,
  getWalletAddress,
  onBuyPrimary,
  onListResale,
  onUnlistResale,
  onBuyResale,
  onScanTicket,
  getOnChainTicket,
  explorerUrl,
  getStatus,
  isEnabled: () => enabled,
};
