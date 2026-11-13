require("dotenv").config();
const express = require('express'),
  crypto = require('crypto'),
  QR = require('qrcode');
const chain = require('./blockchain');
const mailer = require('./mailer');
const db = require('./db');  // ← dual-mode DB (Turso cloud hoặc SQLite local)

const app = express();
app.use(express.json());
const SECRET = process.env.SECRET || 'avatix-dev-secret-doi-khi-deploy';
const FEE = 0.05, CAP = 1.1, METHODS = ['momo', 'bank', 'vnpay', 'vietqr'];

const E = (m, c = 400) => Object.assign(new Error(m), { c }),
  sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex'),
  hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const cookies = r => Object.fromEntries((r.headers.cookie || '').split('; ').filter(Boolean).map(x => x.split('=')));
const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw E(msg); return n; };

const auth = role => async (r, s, n) => {
  try {
    const [id, exp, sg] = (cookies(r).t || '').split('.');
    if (!sg || sign(id + '.' + exp).slice(0, 32) !== sg || +exp < Date.now()) throw E('Chưa đăng nhập', 401);
    const u = await db.get('SELECT * FROM users WHERE id=?', [id]);
    if (!u) throw E('Chưa đăng nhập', 401);
    if (typeof role === 'string' && u.role !== role) throw E('Không có quyền truy cập', 403);
    if (!u.wallet) {
      u.wallet = chain.getWalletAddress(u.id);
      await db.run('UPDATE users SET wallet=? WHERE id=?', [u.wallet, u.id]);
    }
    r.u = u;
    n();
  } catch (e) { n(e); }
};
const route = (m, p, role, f) => app[m]('/api/' + p, ...(role ? [auth(role)] : []), (r, s, n) => Promise.resolve().then(() => f(r, s)).then(d => s.json(d)).catch(n));
const log = async (u, t, a, n, txHash = null) => {
  const r = await db.run('INSERT INTO txs(user,type,amount,note,tx_hash) VALUES(?,?,?,?,?)', [u, t, a, n, txHash]);
  return r.lastInsertRowid;
};

// ─── OTP ─────────────────────────────────────────────────────────────────────
const PASS_RE = /^(?=.*[A-Z])(?=.*\d).{8,}$/;
const OTP_TTL = 5 * 60 * 1000, OTP_COOLDOWN = 30 * 1000, OTP_MAX_ATTEMPTS = 5;
const otpHash = (uid, purpose, code) => sign(`${uid}|${purpose}|${code}`);
const maskEmail = e => {
  const [n, d] = String(e || '').split('@');
  if (!d) return e;
  return (n.length <= 2 ? n[0] + '*' : n.slice(0, 2) + '***') + '@' + d;
};
const currentUserOpt = async r => {
  try {
    const [id, exp, sg] = (cookies(r).t || '').split('.');
    if (!sg || sign(id + '.' + exp).slice(0, 32) !== sg || +exp < Date.now()) return null;
    return await db.get('SELECT * FROM users WHERE id=?', [id]) || null;
  } catch { return null; }
};
const resolveVerifyUser = async r => {
  const logged = await currentUserOpt(r);
  if (logged) return logged;
  const uname = String(r.body.username || '').trim();
  if (!uname) throw E('Vui lòng nhập tên đăng nhập cần xác thực email');
  const u = await db.get('SELECT * FROM users WHERE username=?', [uname]);
  if (!u) throw E('Không tìm thấy tài khoản');
  return u;
};
const resolveResetUser = async identifier => {
  const id = String(identifier || '').trim();
  if (!id) throw E('Vui lòng nhập tên đăng nhập hoặc email');
  const byUser = await db.get('SELECT * FROM users WHERE username=?', [id]);
  if (byUser) return byUser;
  const byEmail = await db.all('SELECT * FROM users WHERE lower(email)=lower(?)', [id]);
  if (!byEmail.length) throw E('Không tìm thấy tài khoản phù hợp');
  if (byEmail.length > 1) throw E('Email này dùng cho nhiều tài khoản. Vui lòng nhập chính xác Tên đăng nhập.');
  return byEmail[0];
};
async function issueOtp(user, purpose) {
  const now = Date.now();
  const prev = await db.get('SELECT * FROM otps WHERE user_id=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', [user.id, purpose]);
  if (prev && now - prev.created_at < OTP_COOLDOWN) {
    const wait = Math.ceil((OTP_COOLDOWN - (now - prev.created_at)) / 1000);
    throw E(`Vui lòng đợi ${wait} giây trước khi gửi lại mã OTP`, 429);
  }
  await db.run('UPDATE otps SET used=1 WHERE user_id=? AND purpose=? AND used=0', [user.id, purpose]);
  const code = String(crypto.randomInt(100000, 1000000));
  await db.run(
    'INSERT INTO otps(user_id,email,purpose,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',
    [user.id, user.email, purpose, otpHash(user.id, purpose, code), now + OTP_TTL, now]
  );
  const mail = await mailer.sendOtpEmail({ to: user.email, username: user.username, code, purpose });
  return { ...mail, maskedEmail: maskEmail(user.email), expiresIn: 300 };
}
async function verifyOtp(userId, purpose, rawCode) {
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code)) throw E('Mã OTP phải gồm 6 chữ số');
  const row = await db.get('SELECT * FROM otps WHERE user_id=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', [userId, purpose]);
  if (!row) throw E('Chưa có mã OTP hợp lệ. Vui lòng bấm gửi mã mới');
  if (row.expires_at < Date.now()) {
    await db.run('UPDATE otps SET used=1 WHERE id=?', [row.id]);
    throw E('Mã OTP đã hết hạn (quá 5 phút), vui lòng gửi lại mã mới');
  }
  if (otpHash(userId, purpose, code) !== row.code_hash) {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= OTP_MAX_ATTEMPTS) {
      await db.run('UPDATE otps SET attempts=?,used=1 WHERE id=?', [nextAttempts, row.id]);
      throw E('Nhập sai OTP quá 5 lần. Vui lòng yêu cầu mã OTP mới');
    }
    await db.run('UPDATE otps SET attempts=? WHERE id=?', [nextAttempts, row.id]);
    throw E(`Mã OTP không chính xác (còn ${OTP_MAX_ATTEMPTS - nextAttempts} lần thử)`);
  }
  await db.run('UPDATE otps SET used=1 WHERE id=?', [row.id]);
}

