// Script tạo ví mới và in ra địa chỉ + private key
// Chạy: node scripts/gen-wallet.js
const { ethers } = require("ethers");

const wallet = ethers.Wallet.createRandom();
console.log("=== VÍ AVALANCHE MỚI TẠO ===");
console.log("Address     :", wallet.address);
console.log("Private Key :", wallet.privateKey);
console.log("Mnemonic    :", wallet.mnemonic.phrase);
console.log("");
console.log("👉 Tiếp theo:");
console.log("  1. Copy địa chỉ trên vào Fuji Faucet: https://faucet.avax.network");
console.log("  2. Thêm vào file .env:");
console.log(`     DEPLOYER_KEY=${wallet.privateKey}`);
console.log(`     DEPLOYER_ADDRESS=${wallet.address}`);
