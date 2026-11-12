require("dotenv").config();
const express = require('express'),
  Database = require('better-sqlite3'),
  crypto = require('crypto'),
  QR = require('qrcode');
const chain = require('./blockchain');
const mailer = require('./mailer');

const db = new Database(process.env.DB || 'avatix.db'),
  app = express(),
  SECRET = process.env.SECRET || 'avatix-dev-secret-doi-khi-deploy';
const FEE = 0.05, CAP = 1.1, METHODS = ['momo', 'bank', 'vnpay', 'vietqr'];

db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,hash TEXT,salt TEXT,email TEXT,phone TEXT,bank TEXT,role TEXT,cccd TEXT,wallet TEXT,email_verified INTEGER DEFAULT 0,balance INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,org INTEGER,name TEXT,date TEXT,venue TEXT,price INTEGER,total INTEGER,remain INTEGER);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY,event INTEGER,owner INTEGER,orig INTEGER,listed INTEGER,used INTEGER DEFAULT 0,token_id INTEGER,tx_hash TEXT,contract_addr TEXT);
CREATE TABLE IF NOT EXISTS txs(id INTEGER PRIMARY KEY,user INTEGER,type TEXT,amount INTEGER,note TEXT,tx_hash TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(id INTEGER PRIMARY KEY,user_id INTEGER,email TEXT,purpose TEXT,code_hash TEXT,expires_at INTEGER,attempts INTEGER DEFAULT 0,used INTEGER DEFAULT 0,created_at INTEGER);`);

// Migration an toàn cho database đã tạo từ v1
const ensureCol = (table, col, def) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
ensureCol('users', 'wallet', 'TEXT');
ensureCol('users', 'email_verified', 'INTEGER DEFAULT 0');
ensureCol('tickets', 'token_id', 'INTEGER');
ensureCol('tickets', 'tx_hash', 'TEXT');
ensureCol('tickets', 'contract_addr', 'TEXT');
ensureCol('txs', 'tx_hash', 'TEXT');

const E = (m, c = 400) => Object.assign(new Error(m), { c }),
  q1 = (s, ...a) => db.prepare(s).get(...a),
  run = (s, ...a) => db.prepare(s).run(...a);
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex'),
  hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const cookies = r => Object.fromEntries((r.headers.cookie || '').split('; ').filter(Boolean).map(x => x.split('=')));
const auth = role => (r, s, n) => {
  try {
    const [id, exp, sg] = (cookies(r).t || '').split('.');
    if (!sg || sign(id + '.' + exp).slice(0, 32) !== sg || +exp < Date.now()) throw E('Chưa đăng nhập', 401);
    const u = q1('SELECT * FROM users WHERE id=?', id);
    if (!u) throw E('Chưa đăng nhập', 401);
    if (typeof role === 'string' && u.role !== role) throw E('Không có quyền truy cập', 403);
    if (!u.wallet) {
      u.wallet = chain.getWalletAddress(u.id);
      run('UPDATE users SET wallet=? WHERE id=?', u.wallet, u.id);
    }
    r.u = u;
    n();
  } catch (e) { n(e); }
};
const route = (m, p, role, f) => app[m]('/api/' + p, ...(role ? [auth(role)] : []), (r, s, n) => Promise.resolve().then(() => f(r, s)).then(d => s.json(d)).catch(n));
const log = (u, t, a, n, txHash = null) => run('INSERT INTO txs(user,type,amount,note,tx_hash) VALUES(?,?,?,?,?)', u, t, a, n, txHash).lastInsertRowid;
const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw E(msg); return n; };

// Backfill wallet address cho user cũ chưa có
for (const u of db.prepare('SELECT id FROM users WHERE wallet IS NULL').all()) {
  run('UPDATE users SET wallet=? WHERE id=?', chain.getWalletAddress(u.id), u.id);
}

app.use(express.json());

const PASS_RE = /^(?=.*[A-Z])(?=.*\d).{8,}$/;
const OTP_TTL = 5 * 60 * 1000, OTP_COOLDOWN = 30 * 1000, OTP_MAX_ATTEMPTS = 5;
const otpHash = (uid, purpose, code) => sign(`${uid}|${purpose}|${code}`);
const maskEmail = e => {
  const [n, d] = String(e || '').split('@');
  if (!d) return e;
  return (n.length <= 2 ? n[0] + '*' : n.slice(0, 2) + '***') + '@' + d;
};
const currentUserOpt = r => {
  try {
    const [id, exp, sg] = (cookies(r).t || '').split('.');
    if (!sg || sign(id + '.' + exp).slice(0, 32) !== sg || +exp < Date.now()) return null;
    return q1('SELECT * FROM users WHERE id=?', id) || null;
  } catch { return null; }
};
const resolveVerifyUser = r => {
  const logged = currentUserOpt(r);
  if (logged) return logged;
  const uname = String(r.body.username || '').trim();
  if (!uname) throw E('Vui lòng nhập tên đăng nhập cần xác thực email');
  const u = q1('SELECT * FROM users WHERE username=?', uname);
  if (!u) throw E('Không tìm thấy tài khoản');
  return u;
};
const resolveResetUser = identifier => {
  const id = String(identifier || '').trim();
  if (!id) throw E('Vui lòng nhập tên đăng nhập hoặc email');
  const byUser = q1('SELECT * FROM users WHERE username=?', id);
  if (byUser) return byUser;
  const byEmail = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').all(id);
  if (!byEmail.length) throw E('Không tìm thấy tài khoản phù hợp');
  if (byEmail.length > 1) throw E('Email này dùng cho nhiều tài khoản. Vui lòng nhập chính xác Tên đăng nhập.');
  return byEmail[0];
};
async function issueOtp(user, purpose) {
  const now = Date.now();
  const prev = q1('SELECT * FROM otps WHERE user_id=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', user.id, purpose);
  if (prev && now - prev.created_at < OTP_COOLDOWN) {
    const wait = Math.ceil((OTP_COOLDOWN - (now - prev.created_at)) / 1000);
    throw E(`Vui lòng đợi ${wait} giây trước khi gửi lại mã OTP`, 429);
  }
  run('UPDATE otps SET used=1 WHERE user_id=? AND purpose=? AND used=0', user.id, purpose);
  const code = String(crypto.randomInt(100000, 1000000));
  run(
    'INSERT INTO otps(user_id,email,purpose,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',
    user.id, user.email, purpose, otpHash(user.id, purpose, code), now + OTP_TTL, now
  );
  const mail = await mailer.sendOtpEmail({ to: user.email, username: user.username, code, purpose });
  return { ...mail, maskedEmail: maskEmail(user.email), expiresIn: 300 };
}
function verifyOtp(userId, purpose, rawCode) {
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code)) throw E('Mã OTP phải gồm 6 chữ số');
  const row = q1('SELECT * FROM otps WHERE user_id=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', userId, purpose);
  if (!row) throw E('Chưa có mã OTP hợp lệ. Vui lòng bấm gửi mã mới');
  if (row.expires_at < Date.now()) {
    run('UPDATE otps SET used=1 WHERE id=?', row.id);
    throw E('Mã OTP đã hết hạn (quá 5 phút), vui lòng gửi lại mã mới');
  }
  if (otpHash(userId, purpose, code) !== row.code_hash) {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= OTP_MAX_ATTEMPTS) {
      run('UPDATE otps SET attempts=?,used=1 WHERE id=?', nextAttempts, row.id);
      throw E('Nhập sai OTP quá 5 lần. Vui lòng yêu cầu mã OTP mới');
    }
    run('UPDATE otps SET attempts=? WHERE id=?', nextAttempts, row.id);
    throw E(`Mã OTP không chính xác (còn ${OTP_MAX_ATTEMPTS - nextAttempts} lần thử)`);
  }
  run('UPDATE otps SET used=1 WHERE id=?', row.id);
}

// ─── Auth routes ───────────────────────────────────────────────────────────
route('post', 'register', 0, async r => {
  const { username: u, password: p, email, phone, bank, role, cccd } = r.body;
  if (!/^.{8,}$/.test(u || '')) throw E('Tên đăng nhập tối thiểu 8 ký tự');
  if (!PASS_RE.test(p || '')) throw E('Mật khẩu tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw E('Email không hợp lệ');
  if (!/^0\d{9}$/.test(phone || '')) throw E('Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
  if (!/^.{3,} - \d{6,}$/.test(bank || '')) throw E('Vui lòng liên kết tài khoản ngân hàng hợp lệ');
  if (!['customer', 'organizer'].includes(role)) throw E('Loại tài khoản không hợp lệ');
  if (role === 'organizer' && !/^\d{12}$/.test(cccd || '')) throw E('Nhà cung cấp cần nhập CCCD gồm 12 số để xác minh');
  if (q1('SELECT 1 FROM users WHERE username=?', u)) throw E('Tên đăng nhập đã tồn tại');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = run(
    'INSERT INTO users(username,hash,salt,email,phone,bank,role,cccd,email_verified) VALUES(?,?,?,?,?,?,?,?,0)',
    u, hash(p, salt), salt, email, phone, bank, role, role === 'organizer' ? cccd : null
  );
  const userId = Number(info.lastInsertRowid);
  const wallet = chain.getWalletAddress(userId);
  run('UPDATE users SET wallet=? WHERE id=?', wallet, userId);
  const newUser = q1('SELECT * FROM users WHERE id=?', userId);
  let otpInfo = {};
  try {
    otpInfo = await issueOtp(newUser, 'verify_email');
  } catch (e) {
    otpInfo = { otpError: e.message };
  }
  return { ok: 1, wallet, needVerify: true, username: u, ...otpInfo };
});

route('post', 'verify-email/request', 0, async r => {
  const u = resolveVerifyUser(r);
  if (u.email_verified) throw E('Email tài khoản này đã được xác thực rồi');
  const res = await issueOtp(u, 'verify_email');
  return { ok: 1, username: u.username, ...res };
});

route('post', 'verify-email/confirm', 0, r => {
  const u = resolveVerifyUser(r);
  if (u.email_verified) return { ok: 1, emailVerified: true };
  verifyOtp(u.id, 'verify_email', r.body.code);
  run('UPDATE users SET email_verified=1 WHERE id=?', u.id);
  log(u.id, 'verify_email', 0, `Xác thực email thành công (${u.email})`);
  return { ok: 1, emailVerified: true };
});

route('post', 'change-password/request', true, async r => {
  if (!r.u.email_verified) throw E('Vui lòng xác thực Email trước khi đổi mật khẩu');
  const cur = String(r.body.currentPassword || '');
  if (!cur || hash(cur, r.u.salt) !== r.u.hash) throw E('Mật khẩu hiện tại không đúng', 401);
  const res = await issueOtp(r.u, 'change_password');
  return { ok: 1, ...res };
});

route('post', 'change-password/confirm', true, r => {
  if (!r.u.email_verified) throw E('Vui lòng xác thực Email trước khi đổi mật khẩu');
  const { currentPassword, newPassword, code } = r.body;
  if (!currentPassword || hash(currentPassword, r.u.salt) !== r.u.hash) throw E('Mật khẩu hiện tại không đúng', 401);
  if (!PASS_RE.test(newPassword || '')) throw E('Mật khẩu mới tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  if (newPassword === currentPassword) throw E('Mật khẩu mới phải khác mật khẩu hiện tại');
  verifyOtp(r.u.id, 'change_password', code);
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET hash=?,salt=? WHERE id=?', hash(newPassword, salt), salt, r.u.id);
  log(r.u.id, 'security', 0, 'Đổi mật khẩu (xác thực Mật khẩu cũ + OTP Email)');
  return { ok: 1 };
});

route('post', 'forgot-password/request', 0, async r => {
  const u = resolveResetUser(r.body.identifier);
  const res = await issueOtp(u, 'reset_password');
  return { ok: 1, username: u.username, ...res };
});

route('post', 'forgot-password/confirm', 0, r => {
  const u = resolveResetUser(r.body.identifier);
  const { code, newPassword } = r.body;
  if (!PASS_RE.test(newPassword || '')) throw E('Mật khẩu mới tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  verifyOtp(u.id, 'reset_password', code);
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET hash=?,salt=?,email_verified=1 WHERE id=?', hash(newPassword, salt), salt, u.id);
  log(u.id, 'security', 0, 'Khôi phục mật khẩu qua OTP Email');
  return { ok: 1 };
});

route('post', 'login', 0, (r, s) => {
  const u = q1('SELECT * FROM users WHERE username=?', r.body.username || '');
  if (!u || hash(r.body.password || '', u.salt) !== u.hash) throw E('Sai tên đăng nhập hoặc mật khẩu', 401);
  const exp = Date.now() + 864e5, id = u.id + '.' + exp;
  s.setHeader('Set-Cookie', `t=${id}.${sign(id).slice(0, 32)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`);
  return { role: u.role, emailVerified: Boolean(u.email_verified) };
});

route('post', 'logout', 0, (r, s) => { s.setHeader('Set-Cookie', 't=; Path=/; Max-Age=0'); return { ok: 1 }; });
route('get', 'me', true, r => {
  const { hash: _h, salt: _s, cccd: _c, ...u } = r.u;
  return {
    ...u,
    emailVerified: Boolean(r.u.email_verified),
    smtpEnabled: mailer.isSmtpConfigured(),
    chainEnabled: chain.isEnabled(),
    chain: chain.getStatus()
  };
});
route('get', 'chain', 0, () => chain.getStatus());

// ─── Topup ────────────────────────────────────────────────────────────────
route('post', 'topup', true, r => {
  const a = int(r.body.amount, 10000, 50000000, 'Số tiền nạp từ 10.000đ đến 50.000.000đ');
  if (!METHODS.includes(r.body.method)) throw E('Vui lòng chọn phương thức thanh toán');
  run('UPDATE users SET balance=balance+? WHERE id=?', a, r.u.id);
  log(r.u.id, 'topup', a, r.body.method);
  return { ok: 1 };
});

// ─── Events ───────────────────────────────────────────────────────────────
const evSql = 'SELECT e.*,u.username org FROM events e JOIN users u ON u.id=e.org';
route('get', 'events', true, () => db.prepare(evSql + ' ORDER BY e.date').all());
route('post', 'events', 'organizer', r => {
  const b = r.body, name = String(b.name || '').trim(), venue = String(b.venue || '').trim();
  if (!name || !venue) throw E('Nhập đủ tên sự kiện và địa điểm');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || b.date < new Date().toISOString().slice(0, 10)) throw E('Ngày tổ chức không hợp lệ');
  const price = int(b.price, 0, 100000000, 'Giá vé không hợp lệ'), total = int(b.total, 1, 100000, 'Số lượng vé phải là số nguyên dương');
  run('INSERT INTO events(org,name,date,venue,price,total,remain) VALUES(?,?,?,?,?,?,?)', r.u.id, name, b.date, venue, price, total, total);
  return { ok: 1 };
});

route('get', 'stats', 'organizer', r => db.prepare('SELECT * FROM events WHERE org=? ORDER BY date').all(r.u.id).map(e => {
  const sold = e.total - e.remain;
  return {
    ...e,
    sold,
    revenue: Math.round(sold * e.price * (1 - FEE)),
    checked: q1('SELECT COUNT(*) c FROM tickets WHERE event=? AND used=1', e.id).c,
    listed: q1('SELECT COUNT(*) c FROM tickets WHERE event=? AND listed IS NOT NULL AND used=0', e.id).c
  };
}));

// ─── Buy (Primary) ────────────────────────────────────────────────────────
const pay = (buyer, seller, price, note) => {
  const b = q1('SELECT balance FROM users WHERE id=?', buyer).balance;
  if (b < price) throw E('Số dư ví không đủ, vui lòng nạp thêm');
  const net = Math.round(price * (1 - FEE));
  run('UPDATE users SET balance=balance-? WHERE id=?', price, buyer);
  run('UPDATE users SET balance=balance+? WHERE id=?', net, seller);
  const buyerTxId = log(buyer, 'buy', -price, note);
  const sellerTxId = log(seller, 'sale', net, note);
  return { buyerTxId, sellerTxId };
};

const buyPrimaryTx = db.transaction((u, eventId) => {
  const e = q1('SELECT * FROM events WHERE id=?', eventId);
  if (!e) throw E('Không tìm thấy sự kiện');
  if (e.remain <= 0) throw E('Sự kiện đã SOLD OUT');
  const { buyerTxId, sellerTxId } = pay(u.id, e.org, e.price, e.name);
  run('UPDATE events SET remain=remain-1 WHERE id=?', eventId);
  const result = run('INSERT INTO tickets(event,owner,orig) VALUES(?,?,?)', eventId, u.id, e.price);
  return { ticketId: Number(result.lastInsertRowid), event: e, buyerTxId, sellerTxId };
});

const isActiveContractTicket = t => t && t.token_id && chain.isEnabled() &&
  (!t.contract_addr || t.contract_addr === chain.getStatus().avaTicketAddress);

route('post', 'buy', 'customer', async r => {
  const { ticketId, event, buyerTxId, sellerTxId } = buyPrimaryTx(r.u, +r.body.event);
  const chainRes = await chain.onBuyPrimary(ticketId, r.u.wallet, event.id, event.price);
  if (chainRes) {
    const contractAddr = chain.getStatus().avaTicketAddress;
    run('UPDATE tickets SET token_id=?,tx_hash=?,contract_addr=? WHERE id=?', chainRes.tokenId, chainRes.txHash, contractAddr, ticketId);
    run('UPDATE txs SET tx_hash=? WHERE id IN (?,?)', chainRes.txHash, buyerTxId, sellerTxId);
  }
  return {
    ok: 1,
    ticketId,
    tokenId: chainRes?.tokenId || null,
    txHash: chainRes?.txHash || null,
    explorerUrl: chain.explorerUrl(chainRes?.txHash)
  };
});

// ─── Tickets & Market ─────────────────────────────────────────────────────
route('get', 'tickets', 'customer', r => db.prepare(
  'SELECT t.*,e.name,e.date,e.venue FROM tickets t JOIN events e ON e.id=t.event WHERE t.owner=? ORDER BY t.id DESC'
).all(r.u.id));

route('get', 'tickets/:id/chain', true, async r => {
  const t = q1('SELECT t.*,e.name,e.org,u.wallet ownerWallet FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=t.owner WHERE t.id=?', +r.params.id);
  if (!t || (t.owner !== r.u.id && t.org !== r.u.id)) throw E('Không tìm thấy vé', 404);
  const onChain = isActiveContractTicket(t) ? await chain.getOnChainTicket(t.token_id) : null;
  return {
    ticket: t,
    onChain,
    chainStatus: chain.getStatus(),
    explorerUrl: chain.explorerUrl(t.tx_hash)
  };
});

route('post', 'list', 'customer', async r => {
  const t = q1('SELECT * FROM tickets WHERE id=? AND owner=?', +r.body.ticket, r.u.id);
  if (!t) throw E('Bạn không sở hữu vé này');
  if (t.used) throw E('Vé đã check-in, không thể bán lại');
  const max = Math.floor(t.orig * CAP), p = int(r.body.price, 1, Infinity, 'Giá không hợp lệ');
  if (p > max) throw E('Chống phe vé: giá bán tối đa là ' + max.toLocaleString('vi-VN') + 'đ (giá gốc + 10%)');
  run('UPDATE tickets SET listed=? WHERE id=?', p, t.id);

  let chainRes = null;
  if (isActiveContractTicket(t)) {
    chainRes = await chain.onListResale(t.token_id, r.u.wallet, p);
    if (chainRes?.txHash) {
      log(r.u.id, 'list', 0, `Đăng bán vé #${t.id} (NFT #${t.token_id}) giá ${p.toLocaleString('vi-VN')}đ`, chainRes.txHash);
    }
  }
  return { ok: 1, txHash: chainRes?.txHash || null, explorerUrl: chain.explorerUrl(chainRes?.txHash) };
});