// ─── Auth routes ─────────────────────────────────────────────────────────────
route('post', 'register', 0, async r => {
  const { username: u, password: p, email, phone, bank, role, cccd } = r.body;
  if (!/^.{8,}$/.test(u || '')) throw E('Tên đăng nhập tối thiểu 8 ký tự');
  if (!PASS_RE.test(p || '')) throw E('Mật khẩu tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw E('Email không hợp lệ');
  if (!/^0\d{9}$/.test(phone || '')) throw E('Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
  if (!/^.{3,} - \d{6,}$/.test(bank || '')) throw E('Vui lòng liên kết tài khoản ngân hàng hợp lệ');
  if (!['customer', 'organizer'].includes(role)) throw E('Loại tài khoản không hợp lệ');
  if (role === 'organizer' && !/^\d{12}$/.test(cccd || '')) throw E('Nhà cung cấp cần nhập CCCD gồm 12 số để xác minh');
  if (await db.get('SELECT 1 FROM users WHERE username=?', [u])) throw E('Tên đăng nhập đã tồn tại');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = await db.run(
    'INSERT INTO users(username,hash,salt,email,phone,bank,role,cccd,email_verified) VALUES(?,?,?,?,?,?,?,?,0)',
    [u, hash(p, salt), salt, email, phone, bank, role, role === 'organizer' ? cccd : null]
  );
  const userId = Number(info.lastInsertRowid);
  const wallet = chain.getWalletAddress(userId);
  await db.run('UPDATE users SET wallet=? WHERE id=?', [wallet, userId]);
  const newUser = await db.get('SELECT * FROM users WHERE id=?', [userId]);
  let otpInfo = {};
  try { otpInfo = await issueOtp(newUser, 'verify_email'); } catch (e) { otpInfo = { otpError: e.message }; }
  return { ok: 1, wallet, needVerify: true, username: u, ...otpInfo };
});

route('post', 'verify-email/request', 0, async r => {
  const u = await resolveVerifyUser(r);
  if (u.email_verified) throw E('Email tài khoản này đã được xác thực rồi');
  const res = await issueOtp(u, 'verify_email');
  return { ok: 1, username: u.username, ...res };
});

route('post', 'verify-email/confirm', 0, async r => {
  const u = await resolveVerifyUser(r);
  if (u.email_verified) return { ok: 1, emailVerified: true };
  await verifyOtp(u.id, 'verify_email', r.body.code);
  await db.run('UPDATE users SET email_verified=1 WHERE id=?', [u.id]);
  await log(u.id, 'verify_email', 0, `Xác thực email thành công (${u.email})`);
  return { ok: 1, emailVerified: true };
});

route('post', 'change-password/request', true, async r => {
  if (!r.u.email_verified) throw E('Vui lòng xác thực Email trước khi đổi mật khẩu');
  const cur = String(r.body.currentPassword || '');
  if (!cur || hash(cur, r.u.salt) !== r.u.hash) throw E('Mật khẩu hiện tại không đúng', 401);
  const res = await issueOtp(r.u, 'change_password');
  return { ok: 1, ...res };
});

route('post', 'change-password/confirm', true, async r => {
  if (!r.u.email_verified) throw E('Vui lòng xác thực Email trước khi đổi mật khẩu');
  const { currentPassword, newPassword, code } = r.body;
  if (!currentPassword || hash(currentPassword, r.u.salt) !== r.u.hash) throw E('Mật khẩu hiện tại không đúng', 401);
  if (!PASS_RE.test(newPassword || '')) throw E('Mật khẩu mới tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  if (newPassword === currentPassword) throw E('Mật khẩu mới phải khác mật khẩu hiện tại');
  await verifyOtp(r.u.id, 'change_password', code);
  const salt = crypto.randomBytes(16).toString('hex');
  await db.run('UPDATE users SET hash=?,salt=? WHERE id=?', [hash(newPassword, salt), salt, r.u.id]);
  await log(r.u.id, 'security', 0, 'Đổi mật khẩu (xác thực Mật khẩu cũ + OTP Email)');
  return { ok: 1 };
});

route('post', 'forgot-password/request', 0, async r => {
  const u = await resolveResetUser(r.body.identifier);
  const res = await issueOtp(u, 'reset_password');
  return { ok: 1, username: u.username, ...res };
});

route('post', 'forgot-password/confirm', 0, async r => {
  const u = await resolveResetUser(r.body.identifier);
  const { code, newPassword } = r.body;
  if (!PASS_RE.test(newPassword || '')) throw E('Mật khẩu mới tối thiểu 8 ký tự, gồm 1 chữ in hoa và 1 chữ số');
  await verifyOtp(u.id, 'reset_password', code);
  const salt = crypto.randomBytes(16).toString('hex');
  await db.run('UPDATE users SET hash=?,salt=?,email_verified=1 WHERE id=?', [hash(newPassword, salt), salt, u.id]);
  await log(u.id, 'security', 0, 'Khôi phục mật khẩu qua OTP Email');
  return { ok: 1 };
});

route('post', 'login', 0, async (r, s) => {
  const u = await db.get('SELECT * FROM users WHERE username=?', [r.body.username || '']);
  if (!u || hash(r.body.password || '', u.salt) !== u.hash) throw E('Sai tên đăng nhập hoặc mật khẩu', 401);
  const exp = Date.now() + 864e5, id = u.id + '.' + exp;
  s.setHeader('Set-Cookie', `t=${id}.${sign(id).slice(0, 32)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`);
  return { role: u.role, emailVerified: Boolean(u.email_verified) };
});

route('post', 'logout', 0, (r, s) => { s.setHeader('Set-Cookie', 't=; Path=/; Max-Age=0'); return { ok: 1 }; });
route('get', 'me', true, async r => {
  const { hash: _h, salt: _s, cccd: _c, ...u } = r.u;
  return { ...u, emailVerified: Boolean(r.u.email_verified), smtpEnabled: mailer.isSmtpConfigured(), chainEnabled: chain.isEnabled(), chain: chain.getStatus() };
});
route('get', 'chain', 0, () => chain.getStatus());

// ─── Topup ────────────────────────────────────────────────────────────────────
route('post', 'topup', true, async r => {
  const a = int(r.body.amount, 10000, 50000000, 'Số tiền nạp từ 10.000đ đến 50.000.000đ');
  if (!METHODS.includes(r.body.method)) throw E('Vui lòng chọn phương thức thanh toán');
  await db.run('UPDATE users SET balance=balance+? WHERE id=?', [a, r.u.id]);
  await log(r.u.id, 'topup', a, r.body.method);
  return { ok: 1 };
});

// ─── Events ───────────────────────────────────────────────────────────────────
const evSql = 'SELECT e.*,u.username org FROM events e JOIN users u ON u.id=e.org';
route('get', 'events', true, () => db.all(evSql + ' ORDER BY e.date'));
route('post', 'events', 'organizer', async r => {
  const b = r.body, name = String(b.name || '').trim(), venue = String(b.venue || '').trim();
  const desc = String(b.description || '').trim();
  if (!name || !venue) throw E('Nhập đủ tên sự kiện và địa điểm');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || b.date < new Date().toISOString().slice(0, 10)) throw E('Ngày tổ chức không hợp lệ');
  const price = int(b.price, 0, 100000000, 'Giá vé không hợp lệ'), total = int(b.total, 1, 100000, 'Số lượng vé phải là số nguyên dương');
  await db.run('INSERT INTO events(org,name,date,venue,price,total,remain,description) VALUES(?,?,?,?,?,?,?,?)', [r.u.id, name, b.date, venue, price, total, total, desc]);
  return { ok: 1 };
});

route('get', 'stats', 'organizer', async r => {
  const events = await db.all('SELECT * FROM events WHERE org=? ORDER BY date', [r.u.id]);
  const result = [];
  for (const e of events) {
    const sold = e.total - e.remain;
    const checked = await db.get('SELECT COUNT(*) c FROM tickets WHERE event=? AND used=1', [e.id]);
    const listed  = await db.get('SELECT COUNT(*) c FROM tickets WHERE event=? AND listed IS NOT NULL AND used=0', [e.id]);
    result.push({ ...e, sold, revenue: Math.round(sold * e.price * (1 - FEE)), checked: checked.c, listed: listed.c });
  }
  return result;
});

// ─── Pay helper ───────────────────────────────────────────────────────────────
const pay = async (buyer, seller, price, note) => {
  const b = await db.get('SELECT balance FROM users WHERE id=?', [buyer]);
  if (b.balance < price) throw E('Số dư ví không đủ, vui lòng nạp thêm');
  const net = Math.round(price * (1 - FEE));
  await db.batch([
    { sql: 'UPDATE users SET balance=balance-? WHERE id=?', args: [price, buyer] },
    { sql: 'UPDATE users SET balance=balance+? WHERE id=?', args: [net, seller] },
  ]);
  const buyerTxId  = await log(buyer,  'buy',  -price, note);
  const sellerTxId = await log(seller, 'sale',  net,   note);
  return { buyerTxId, sellerTxId };
};

const isActiveContractTicket = t => t && t.token_id && chain.isEnabled() &&
  (!t.contract_addr || t.contract_addr === chain.getStatus().avaTicketAddress);

// ─── Buy (Primary) & Buy OTP ──────────────────────────────────────────────────
route('post', 'buy/request-otp', 'customer', async r => {
  const res = await issueOtp(r.u, 'buy_ticket');
  return { ok: 1, ...res };
});

route('post', 'buy', 'customer', async r => {
  const code = String(r.body.code || '').trim();
  if (!code) throw E('Vui lòng nhập mã OTP để xác nhận mua vé');
  await verifyOtp(r.u.id, 'buy_ticket', code);

  const eventId = +r.body.event;
  const e = await db.get('SELECT * FROM events WHERE id=?', [eventId]);
  if (!e) throw E('Không tìm thấy sự kiện');
  if (e.remain <= 0) throw E('Sự kiện đã SOLD OUT');
  const { buyerTxId, sellerTxId } = await pay(r.u.id, e.org, e.price, e.name);
  await db.run('UPDATE events SET remain=remain-1 WHERE id=?', [eventId]);
  const ins = await db.run('INSERT INTO tickets(event,owner,orig) VALUES(?,?,?)', [eventId, r.u.id, e.price]);
  const ticketId = Number(ins.lastInsertRowid);
  const chainRes = await chain.onBuyPrimary(ticketId, r.u.wallet, e.id, e.price);
  if (chainRes) {
    const contractAddr = chain.getStatus().avaTicketAddress;
    await db.run('UPDATE tickets SET token_id=?,tx_hash=?,contract_addr=? WHERE id=?', [chainRes.tokenId, chainRes.txHash, contractAddr, ticketId]);
    await db.run('UPDATE txs SET tx_hash=? WHERE id IN (?,?)', [chainRes.txHash, buyerTxId, sellerTxId]);
  }
  return { ok: 1, ticketId, tokenId: chainRes?.tokenId || null, txHash: chainRes?.txHash || null, explorerUrl: chain.explorerUrl(chainRes?.txHash) };
});

// ─── Tickets & Market ─────────────────────────────────────────────────────────
route('get', 'tickets', 'customer', r => db.all(
  'SELECT t.*,e.name,e.date,e.venue,e.description,u.username org FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=e.org WHERE t.owner=? ORDER BY t.id DESC', [r.u.id]
));

route('get', 'tickets/:id/chain', true, async r => {
  const t = await db.get('SELECT t.*,e.name,e.org,u.wallet ownerWallet FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=t.owner WHERE t.id=?', [+r.params.id]);
  if (!t || (t.owner !== r.u.id && t.org !== r.u.id)) throw E('Không tìm thấy vé', 404);
  const onChain = isActiveContractTicket(t) ? await chain.getOnChainTicket(t.token_id) : null;
  return { ticket: t, onChain, chainStatus: chain.getStatus(), explorerUrl: chain.explorerUrl(t.tx_hash) };
});

route('post', 'list', 'customer', async r => {
  const t = await db.get('SELECT * FROM tickets WHERE id=? AND owner=?', [+r.body.ticket, r.u.id]);
  if (!t) throw E('Bạn không sở hữu vé này');
  if (t.used) throw E('Vé đã check-in, không thể bán lại');
  const max = Math.floor(t.orig * CAP), p = int(r.body.price, 1, Infinity, 'Giá không hợp lệ');
  if (p > max) throw E('Chống phe vé: giá bán tối đa là ' + max.toLocaleString('vi-VN') + 'đ (giá gốc + 10%)');
  await db.run('UPDATE tickets SET listed=? WHERE id=?', [p, t.id]);
  let chainRes = null;
  if (isActiveContractTicket(t)) {
    chainRes = await chain.onListResale(t.token_id, r.u.wallet, p);
    if (chainRes?.txHash) await log(r.u.id, 'list', 0, `Đăng bán vé #${t.id} (NFT #${t.token_id}) giá ${p.toLocaleString('vi-VN')}đ`, chainRes.txHash);
  }
  return { ok: 1, txHash: chainRes?.txHash || null, explorerUrl: chain.explorerUrl(chainRes?.txHash) };
});

route('post', 'unlist', 'customer', async r => {
  const t = await db.get('SELECT * FROM tickets WHERE id=? AND owner=?', [+r.body.ticket, r.u.id]);
  if (!t) throw E('Bạn không sở hữu vé này');
  await db.run('UPDATE tickets SET listed=NULL WHERE id=? AND owner=?', [t.id, r.u.id]);
  let chainRes = null;
  if (isActiveContractTicket(t)) chainRes = await chain.onUnlistResale(t.token_id, r.u.wallet);
  return { ok: 1, txHash: chainRes?.txHash || null };
});

route('get', 'market', 'customer', () => db.all(
  'SELECT t.id,t.owner,t.listed,t.orig,t.token_id,t.tx_hash,e.name,e.date,e.venue,e.description,u.username seller FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=t.owner WHERE t.listed IS NOT NULL AND t.used=0'
));

// ─── Buy Resale ───────────────────────────────────────────────────────────────
route('post', 'buy-resale', 'customer', async r => {
  const code = String(r.body.code || '').trim();
  if (!code) throw E('Vui lòng nhập mã OTP để xác nhận mua lại vé');
  await verifyOtp(r.u.id, 'buy_ticket', code);

  const ticketId = +r.body.ticket;
  const t = await db.get('SELECT t.*,e.name FROM tickets t JOIN events e ON e.id=t.event WHERE t.id=? AND t.listed IS NOT NULL AND t.used=0', [ticketId]);
  if (!t) throw E('Vé không còn được rao bán');
  if (t.owner === r.u.id) throw E('Không thể tự mua vé của mình');
  const { buyerTxId, sellerTxId } = await pay(r.u.id, t.owner, t.listed, t.name + ' (bán lại)');
  await db.run('UPDATE tickets SET owner=?,listed=NULL WHERE id=?', [r.u.id, ticketId]);
  let chainRes = null;
  if (isActiveContractTicket(t)) {
    chainRes = await chain.onBuyResale(t.token_id, r.u.wallet);
    if (chainRes?.txHash) {
      await db.run('UPDATE tickets SET tx_hash=? WHERE id=?', [chainRes.txHash, t.id]);
      await db.run('UPDATE txs SET tx_hash=? WHERE id IN (?,?)', [chainRes.txHash, buyerTxId, sellerTxId]);
    }
  }
  return { ok: 1, tokenId: t.token_id || null, txHash: chainRes?.txHash || null, explorerUrl: chain.explorerUrl(chainRes?.txHash) };
});

// ─── QR động (xoay mỗi 20 giây) ─────────────────────────────────────────────
const STEP = 20;
const W = () => Math.floor(Date.now() / (STEP * 1000)),
  tok = (t, w) => `AVATIX|${t.id}|${t.owner}|${w}|${sign(`${t.id}|${t.owner}|${w}`)}`;

route('get', 'qr/:id', 'customer', async r => {
  const t = await db.get('SELECT * FROM tickets WHERE id=? AND owner=?', [+r.params.id, r.u.id]);
  if (!t) throw E('Bạn không sở hữu vé này');
  if (t.used) throw E('Vé đã được sử dụng');
  const token = tok(t, W());
  const svg = await QR.toString(token, { type: 'svg', errorCorrectionLevel: 'H', margin: 2, width: 360 });
  return { svg, token, left: STEP - Math.floor((Date.now() / 1000) % STEP) };
});

// ─── Scan (Check-in) ──────────────────────────────────────────────────────────
route('post', 'scan', 'organizer', async r => {
  const p = String(r.body.token || '').trim().split('|'), [tag, id, own, w, sg] = p;
  if (tag !== 'AVATIX' || p.length !== 5 || sign(`${id}|${own}|${w}`) !== sg) throw E('Mã QR không hợp lệ');
  if (W() - Number(w) > 1 || Number(w) > W()) throw E('Mã QR đã hết hạn (ảnh chụp màn hình không có giá trị)');
  const t = await db.get('SELECT t.*,e.org,e.name FROM tickets t JOIN events e ON e.id=t.event WHERE t.id=?', [+id]);
  if (!t || t.org !== r.u.id) throw E('Vé không thuộc sự kiện của bạn');
  if (t.owner !== +own) throw E('Vé đã đổi chủ, mã cũ không còn hiệu lực');
  if (t.used) throw E('Vé đã được sử dụng trước đó');
  await db.run('UPDATE tickets SET used=1,listed=NULL WHERE id=?', [t.id]);
  let chainRes = null;
  if (isActiveContractTicket(t)) {
    const totpTs = Number(w) * STEP;
    chainRes = await chain.onScanTicket(t.token_id, totpTs);
  }
  await log(r.u.id, 'scan', 0, `Check-in vé #${t.id}: ${t.name}`, chainRes?.txHash || null);
  return { ok: 1, msg: `Check-in thành công: ${t.name} (vé #${t.id})`, tokenId: t.token_id || null, txHash: chainRes?.txHash || null, explorerUrl: chain.explorerUrl(chainRes?.txHash), chainEnabled: chain.isEnabled() };
});

// ─── Lịch sử giao dịch ───────────────────────────────────────────────────────
route('get', 'history', true, async r => {
  const rows = await db.all('SELECT * FROM txs WHERE user=? ORDER BY id DESC LIMIT 50', [r.u.id]);
  return rows.map(tx => ({ ...tx, explorerUrl: chain.explorerUrl(tx.tx_hash), snowtraceUrl: chain.explorerUrl(tx.tx_hash) }));
});

// ─── Static + Error handler ───────────────────────────────────────────────────
app.use(express.static(__dirname + '/public', { index: 'login.html' }));
app.use((e, r, s, n) => s.status(e.c || 500).json({ e: e.c ? e.message : 'Lỗi máy chủ' }));

// ─── Startup ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    await db.migrate();
    // Backfill wallet address cho user cũ chưa có
    const noWallet = await db.all('SELECT id FROM users WHERE wallet IS NULL');
    for (const u of noWallet) {
      await db.run('UPDATE users SET wallet=? WHERE id=?', [chain.getWalletAddress(u.id), u.id]);
    }
    await chain.init();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log('AVA-TIX chạy tại http://localhost:' + port));
  })();
}

module.exports = { app, db, chain };
