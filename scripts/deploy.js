// Script deploy AvaTicket + TicketMarketplace lên Hardhat Local hoặc Fuji Testnet
// Chạy local: npx hardhat run scripts/deploy.js --network localhost
// Chạy Fuji : npx hardhat run scripts/deploy.js --network fuji
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const isFuji = chainId === 43113;
  const networkName = isFuji ? "fuji" : chainId === 31337 ? "localhost" : `chain-${chainId}`;
  const rpcUrl = isFuji
    ? (process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc")
    : "http://127.0.0.1:8545";

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("Không tìm thấy deployer signer. Kiểm tra DEPLOYER_KEY trong .env!");
  }

  console.log(`Network  : ${networkName} (Chain ID: ${chainId})`);
  console.log("Deployer :", deployer.address);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Balance  :", ethers.formatEther(bal), isFuji ? "AVAX" : "ETH\n");

  if (bal === 0n) {
    throw new Error(
      `Số dư ví ${deployer.address} bằng 0! ` +
      (isFuji ? "Vui lòng nạp AVAX testnet tại https://faucet.avax.network hoặc https://core.app/tools/testnet-faucet/" : "")
    );
  }

  // 1. Deploy AvaTicket
  console.log("1️⃣  Deploying AvaTicket...");
  const AvaTicket = await ethers.getContractFactory("AvaTicket");
  const avaTicket = await AvaTicket.deploy();
  await avaTicket.waitForDeployment();
  const avaTicketAddr = await avaTicket.getAddress();
  console.log("   ✅ AvaTicket deployed to:", avaTicketAddr);

  // 2. Deploy TicketMarketplace
  console.log("2️⃣  Deploying TicketMarketplace...");
  const Marketplace = await ethers.getContractFactory("TicketMarketplace");
  const marketplace = await Marketplace.deploy(avaTicketAddr);
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log("   ✅ TicketMarketplace deployed to:", marketplaceAddr);

  // 3. Authorize Marketplace trong AvaTicket
  console.log("3️⃣  Setting Marketplace address in AvaTicket...");
  const tx = await avaTicket.setMarketplace(marketplaceAddr);
  await tx.wait();
  console.log("   ✅ Marketplace authorized in AvaTicket\n");

  // 4. Lưu địa chỉ vào contracts/deployed.json
  const contractsJson = {
    network: networkName,
    chainId,
    rpcUrl,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    AvaTicket: avaTicketAddr,
    TicketMarketplace: marketplaceAddr,
  };

  const contractsPath = path.join(__dirname, "../contracts/deployed.json");
  fs.writeFileSync(contractsPath, JSON.stringify(contractsJson, null, 2));
  console.log("📄 Đã lưu thông tin deploy vào contracts/deployed.json");

  // 5. Cập nhật .env
  const envPath = path.join(__dirname, "../.env");
  let envContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : fs.readFileSync(path.join(__dirname, "../.env.example"), "utf8");

  const updates = {
    RPC_URL: rpcUrl,
    CHAIN_ID: String(chainId),
    AVA_TICKET_ADDRESS: avaTicketAddr,
    MARKETPLACE_ADDRESS: marketplaceAddr,
  };
  if (!isFuji) {
    // Hardhat local account #0 private key để relayer ký giao dịch trên local node
    updates.RELAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  } else if (process.env.DEPLOYER_KEY) {
    updates.RELAYER_KEY = process.env.DEPLOYER_KEY;
  }

  for (const [key, val] of Object.entries(updates)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(envContent)) envContent = envContent.replace(re, line);
    else envContent = envContent.trimEnd() + `\n${line}`;
  }

  fs.writeFileSync(envPath, envContent.trim() + "\n");
  console.log("📄 Đã cập nhật địa chỉ contract vào .env\n");

  console.log("🎉 Deploy thành công!");
  if (isFuji) {
    console.log("   Snowtrace Marketplace:", `https://testnet.snowtrace.io/address/${marketplaceAddr}`);
    console.log("   Snowtrace AvaTicket  :", `https://testnet.snowtrace.io/address/${avaTicketAddr}`);
  }
}

main().catch((e) => {
  console.error("❌ Deploy error:", e.message);
  process.exit(1);
});