route('post', 'unlist', 'customer', async r => {
  const t = q1('SELECT * FROM tickets WHERE id=? AND owner=?', +r.body.ticket, r.u.id);
  if (!t) throw E('Bạn không sở hữu vé này');
  run('UPDATE tickets SET listed=NULL WHERE id=? AND owner=?', t.id, r.u.id);
  let chainRes = null;
  if (isActiveContractTicket(t)) {
    chainRes = await chain.onUnlistResale(t.token_id, r.u.wallet);
  }
  return { ok: 1, txHash: chainRes?.txHash || null };
});

route('get', 'market', 'customer', () => db.prepare(
  'SELECT t.id,t.owner,t.listed,t.orig,t.token_id,t.tx_hash,e.name,e.date,e.venue,u.username seller FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=t.owner WHERE t.listed IS NOT NULL AND t.used=0'
).all());

// ─── Buy Resale ───────────────────────────────────────────────────────────
const buyResaleTx = db.transaction((u, ticketId) => {
  const t = q1('SELECT t.*,e.name FROM tickets t JOIN events e ON e.id=t.event WHERE t.id=? AND t.listed IS NOT NULL AND t.used=0', ticketId);
  if (!t) throw E('Vé không còn được rao bán');
  if (t.owner === u.id) throw E('Không thể tự mua vé của mình');
  const { buyerTxId, sellerTxId } = pay(u.id, t.owner, t.listed, t.name + ' (bán lại)');
  run('UPDATE tickets SET owner=?,listed=NULL WHERE id=?', u.id, ticketId);
  return { t, buyerTxId, sellerTxId };
});

