/**
 * db.js — Dual-mode database layer cho AVA-TIX
 * - Local (default): better-sqlite3  → avatix.db
 * - Render/Cloud: @libsql/client     → Turso (khi có TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
 *
 * API đồng nhất (async):
 *   await db.get(sql, args)         → row | undefined
 *   await db.all(sql, args)         → row[]
 *   await db.run(sql, args)         → { lastInsertRowid, rowsAffected }
 *   await db.batch(stmts)           → void  (transaction)
 *   await db.migrate()              → void  (tạo bảng + migration cột)
 */

require('dotenv').config();

const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const useTurso    = !!(TURSO_URL && TURSO_TOKEN);

// ─────────────────────────────────────────────────────────────────────────────
// TURSO mode
// ─────────────────────────────────────────────────────────────────────────────
if (useTurso) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  console.log('[DB] Kết nối Turso:', TURSO_URL.replace(/\/\/.*@/, '//***@'));

  // Chuyển args: undefined/null → [] ; object → object ; array → array
  const toArgs = a => (a == null ? [] : a);

  const db = {
    async get(sql, args) {
      const r = await client.execute({ sql, args: toArgs(args) });
      return r.rows[0] ? Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]])) : undefined;
    },
    async all(sql, args) {
      const r = await client.execute({ sql, args: toArgs(args) });
      return r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    },
    async run(sql, args) {
      const r = await client.execute({ sql, args: toArgs(args) });
      return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), rowsAffected: r.rowsAffected ?? 0 };
    },
    async batch(stmts) {
      // stmts: Array<{ sql, args? }>
      await client.batch(stmts.map(s => ({ sql: s.sql, args: toArgs(s.args) })), 'write');
    },
    async migrate() {
      await _migrate(db);
    },
    _isTurso: true,
  };

  module.exports = db;

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL SQLite mode (better-sqlite3, sync wrapped in async)
// ─────────────────────────────────────────────────────────────────────────────
} else {
  const BetterSqlite = require('better-sqlite3');
  const sqliteDb = new BetterSqlite(process.env.DB || 'avatix.db');
  console.log('[DB] Dùng SQLite cục bộ:', process.env.DB || 'avatix.db');

  const db = {
    async get(sql, args) {
      return sqliteDb.prepare(sql).get(...(args || []));
    },
    async all(sql, args) {
      return sqliteDb.prepare(sql).all(...(args || []));
    },
    async run(sql, args) {
      const r = sqliteDb.prepare(sql).run(...(args || []));
      return { lastInsertRowid: Number(r.lastInsertRowid), rowsAffected: r.changes };
    },
    async batch(stmts) {
      const tx = sqliteDb.transaction(() => {
        for (const s of stmts) sqliteDb.prepare(s.sql).run(...(s.args || []));
      });
      tx();
    },
    async migrate() {
      await _migrate(db);
    },
    // Dùng nội bộ cho backfill: trả về mảng ngay lập tức (đồng bộ)
    _rawAll(sql, args) {
      return sqliteDb.prepare(sql).all(...(args || []));
    },
    _isTurso: false,
  };

  module.exports = db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration dùng chung cho cả 2 mode
// ─────────────────────────────────────────────────────────────────────────────
async function _migrate(db) {
  // Tạo bảng (idempotent)
  const creates = [
    `CREATE TABLE IF NOT EXISTS users(
       id INTEGER PRIMARY KEY,
       username TEXT UNIQUE COLLATE NOCASE,
       hash TEXT, salt TEXT, email TEXT, phone TEXT,
       bank TEXT, role TEXT, cccd TEXT,
       wallet TEXT, email_verified INTEGER DEFAULT 0,
       balance INTEGER DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS events(
       id INTEGER PRIMARY KEY,
       org INTEGER, name TEXT, date TEXT, venue TEXT,
       price INTEGER, total INTEGER, remain INTEGER,
       description TEXT, image TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS tickets(
       id INTEGER PRIMARY KEY,
       event INTEGER, owner INTEGER, orig INTEGER,
       listed INTEGER, used INTEGER DEFAULT 0,
       token_id INTEGER, tx_hash TEXT, contract_addr TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS txs(
       id INTEGER PRIMARY KEY,
       user INTEGER, type TEXT, amount INTEGER,
       note TEXT, tx_hash TEXT,
       at TEXT DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS otps(
       id INTEGER PRIMARY KEY,
       user_id INTEGER, email TEXT, purpose TEXT,
       code_hash TEXT, expires_at INTEGER,
       attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0,
       created_at INTEGER
     )`,
  ];

  for (const sql of creates) await db.run(sql);

  // Migration an toàn: thêm cột mới vào bảng cũ
  const migrations = [
    { check: `PRAGMA table_info(users)`,   col: 'wallet',         sql: `ALTER TABLE users   ADD COLUMN wallet TEXT` },
    { check: `PRAGMA table_info(users)`,   col: 'email_verified', sql: `ALTER TABLE users   ADD COLUMN email_verified INTEGER DEFAULT 0` },
    { check: `PRAGMA table_info(events)`,  col: 'description',    sql: `ALTER TABLE events  ADD COLUMN description TEXT` },
    { check: `PRAGMA table_info(events)`,  col: 'image',          sql: `ALTER TABLE events  ADD COLUMN image TEXT` },
    { check: `PRAGMA table_info(tickets)`, col: 'token_id',       sql: `ALTER TABLE tickets ADD COLUMN token_id INTEGER` },
    { check: `PRAGMA table_info(tickets)`, col: 'tx_hash',        sql: `ALTER TABLE tickets ADD COLUMN tx_hash TEXT` },
    { check: `PRAGMA table_info(tickets)`, col: 'contract_addr',  sql: `ALTER TABLE tickets ADD COLUMN contract_addr TEXT` },
    { check: `PRAGMA table_info(txs)`,     col: 'tx_hash',        sql: `ALTER TABLE txs     ADD COLUMN tx_hash TEXT` },
  ];

  for (const m of migrations) {
    const cols = await db.all(m.check);
    if (!cols.some(c => c.name === m.col)) {
      try { await db.run(m.sql); } catch (_) { /* cột đã tồn tại */ }
    }
  }

  // ── Auto-seed demo data (chỉ khi events trống) ────────────────────────────
  const eventCount = await db.get('SELECT COUNT(*) cnt FROM events');
  if (Number(eventCount?.cnt || 0) === 0) {
    console.log('[DB] Seeding dữ liệu demo...');
    const crypto = require('crypto');

    const demoOrg = { username: 'demo_organizer', password: 'Demo@2025' };
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = crypto.scryptSync(demoOrg.password, salt, 32).toString('hex');

    // Thêm organizer demo (bỏ qua nếu đã tồn tại)
    let orgId;
    const existing = await db.get('SELECT id FROM users WHERE username=?', [demoOrg.username]);
    if (existing) {
      orgId = existing.id;
    } else {
      const r = await db.run(
        `INSERT INTO users(username,hash,salt,email,phone,bank,role,cccd,email_verified,balance)
         VALUES(?,?,?,?,?,?,?,?,1,10000000)`,
        [demoOrg.username, passHash, salt,
         'demo@avatix.vn', '0901234567',
         'VietcomBank - 1234567890',
         'organizer', '123456789012']
      );
      orgId = r.lastInsertRowid;
    }

    // Wallets sẽ được backfill sau khi chain.init()
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    const addDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

    const events = [
      {
        name: 'Đêm nhạc AVA-TUNES 2025',
        date: fmt(addDays(14)),
        venue: 'Nhà Hát Thành Phố, TP.HCM',
        price: 150000,
        total: 200,
        description: 'Đêm nhạc Acoustic & EDM quy tụ các nghệ sĩ trẻ tài năng. Thời gian mở cửa: 18h00, bắt đầu biểu diễn: 19h30. Vé đã bao gồm 01 phần nước uống miễn phí tại quầy và quà lưu niệm từ AVA-TIX. Quy định: Vui lòng xuất trình mã QR động lúc check-in tại cổng, không mang thức ăn ngoài vào khán phòng.',
        image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=900&q=80'
      },
      {
        name: 'Festival Blockchain Việt Nam',
        date: fmt(addDays(21)),
        venue: 'GEM Center, Quận 1, TP.HCM',
        price: 300000,
        total: 500,
        description: 'Diễn đàn công nghệ & ngày hội Web3 lớn nhất năm. Khám phá các xu hướng Layer 1/2, NFT Ticketing minh bạch, AI x Crypto cùng hơn 30 diễn giả đầu ngành. Thời gian: 08h30 - 17h30. Quyền lợi: Bao gồm teabreak, tài liệu hội thảo và quyền truy cập khu vực triển lãm công nghệ cao.',
        image: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=900&q=80'
      },
      {
        name: 'Concert Indie Mùa Thu 2025',
        date: fmt(addDays(30)),
        venue: 'Sân Khấu Trống Đồng, Hà Nội',
        price: 200000,
        total: 300,
        description: 'Không gian âm nhạc mộc mạc, gần gũi với những giai điệu Indie lãng mạn giữa lòng thủ đô. Thời gian: 19h00 - 22h00. Chỗ ngồi tự do theo khu vực vé. Vui lòng có mặt trước 30 phút để check-in vé on-chain vào cổng.',
        image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=900&q=80'
      },
    ];

    for (const ev of events) {
      await db.run(
        'INSERT INTO events(org,name,date,venue,price,total,remain,description,image) VALUES(?,?,?,?,?,?,?,?,?)',
        [orgId, ev.name, ev.date, ev.venue, ev.price, ev.total, ev.total, ev.description, ev.image]
      );
    }
    console.log('[DB] ✓ Seeded: 1 organizer demo + 3 sự kiện mẫu (kèm thông tin chi tiết)');
    console.log('[DB]   Tài khoản demo: demo_organizer / Demo@2025');
  } else {
    // Backfill description cho các sự kiện cũ chưa có mô tả
    const emptyDesc = await db.all("SELECT id, name FROM events WHERE description IS NULL OR TRIM(description) = ''");
    for (const e of emptyDesc) {
      let d = 'Sự kiện âm nhạc nghệ thuật đặc sắc được phân phối vé minh bạch qua hệ thống AVA-TIX. Thời gian mở cổng: 18h30. Vé check-in bằng mã QR động chống sao chép và chống phe vé.';
      if (e.name.includes('AVA-TUNES')) d = 'Đêm nhạc Acoustic & EDM quy tụ các nghệ sĩ trẻ tài năng. Thời gian mở cửa: 18h00, bắt đầu biểu diễn: 19h30. Vé đã bao gồm 01 phần nước uống miễn phí tại quầy và quà lưu niệm từ AVA-TIX. Quy định: Vui lòng xuất trình mã QR động lúc check-in tại cổng.';
      else if (e.name.includes('Blockchain')) d = 'Diễn đàn công nghệ & ngày hội Web3 lớn nhất năm. Khám phá các xu hướng Layer 1/2, NFT Ticketing minh bạch, AI x Crypto cùng hơn 30 diễn giả đầu ngành. Thời gian: 08h30 - 17h30. Quyền lợi: Bao gồm teabreak, tài liệu hội thảo và khu vực triển lãm.';
      else if (e.name.includes('Indie')) d = 'Không gian âm nhạc mộc mạc, gần gũi với những giai điệu Indie lãng mạn giữa lòng thủ đô. Thời gian: 19h00 - 22h00. Chỗ ngồi tự do theo khu vực vé. Vui lòng có mặt trước 30 phút để check-in vé on-chain vào cổng.';
      await db.run('UPDATE events SET description=? WHERE id=?', [d, e.id]);
    }

    // Backfill image cho các sự kiện cũ chưa có ảnh
    const emptyImg = await db.all("SELECT id, name FROM events WHERE image IS NULL OR TRIM(image) = ''");
    for (const e of emptyImg) {
      let img = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=900&q=80';
      const n = (e.name || '').toLowerCase();
      if (n.includes('blockchain') || n.includes('web3') || n.includes('crypto')) {
        img = 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=900&q=80';
      } else if (n.includes('indie') || n.includes('acoustic') || n.includes('thu')) {
        img = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=900&q=80';
      }
      await db.run('UPDATE events SET image=? WHERE id=?', [img, e.id]);
    }
  }

  // ── Đảm bảo 2 tài khoản demo luôn sẵn sàng cho Giám khảo trải nghiệm ────
  const crypto = require('crypto');
  const demoAccounts = [
    {
      username: 'demo_organizer',
      password: 'Demo@2025',
      email: 'demo@avatix.vn',
      phone: '0901234567',
      bank: 'VietcomBank - 1234567890',
      role: 'organizer',
      cccd: '123456789012',
      minBal: 10000000
    },
    {
      username: 'demo_customer',
      password: 'Demo@2025',
      email: 'customer@avatix.vn',
      phone: '0987654321',
      bank: 'Vietcombank - 9876543210',
      role: 'customer',
      cccd: null,
      minBal: 5000000
    }
  ];

  for (const acc of demoAccounts) {
    const existing = await db.get('SELECT id, balance FROM users WHERE username=?', [acc.username]);
    if (!existing) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passHash = crypto.scryptSync(acc.password, salt, 32).toString('hex');
      const r = await db.run(
        `INSERT INTO users(username,hash,salt,email,phone,bank,role,cccd,email_verified,balance)
         VALUES(?,?,?,?,?,?,?,?,1,?)`,
        [acc.username, passHash, salt, acc.email, acc.phone, acc.bank, acc.role, acc.cccd, acc.minBal]
      );
      const uid = Number(r.lastInsertRowid);
      const secret = process.env.SECRET || 'avatix-dev-secret-doi-khi-deploy';
      const privKey = crypto.createHmac('sha256', secret).update('wallet:' + String(uid)).digest('hex');
      const { ethers } = require('ethers');
      const wallet = new ethers.Wallet('0x' + privKey).address;
      await db.run('UPDATE users SET wallet=? WHERE id=?', [wallet, uid]);
      console.log(`[DB] ✓ Tạo tài khoản demo: ${acc.username} (${acc.role})`);
    } else if (existing.balance < 500000) {
      // Nạp lại tiền nếu tài khoản test bị hết tiền
      await db.run('UPDATE users SET balance=balance+? WHERE id=?', [acc.minBal, existing.id]);
    }
  }
}
