/**
 * mailer.js — AVA-TIX Dual-mode Email / OTP Sender
 *
 * - Nếu .env có SMTP_USER & SMTP_PASS → gửi email thật qua Nodemailer (Gmail / SMTP bất kỳ).
 * - Nếu chưa cấu hình SMTP → chạy chế độ Dev/Demo: in mã OTP ra console và trả devOtp về UI để test ngay.
 */

const nodemailer = require("nodemailer");

let transporter = null;

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST || (user.endsWith("@gmail.com") ? "smtp.gmail.com" : undefined);
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return transporter;
}

const PURPOSE_META = {
  verify_email: {
    subject: "[AVA-TIX] Mã xác thực Email tài khoản",
    title: "Xác thực địa chỉ Email",
    desc: "Nhập mã OTP dưới đây để hoàn tất xác thực email cho tài khoản AVA-TIX của bạn.",
  },
  change_password: {
    subject: "[AVA-TIX] Mã xác nhận Đổi mật khẩu",
    title: "Xác nhận đổi mật khẩu",
    desc: "Bạn vừa yêu cầu đổi mật khẩu tài khoản AVA-TIX. Nhập mã OTP bên dưới để xác nhận.",
  },
  reset_password: {
    subject: "[AVA-TIX] Mã khôi phục mật khẩu",
    title: "Đặt lại mật khẩu",
    desc: "Bạn vừa yêu cầu khôi phục mật khẩu tài khoản AVA-TIX. Không chia sẻ mã này cho bất kỳ ai.",
  },
  buy_ticket: {
    subject: "[AVA-TIX] Mã OTP xác nhận mua vé",
    title: "Xác nhận thanh toán mua vé",
    desc: "Bạn đang thực hiện giao dịch mua vé trên AVA-TIX. Nhập mã OTP dưới đây để xác nhận thanh toán và nhận vé NFT.",
  },
};

/**
 * Gửi mã OTP 6 số tới email người dùng
 * @returns {Promise<{mode: 'smtp'|'dev', devOtp?: string}>}
 */
async function sendOtpEmail({ to, username, code, purpose }) {
  const meta = PURPOSE_META[purpose] || PURPOSE_META.verify_email;

  if (!isSmtpConfigured()) {
    console.log(`[Mailer][DEV-OTP] To: ${to} | User: ${username} | Purpose: ${purpose} | OTP: ${code}`);
    return { mode: "dev", devOtp: code };
  }

  const from = process.env.SMTP_FROM || `"AVA-TIX Security" <${process.env.SMTP_USER}>`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:2px solid #1d2b3a;border-radius:12px;background:#fff6e5;color:#1d2b3a">
      <h2 style="margin:0 0 8px">AVA-TIX · ${meta.title}</h2>
      <p>Xin chào <b>${username}</b>,</p>
      <p>${meta.desc}</p>
      <div style="margin:20px 0;padding:16px;text-align:center;background:#fff;border:2px solid #1d2b3a;border-radius:10px;font-size:32px;font-weight:700;letter-spacing:8px">
        ${code}
      </div>
      <p style="font-size:14px;color:#555">Mã có hiệu lực trong <b>5 phút</b>. Nếu không phải bạn thực hiện, vui lòng bỏ qua email này.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from,
    to,
    subject: meta.subject,
    text: `Xin chao ${username}, ma OTP cua ban la: ${code} (het han sau 5 phut).`,
    html,
  });

  console.log(`[Mailer][SMTP] ✅ Đã gửi OTP (${purpose}) tới ${to}`);
  return { mode: "smtp" };
}

module.exports = { sendOtpEmail, isSmtpConfigured };