route('post', 'buy-resale', 'customer', async r => {
  const { t, buyerTxId, sellerTxId } = buyResaleTx(r.u, +r.body.ticket);
  let chainRes = null;
  if (isActiveContractTicket(t)) {
    chainRes = await chain.onBuyResale(t.token_id, r.u.wallet);
    if (chainRes?.txHash) {
      run('UPDATE tickets SET tx_hash=? WHERE id=?', chainRes.txHash, t.id);
      run('UPDATE txs SET tx_hash=? WHERE id IN (?,?)', chainRes.txHash, buyerTxId, sellerTxId);
    }
  }
  return {
    ok: 1,
    tokenId: t.token_id || null,
    txHash: chainRes?.txHash || null,
    explorerUrl: chain.explorerUrl(chainRes?.txHash)
  };
});

// ─── QR động (xoay mỗi 20 giây -> tối đa 40s hợp lệ -> luôn <= 60s on-chain) ─
const STEP = 20;
const W = () => Math.floor(Date.now() / (STEP * 1000)),
  tok = (t, w) => `AVATIX|${t.id}|${t.owner}|${w}|${sign(`${t.id}|${t.owner}|${w}`)}`;

route('get', 'qr/:id', 'customer', async r => {
  const t = q1('SELECT * FROM tickets WHERE id=? AND owner=?', +r.params.id, r.u.id);
  if (!t) throw E('Bạn không sở hữu vé này');
  if (t.used) throw E('Vé đã được sử dụng');
  const token = tok(t, W());
  const svg = await QR.toString(token, { type: 'svg', errorCorrectionLevel: 'H', margin: 2, width: 360 });
  return { svg, token, left: STEP - Math.floor((Date.now() / 1000) % STEP) };
});

// ─── Scan (Check-in) ──────────────────────────────────────────────────────
route('post', 'scan', 'organizer', async r => {
  const p = String(r.body.token || '').trim().split('|'), [tag, id, own, w, sg] = p;
  if (tag !== 'AVATIX' || p.length !== 5 || sign(`${id}|${own}|${w}`) !== sg) throw E('Mã QR không hợp lệ');
  if (W() - Number(w) > 1 || Number(w) > W()) throw E('Mã QR đã hết hạn (ảnh chụp màn hình không có giá trị)');
  const t = q1('SELECT t.*,e.org,e.name FROM tickets t JOIN events e ON e.id=t.event WHERE t.id=?', +id);
  if (!t || t.org !== r.u.id) throw E('Vé không thuộc sự kiện của bạn');
  if (t.owner !== +own) throw E('Vé đã đổi chủ, mã cũ không còn hiệu lực');
  if (t.used) throw E('Vé đã được sử dụng trước đó');

  run('UPDATE tickets SET used=1,listed=NULL WHERE id=?', t.id);

  let chainRes = null;
  if (isActiveContractTicket(t)) {
    const totpTs = Number(w) * STEP;
    chainRes = await chain.onScanTicket(t.token_id, totpTs);
  }
  log(r.u.id, 'scan', 0, `Check-in vé #${t.id}: ${t.name}`, chainRes?.txHash || null);

  return {
    ok: 1,
    msg: `Check-in thành công: ${t.name} (vé #${t.id})`,
    tokenId: t.token_id || null,
    txHash: chainRes?.txHash || null,
    explorerUrl: chain.explorerUrl(chainRes?.txHash),
    chainEnabled: chain.isEnabled()
  };
});

// ─── Lịch sử giao dịch (kèm txHash Snowtrace) ────────────────────────────
route('get', 'history', true, r => {
  const rows = db.prepare('SELECT * FROM txs WHERE user=? ORDER BY id DESC LIMIT 50').all(r.u.id);
  return rows.map(tx => ({
    ...tx,
    explorerUrl: chain.explorerUrl(tx.tx_hash),
    snowtraceUrl: chain.explorerUrl(tx.tx_hash)
  }));
});

// ─── Static + Error handler ───────────────────────────────────────────────
app.use(express.static(__dirname + '/public', { index: 'login.html' }));
app.use((e, r, s, n) => s.status(e.c || 500).json({ e: e.c ? e.message : 'Lỗi máy chủ' }));

// ─── Startup ──────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    await chain.init();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log('AVA-TIX chạy tại http://localhost:' + port));
  })();
}

module.exports = { app, db, chain };
