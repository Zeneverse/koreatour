const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const pad = (n) => (n < 10 ? "0" : "") + n;
const nowISO = () => new Date().toISOString();

/* statuses that still occupy / queue for a slot */
const LIVE = ["pending", "confirmed"];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}

async function getSetting(db, key, fallback) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
async function putSetting(db, key, value) {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

function hoursFor(date, hours, dayhours) {
  return dayhours[date] || hours;
}

/* Slots are blocked only by CONFIRMED bookings.
   Pending ones don't block — they queue. */
function bookableStarts(date, dur, lastStart, hours, dayhours, blocked, confirmed) {
  const h = hoursFor(date, hours, dayhours);
  const blk = blocked[date] || [];
  const ranges = confirmed
    .filter((b) => b.date === date && b.time)
    .map((b) => ({ start: parseInt(b.time), end: parseInt(b.time) + (b.dur_h || 1) }));
  const cap = lastStart != null ? Math.min(lastStart, h.close - dur) : h.close - dur;
  const out = [];
  for (let t = h.open; t <= cap; t++) {
    const slot = pad(t) + ":00";
    if (blk.includes(slot)) continue;
    let clash = false;
    for (const r of ranges) if (t < r.end && t + dur > r.start) { clash = true; break; }
    if (!clash) for (let k = 0; k < dur; k++) if (blk.includes(pad(t + k) + ":00")) { clash = true; break; }
    if (!clash) out.push(slot);
  }
  return out;
}

function checkAdmin(request, env) {
  const token = request.headers.get("x-admin-token") || "";
  return token && token === env.ADMIN_PASSWORD;
}


/* ============ EMAIL (Resend) ============
   Optional. Set these in Cloudflare > Settings > Variables:
     RESEND_API_KEY  - from resend.com
     MAIL_FROM       - e.g. "Zeneverse <booking@yourdomain.com>"
     ADMIN_EMAIL     - where you want to receive alerts
   If they're not set, everything still works — emails are just skipped. */
async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }),
    });
    return r.ok;
  } catch (e) { return false; }
}
/* ============ TELEGRAM (free, unlimited) ============
   Set in Cloudflare > Settings > Variables:
     TELEGRAM_BOT_TOKEN - from @BotFather
     TELEGRAM_CHAT_ID   - your personal chat id (from @userinfobot)
   If unset, notifications are simply skipped. */
async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return r.ok;
  } catch (e) { return false; }
}
/* notify the owner on every channel that's configured */
async function notifyOwner(env, subject, htmlBody, tgText) {
  await sendMail(env, env.ADMIN_EMAIL, subject, mailShell(subject, htmlBody));
  await sendTelegram(env, tgText);
}

const mailShell = (title, body) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f4ef;padding:28px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:30px">
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c96f52">Zeneverse</div>
      <h2 style="margin:10px 0 18px;color:#1a2b2b;font-size:20px">${title}</h2>
      ${body}
      <p style="margin-top:26px;font-size:12px;color:#8a938f;line-height:1.6">
        Zeneverse is a personal beauty consulting &amp; shopping guide service.
        We do not provide medical services or arrange clinic appointments.</p>
    </div>
  </div>`;
const row2 = (k, v) => `<tr><td style="padding:6px 0;color:#6b746f;font-size:13px">${k}</td><td style="padding:6px 0;color:#1a2b2b;font-size:13px;font-weight:600">${v}</td></tr>`;

/* ============ PAYMENTS ============
   Deposit is a % of the package price. Guests pay via PayPal or bank transfer,
   then the owner marks it received. Stripe can be added later. */
const DEFAULT_PAY = {
  depositPct: 30,
  currency: "KRW",
  paypalMe: "",          // e.g. "zeneverse"  ->  paypal.me/zeneverse/120000
  paypalEmail: "",
  bank: "",              // e.g. "우리은행 1002-123-456789 홍길동"
  usdRate: 1350,         // rough KRW -> USD for PayPal links
  refund: { fullDays: 7, halfDays: 3 }
};
function payLinks(pay, wonAmount) {
  const usd = Math.max(1, Math.round(wonAmount / (pay.usdRate || 1350)));
  const links = {};
  if (pay.paypalMe) links.paypal = `https://paypal.me/${pay.paypalMe}/${usd}`;
  else if (pay.paypalEmail)
    links.paypal = `https://www.paypal.com/paypalme/${encodeURIComponent(pay.paypalEmail)}`;
  links.usd = usd;
  links.bank = pay.bank || "";
  return links;
}
function depositFor(pay, pk, people) {
  const price = (pk.pricing && (pk.pricing.launch || pk.pricing.regular)) || 0;
  const total = price; // per booking, not per person
  const dep = Math.round((total * (pay.depositPct || 30)) / 100 / 1000) * 1000;
  return { total, deposit: dep };
}

/* ---- waitlist: tell everyone waiting that a spot opened ---- */
async function notifyWaitlist(env, db, date, reasonLabel) {
  try {
    const { results } = await db
      .prepare("SELECT * FROM waitlist WHERE date = ? AND notified = 0")
      .bind(date).all();
    const rows = results || [];
    if (!rows.length) return 0;
    const site = env.SITE_URL || "";
    for (const w of rows) {
      await sendMail(env, w.email, `Zeneverse — a spot opened on ${date}`,
        mailShell("A spot just opened up", `
          <p style="color:#3c4a48;font-size:14px;line-height:1.7">
            Good news — a spot has opened on <b>${date}</b>, the date you asked to be notified about.</p>
          <p style="color:#3c4a48;font-size:14px;line-height:1.7">
            Spots are limited and go quickly, so book as soon as you can.</p>
          ${site ? `<p style="margin-top:16px"><a href="${site}" style="display:inline-block;background:#c96f52;color:#fff;text-decoration:none;padding:12px 24px;border-radius:30px;font-weight:600">Book this date →</a></p>` : ""}`));
    }
    await db.prepare("UPDATE waitlist SET notified = 1 WHERE date = ? AND notified = 0").bind(date).run();
    await sendTelegram(env, `📢 <b>대기자 알림 발송</b>\n\n📅 ${date}\n👥 ${rows.length}명에게 자리 알림을 보냈어요\n(${reasonLabel})`);
    return rows.length;
  } catch (e) { return 0; }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function audit(db, entity, entityId, action, actor, before, after) {
  try {
    await db
      .prepare("INSERT INTO audit_log (entity,entity_id,action,actor,before_data,after_data,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(entity, entityId, action, actor, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, nowISO())
      .run();
  } catch (e) { /* audit table may not exist yet */ }
}

function safeParseObj(s) {
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}
function overlaps(aStart, aDur, bStart, bDur) {
  const a = parseInt(aStart), b = parseInt(bStart);
  return a < b + bDur && a + aDur > b;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const route = "/" + (Array.isArray(params.route) ? params.route.join("/") : params.route || "");

  if (!db) return json({ error: "D1 binding 'DB' is missing" }, 500);

  try {
    /* ---------------- public: config ---------------- */
    if (route === "/config" && request.method === "GET") {
      const [packages, hours, dayhours, closed, blocked, zh, feats, host, contact, faq, media, privacy, terms, igPosts, copy, nav, langs, pay] = await Promise.all([
        getSetting(db, "packages", null),
        getSetting(db, "hours", { open: 10, close: 21 }),
        getSetting(db, "dayhours", {}),
        getSetting(db, "closed", []),
        getSetting(db, "blocked", {}),
        getSetting(db, "zh", false),
        getSetting(db, "feats", null),
        getSetting(db, "host", null),
        getSetting(db, "contact", null),
        getSetting(db, "faq", null),
        getSetting(db, "media", null),
        getSetting(db, "privacy", null),
        getSetting(db, "terms", null),
        getSetting(db, "igPosts", []),
        getSetting(db, "copy", null),
        getSetting(db, "nav", null),
        getSetting(db, "langs", null),
        getSetting(db, "pay", null),
      ]);
      let reviews = [];
      try {
        const { results } = await db
          .prepare("SELECT id,name,rating,text,created_at FROM reviews WHERE hidden=0 ORDER BY id DESC LIMIT 60")
          .all();
        reviews = results || [];
      } catch (e) { /* reviews table may not exist yet */ }
      return json({ packages, hours, dayhours, closed, blocked, zh, feats, host, contact, faq, media, privacy, terms, igPosts, copy, nav, langs, reviews,
        pay: { depositPct: (pay && pay.depositPct) || DEFAULT_PAY.depositPct,
               refund: (pay && pay.refund) || DEFAULT_PAY.refund } });
    }

    /* ---------------- public: slots (+ queue counts) ---------------- */
    if (route === "/slots" && request.method === "GET") {
      const date = url.searchParams.get("date");
      const pkgId = url.searchParams.get("pkg");
      if (!date || !pkgId) return json({ error: "date and pkg required" }, 400);

      const [packages, hours, dayhours, closed, blocked] = await Promise.all([
        getSetting(db, "packages", []),
        getSetting(db, "hours", { open: 10, close: 21 }),
        getSetting(db, "dayhours", {}),
        getSetting(db, "closed", []),
        getSetting(db, "blocked", {}),
      ]);
      if (closed.includes(date)) return json({ slots: [], reason: "closed" });

      const pk = (packages || []).find((p) => p.id === pkgId);
      if (!pk) return json({ error: "unknown package" }, 400);

      const { results } = await db
        .prepare("SELECT pkg_id, date, time, dur_h, status FROM bookings WHERE date = ? AND status IN ('pending','confirmed')")
        .bind(date)
        .all();
      const live = results || [];
      const confirmed = live.filter((b) => b.status === "confirmed");

      const confirmedSame = confirmed.filter((b) => b.pkg_id === pkgId).length;
      if (pk.max_per_day && confirmedSame >= pk.max_per_day) return json({ slots: [], reason: "full" });

      const slots = bookableStarts(date, pk.dur_h, pk.last_start, hours, dayhours, blocked, confirmed);

      /* how many pending requests already overlap each candidate slot */
      const queue = {};
      for (const s of slots) {
        queue[s] = live.filter(
          (b) => b.status === "pending" && overlaps(s, pk.dur_h, b.time, b.dur_h || 1)
        ).length;
      }
      return json({ slots, queue });
    }

    /* ---------------- public: create request ---------------- */
    if (route === "/book" && request.method === "POST") {
      const body = await request.json();
      const { name, email, pkg, date, time, people, note, addons, contact, needs } = body || {};
      if (!name || !email || !pkg || !date || !time) return json({ error: "missing fields" }, 400);

      const [packages, hours, dayhours, closed, blocked] = await Promise.all([
        getSetting(db, "packages", []),
        getSetting(db, "hours", { open: 10, close: 21 }),
        getSetting(db, "dayhours", {}),
        getSetting(db, "closed", []),
        getSetting(db, "blocked", {}),
      ]);
      if (closed.includes(date)) return json({ error: "closed" }, 409);

      const pk = (packages || []).find((p) => p.id === pkg);
      if (!pk) return json({ error: "unknown package" }, 400);

      const { results } = await db
        .prepare("SELECT pkg_id, date, time, dur_h, status FROM bookings WHERE date = ? AND status IN ('pending','confirmed')")
        .bind(date)
        .all();
      const live = results || [];
      const confirmed = live.filter((b) => b.status === "confirmed");

      const confirmedSame = confirmed.filter((b) => b.pkg_id === pkg).length;
      if (pk.max_per_day && confirmedSame >= pk.max_per_day) return json({ error: "full" }, 409);

      const ok = bookableStarts(date, pk.dur_h, pk.last_start, hours, dayhours, blocked, confirmed);
      if (!ok.includes(time)) return json({ error: "taken" }, 409);

      const pay = (await getSetting(db, "pay", null)) || DEFAULT_PAY;
      const amounts = depositFor(pay, pk, parseInt(people) || 1);
      const code = makeCode();
      const queueAhead = live.filter(
        (b) => b.status === "pending" && overlaps(time, pk.dur_h, b.time, b.dur_h || 1)
      ).length;

      await db
        .prepare(
          `INSERT INTO bookings (code,name,email,contact,needs,pkg_id,pkg_name,dur_h,date,time,people,note,addons,status,seen,created_at,updated_at,deposit_amount,total_amount)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)`
        )
        .bind(
          code,
          String(name).slice(0, 120),
          String(email).slice(0, 160),
          String(contact || "").slice(0, 160),
          JSON.stringify(needs || []),
          pkg,
          (pk.title && pk.title.en) || pkg,
          pk.dur_h,
          date,
          time,
          parseInt(people) || 1,
          String(note || "").slice(0, 1000),
          JSON.stringify(addons || []),
          nowISO(),
          nowISO(),
          amounts.deposit,
          amounts.total
        )
        .run();

      /* notify — never block the booking if email fails */
      const addonTxt = (addons || []).map((a) => a.name).join(", ");
      const needTxt = (needs || []).join(", ");
      const guestBody = `
        <p style="color:#3c4a48;font-size:14px;line-height:1.7">Thank you — I've received your request.
        I'll review it and confirm by email shortly.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          ${row2("Booking code", code)}
          ${row2("Package", (pk.title && pk.title.en) || pkg)}
          ${row2("Date", date)}
          ${row2("Time (KST)", time)}
          ${row2("Guests", String(parseInt(people) || 1))}
          ${addonTxt ? row2("Add-ons", addonTxt) : ""}
        </table>
        <p style="margin-top:18px;font-size:13px;color:#6b746f">
          Keep your booking code — you can check, change or cancel your booking with it on the site.</p>`;
      await sendMail(env, email, `Zeneverse — request received (${code})`, mailShell("Request received", guestBody));

      const adminBody = `
        <table style="width:100%;border-collapse:collapse">
          ${row2("Name", String(name))}
          ${row2("Email", String(email))}
          ${row2("Messenger", String(contact || "-"))}
          ${row2("Package", (pk.title && pk.title.en) || pkg)}
          ${row2("Date / Time", `${date} ${time}`)}
          ${row2("Guests", String(parseInt(people) || 1))}
          ${needTxt ? row2("Interests", needTxt) : ""}
          ${addonTxt ? row2("Add-ons", addonTxt) : ""}
          ${note ? row2("Note", String(note)) : ""}
          ${row2("Code", code)}
        </table>`;
      const endT = String(parseInt(time) + (pk.dur_h || 1)).padStart(2, "0") + ":00";
      const tgNew =
        `🔔 <b>새 예약 신청</b>\n\n` +
        `👤 ${name}\n` +
        `📦 ${(pk.title && pk.title.en) || pkg}\n` +
        `📅 ${date}  ⏰ ${time}–${endT}\n` +
        `👥 ${parseInt(people) || 1}명\n` +
        `💬 ${contact || "-"}\n` +
        `📧 ${email}\n` +
        (needTxt ? `🎯 ${needTxt}\n` : "") +
        (addonTxt ? `➕ ${addonTxt}\n` : "") +
        (note ? `📝 ${note}\n` : "") +
        (queueAhead ? `\n⚠️ 같은 시간 대기 ${queueAhead}명\n` : "") +
        `\n🔑 <code>${code}</code>\n` +
        `➡️ 사이트에서 승인/거절하세요`;
      await notifyOwner(env, `New booking request — ${name} (${date} ${time})`, adminBody, tgNew);

      return json({ ok: true, code, queueAhead, deposit: amounts.deposit, total: amounts.total });
    }

    /* ---------------- public: look up my booking ---------------- */
    if (route === "/lookup" && request.method === "GET") {
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return json({ error: "code required" }, 400);
      const row = await db.prepare("SELECT * FROM bookings WHERE code = ?").bind(code).first();
      if (!row) return json({ error: "not found" }, 404);

      let queueAhead = 0;
      if (row.status === "pending") {
        const { results } = await db
          .prepare("SELECT time,dur_h,created_at FROM bookings WHERE date = ? AND status = 'pending' AND created_at < ?")
          .bind(row.date, row.created_at)
          .all();
        queueAhead = (results || []).filter((b) => overlaps(row.time, row.dur_h || 1, b.time, b.dur_h || 1)).length;
      }
      return json({
        booking: {
          code: row.code, name: row.name, pkg_name: row.pkg_name, date: row.date, time: row.time,
          dur_h: row.dur_h, people: row.people, status: row.status, reason: row.reason,
          change_req: row.change_req, addons: safeParse(row.addons),
        },
        queueAhead,
      });
    }

    /* ---------------- public: guest cancels ---------------- */
    if (route === "/cancel" && request.method === "POST") {
      const { code, reason } = await request.json();
      if (!code) return json({ error: "code required" }, 400);
      const row = await db.prepare("SELECT * FROM bookings WHERE code = ?").bind(String(code).toUpperCase()).first();
      if (!row) return json({ error: "not found" }, 404);
      if (row.status === "cancelled" || row.status === "declined") return json({ error: "already closed" }, 409);

      await db
        .prepare("UPDATE bookings SET status='cancelled', reason=?, seen=0, updated_at=? WHERE code=?")
        .bind(String(reason || "").slice(0, 500), nowISO(), row.code)
        .run();
      if (row.status === "confirmed") await notifyWaitlist(env, db, row.date, "취소로 자리 발생");
      await notifyOwner(env, `Booking cancelled — ${row.name} (${row.date} ${row.time})`,
        `<table style="width:100%;border-collapse:collapse">
            ${row2("Name", row.name)}${row2("Date / Time", row.date + " " + row.time)}
            ${row2("Code", row.code)}${reason ? row2("Reason", String(reason)) : ""}
          </table>`,
        `❌ <b>예약 취소</b>\n\n👤 ${row.name}\n📅 ${row.date} ⏰ ${row.time}\n` +
        (reason ? `💬 ${reason}\n` : "") + `\n🔑 <code>${row.code}</code>\n\n✅ 해당 시간이 다시 열렸어요`);
      return json({ ok: true });
    }

    /* ---------------- public: guest requests a change ---------------- */
    if (route === "/change" && request.method === "POST") {
      const { code, newDate, newTime, message } = await request.json();
      if (!code) return json({ error: "code required" }, 400);
      const row = await db.prepare("SELECT * FROM bookings WHERE code = ?").bind(String(code).toUpperCase()).first();
      if (!row) return json({ error: "not found" }, 404);
      if (row.status === "cancelled" || row.status === "declined") return json({ error: "already closed" }, 409);

      const req = JSON.stringify({ newDate: newDate || "", newTime: newTime || "", message: String(message || "").slice(0, 500) });
      await db
        .prepare("UPDATE bookings SET change_req=?, seen=0, updated_at=? WHERE code=?")
        .bind(req, nowISO(), row.code)
        .run();
      await notifyOwner(env, `Change requested — ${row.name} (${row.code})`,
        `<table style="width:100%;border-collapse:collapse">
            ${row2("Name", row.name)}${row2("Current", row.date + " " + row.time)}
            ${row2("Requested", (newDate || "-") + " " + (newTime || ""))}
            ${message ? row2("Message", String(message)) : ""}
          </table>`,
        `🔄 <b>시간 변경 요청</b>\n\n👤 ${row.name}\n` +
        `현재: ${row.date} ${row.time}\n` +
        `희망: ${newDate || "-"} ${newTime || ""}\n` +
        (message ? `💬 ${message}\n` : "") + `\n🔑 <code>${row.code}</code>`);
      return json({ ok: true });
    }

    /* ---------------- public: join the waitlist ---------------- */
    if (route === "/waitlist" && request.method === "POST") {
      const { name, email, contact, date, pkg } = await request.json();
      if (!email || !date) return json({ error: "missing fields" }, 400);
      const dup = await db.prepare("SELECT id FROM waitlist WHERE email = ? AND date = ? AND notified = 0")
        .bind(String(email), date).first();
      if (dup) return json({ ok: true, already: true });
      await db.prepare("INSERT INTO waitlist (name,email,contact,pkg_id,date,notified,created_at) VALUES (?,?,?,?,?,0,?)")
        .bind(String(name || "").slice(0, 120), String(email).slice(0, 160),
              String(contact || "").slice(0, 160), String(pkg || ""), date, nowISO()).run();
      await sendTelegram(env, `👀 <b>자리 알림 신청</b>\n\n📅 ${date}\n👤 ${name || "-"}\n📧 ${email}`);
      return json({ ok: true });
    }

    /* ---------------- admin: waitlist list ---------------- */
    if (route === "/admin/waitlist" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db.prepare("SELECT * FROM waitlist ORDER BY date ASC, id DESC LIMIT 300").all();
      return json({ waitlist: results || [] });
    }
    if (route === "/admin/waitlist/del" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      await db.prepare("DELETE FROM waitlist WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    /* manually push the alert for a date */
    if (route === "/admin/waitlist/notify" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { date } = await request.json();
      const n = await notifyWaitlist(env, db, date, "manual");
      return json({ ok: true, notified: n });
    }

    /* ---------------- admin: login ---------------- */
    if (route === "/admin/login" && request.method === "POST") {
      const { password } = await request.json();
      if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD not set" }, 500);
      if (password !== env.ADMIN_PASSWORD) return json({ ok: false }, 401);
      return json({ ok: true, token: env.ADMIN_PASSWORD });
    }

    /* ---------------- admin: list ---------------- */
    if (route === "/admin/bookings" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db
        .prepare("SELECT * FROM bookings ORDER BY (status='pending') DESC, date ASC, time ASC, id DESC LIMIT 500")
        .all();
      const rows = (results || []).map((r) => ({
        ...r,
        addons: safeParse(r.addons),
        change_req: r.change_req ? safeParse(r.change_req) : null,
      }));
      const newCount = rows.filter((r) => !r.seen).length;
      return json({ bookings: rows, newCount });
    }

    /* ---------------- admin: approve (auto-decline the queue) ---------------- */
    if (route === "/admin/approve" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      const row = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "not found" }, 404);

      await db
        .prepare("UPDATE bookings SET status='confirmed', reason=NULL, seen=1, updated_at=? WHERE id=?")
        .bind(nowISO(), id)
        .run();

      /* auto-decline other pending requests that overlap this one */
      const { results } = await db
        .prepare("SELECT id,time,dur_h FROM bookings WHERE date=? AND status='pending' AND id<>?")
        .bind(row.date, id)
        .all();
      const clash = (results || []).filter((b) => overlaps(row.time, row.dur_h || 1, b.time, b.dur_h || 1));
      for (const c of clash) {
        await db
          .prepare("UPDATE bookings SET status='declined', reason=?, seen=1, updated_at=? WHERE id=?")
          .bind("AUTO_TAKEN", nowISO(), c.id)
          .run();
      }
      const payCfg = (await getSetting(db, "pay", null)) || DEFAULT_PAY;
      const L = payLinks(payCfg, row.deposit_amount || 0);
      const won = (n) => "₩" + Number(n || 0).toLocaleString("en-US");
      const payBlock = (row.deposit_amount > 0 && row.deposit_status !== "paid") ? `
          <div style="background:#f6f4ef;border-radius:12px;padding:16px;margin-top:16px">
            <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#c96f52;margin-bottom:8px">Deposit to secure your spot</div>
            <div style="font-size:22px;font-weight:700;color:#1a2b2b">${won(row.deposit_amount)} <span style="font-size:13px;font-weight:400;color:#6b746f">≈ $${L.usd} · ${payCfg.depositPct}% of ${won(row.total_amount)}</span></div>
            ${L.paypal ? `<p style="margin-top:12px"><a href="${L.paypal}" style="display:inline-block;background:#c96f52;color:#fff;text-decoration:none;padding:11px 22px;border-radius:30px;font-weight:600">Pay deposit with PayPal →</a></p>` : ""}
            ${L.bank ? `<p style="margin-top:10px;font-size:13px;color:#3c4a48"><b>Bank transfer:</b><br>${L.bank}</p>` : ""}
            <p style="margin-top:10px;font-size:12px;color:#6b746f">The balance is paid on the day. Your spot is held once the deposit arrives.</p>
          </div>` : "";
      await sendMail(env, row.email, `Zeneverse — booking confirmed (${row.code})`,
        mailShell("Your booking is confirmed", `
          <table style="width:100%;border-collapse:collapse">
            ${row2("Package", row.pkg_name || row.pkg_id)}
            ${row2("Date", row.date)}
            ${row2("Time (KST)", row.time)}
            ${row2("Code", row.code)}
          </table>
          ${payBlock}
          <p style="margin-top:16px;font-size:13px;color:#6b746f">See you in Seoul! Reply to this email if anything changes.</p>`));
      for (const c of clash) {
        const cr = await db.prepare("SELECT email, code FROM bookings WHERE id=?").bind(c.id).first();
        if (cr) await sendMail(env, cr.email, `Zeneverse — that time was taken (${cr.code})`,
          mailShell("That time is no longer available", `
            <p style="color:#3c4a48;font-size:14px;line-height:1.7">Another guest was confirmed for the time you requested.
            I'm sorry to miss you — please pick another time on the site and I'll do my best to make it work.</p>`));
      }
      return json({ ok: true, autoDeclined: clash.length });
    }

    /* ---------------- admin: mark deposit paid / unpaid ---------------- */
    if (route === "/admin/deposit" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id, status, method } = await request.json();
      const st = status === "paid" ? "paid" : status === "refunded" ? "refunded" : "unpaid";
      await db.prepare("UPDATE bookings SET deposit_status=?, deposit_method=?, deposit_paid_at=?, updated_at=? WHERE id=?")
        .bind(st, String(method || ""), st === "paid" ? nowISO() : null, nowISO(), id).run();
      const b = await db.prepare("SELECT email, code, name, deposit_amount FROM bookings WHERE id=?").bind(id).first();
      if (b && st === "paid") {
        await sendMail(env, b.email, `Zeneverse — deposit received (${b.code})`,
          mailShell("Deposit received", `<p style="color:#3c4a48;font-size:14px;line-height:1.7">Thank you! Your deposit is confirmed and your spot is secured. See you in Seoul.</p>`));
      }
      return json({ ok: true });
    }

    /* ---------------- admin: decline with reason ---------------- */
    if (route === "/admin/decline" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id, reason } = await request.json();
      const dr = await db.prepare("SELECT email, code FROM bookings WHERE id=?").bind(id).first();
      await db
        .prepare("UPDATE bookings SET status='declined', reason=?, seen=1, updated_at=? WHERE id=?")
        .bind(String(reason || "").slice(0, 500), nowISO(), id)
        .run();
      if (dr) await sendMail(env, dr.email, `Zeneverse — about your request (${dr.code})`,
        mailShell("About your booking request", `
          <p style="color:#3c4a48;font-size:14px;line-height:1.7">Unfortunately I can't take this booking.</p>
          ${reason ? `<p style="background:#f6f4ef;border-radius:10px;padding:12px;font-size:13px;color:#3c4a48"><b>Reason:</b> ${String(reason)}</p>` : ""}
          <p style="font-size:13px;color:#6b746f">You're very welcome to request another date on the site.</p>`));
      return json({ ok: true });
    }

    /* ---------------- admin: reschedule (accept a change request) ---------------- */
    if (route === "/admin/reschedule" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id, date, time } = await request.json();
      if (!date || !time) return json({ error: "date and time required" }, 400);
      await db
        .prepare("UPDATE bookings SET date=?, time=?, change_req=NULL, seen=1, updated_at=? WHERE id=?")
        .bind(date, time, nowISO(), id)
        .run();
      return json({ ok: true });
    }

    /* ---------------- admin: mark seen ---------------- */
    if (route === "/admin/seen" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      if (id) await db.prepare("UPDATE bookings SET seen=1 WHERE id=?").bind(id).run();
      else await db.prepare("UPDATE bookings SET seen=1").run();
      return json({ ok: true });
    }

    /* ---------------- admin: delete ---------------- */
    if (route === "/admin/bookings/del" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      await db.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    /* ---------------- admin: save settings ---------------- */
    if (route === "/admin/save" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const body = await request.json();
      const keys = ["packages", "hours", "dayhours", "closed", "blocked", "zh", "feats", "host", "contact", "faq", "media", "privacy", "terms", "igPosts", "copy", "nav", "langs", "pay"];

      /* keep a snapshot of the current state before overwriting it */
      const label = body.__label || "";
      try {
        const before = {};
        for (const k of keys) before[k] = await getSetting(db, k, null);
        const hasAny = Object.values(before).some((v) => v !== null);
        if (hasAny) {
          await db
            .prepare("INSERT INTO snapshots (label, data, created_at) VALUES (?,?,?)")
            .bind(String(label).slice(0, 80), JSON.stringify(before), nowISO())
            .run();
          /* keep only the newest 20 */
          await db.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 20)").run();
        }
      } catch (e) { /* snapshots table may not exist yet */ }

      for (const k of keys) if (body[k] !== undefined) await putSetting(db, k, body[k]);
      return json({ ok: true });
    }

    /* ---------------- admin: test notifications ---------------- */
    if (route === "/admin/test-notify" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const tg = await sendTelegram(env, "✅ <b>Zeneverse 연결 성공</b>\n\n이제 예약 알림이 여기로 옵니다.");
      const mail = await sendMail(env, env.ADMIN_EMAIL, "Zeneverse — test notification",
        mailShell("Test notification", "<p>If you can read this, email alerts are working.</p>"));
      return json({ telegram: tg, email: mail,
        telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        emailConfigured: !!(env.RESEND_API_KEY && env.MAIL_FROM && env.ADMIN_EMAIL) });
    }

    /* ---------------- admin: snapshot list ---------------- */
    if (route === "/admin/snapshots" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db
        .prepare("SELECT id, label, created_at, length(data) AS size FROM snapshots ORDER BY id DESC LIMIT 20")
        .all();
      return json({ snapshots: results || [] });
    }

    /* ---------------- admin: restore a snapshot ---------------- */
    if (route === "/admin/restore" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      const snap = await db.prepare("SELECT * FROM snapshots WHERE id = ?").bind(id).first();
      if (!snap) return json({ error: "not found" }, 404);
      const data = safeParseObj(snap.data);
      const keys = ["packages", "hours", "dayhours", "closed", "blocked", "zh", "feats", "host", "contact", "faq", "media", "privacy", "terms", "igPosts", "copy", "nav", "langs", "pay"];

      /* snapshot the current state too, so a restore is itself undoable */
      try {
        const before = {};
        for (const k of keys) before[k] = await getSetting(db, k, null);
        await db.prepare("INSERT INTO snapshots (label, data, created_at) VALUES (?,?,?)")
          .bind("before restore", JSON.stringify(before), nowISO()).run();
      } catch (e) {}

      for (const k of keys) if (data[k] !== undefined && data[k] !== null) await putSetting(db, k, data[k]);
      await audit(db, "settings", id, "restore", "admin", null, { restoredFrom: snap.created_at });
      return json({ ok: true });
    }

    /* ---------------- admin: reset one section to defaults ---------------- */
    if (route === "/admin/reset" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { key } = await request.json();
      const allowed = ["packages", "copy", "faq", "host", "contact", "nav", "media", "feats", "langs", "privacy", "terms"];
      if (!allowed.includes(key)) return json({ error: "not allowed" }, 400);
      try {
        const before = {};
        for (const k of allowed) before[k] = await getSetting(db, k, null);
        await db.prepare("INSERT INTO snapshots (label, data, created_at) VALUES (?,?,?)")
          .bind("before reset: " + key, JSON.stringify(before), nowISO()).run();
      } catch (e) {}
      await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
      await audit(db, "settings", 0, "reset", "admin", { key }, null);
      return json({ ok: true });
    }

    /* ---------------- public: post a review ---------------- */
    if (route === "/review" && request.method === "POST") {
      const { name, text, rating, password } = await request.json();
      if (!name || !text || !password) return json({ error: "missing fields" }, 400);
      const pwHash = await sha256(password);
      await db
        .prepare("INSERT INTO reviews (name,rating,text,pw_hash,hidden,created_at,updated_at) VALUES (?,?,?,?,0,?,?)")
        .bind(String(name).slice(0, 80), Math.min(5, Math.max(1, parseInt(rating) || 5)),
              String(text).slice(0, 2000), pwHash, nowISO(), nowISO())
        .run();
      const row = await db.prepare("SELECT last_insert_rowid() AS id").first();
      await audit(db, "review", row.id, "create", "guest", null, { name, rating, text });
      await sendTelegram(env, `⭐ <b>새 후기</b>\n\n👤 ${name}\n${"★".repeat(Math.min(5, Math.max(1, parseInt(rating) || 5)))}\n\n${String(text).slice(0, 300)}`);
      return json({ ok: true });
    }

    /* ---------------- public: edit / delete own review ---------------- */
    if (route === "/review/edit" && request.method === "POST") {
      const { id, password, text, rating } = await request.json();
      const row = await db.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "not found" }, 404);
      if (row.pw_hash !== (await sha256(password))) return json({ error: "bad password" }, 401);
      const before = { text: row.text, rating: row.rating };
      await db.prepare("UPDATE reviews SET text=?, rating=?, updated_at=? WHERE id=?")
        .bind(String(text).slice(0, 2000), Math.min(5, Math.max(1, parseInt(rating) || row.rating)), nowISO(), id).run();
      await audit(db, "review", id, "edit", "guest", before, { text, rating });
      return json({ ok: true });
    }
    if (route === "/review/delete" && request.method === "POST") {
      const { id, password } = await request.json();
      const row = await db.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "not found" }, 404);
      if (row.pw_hash !== (await sha256(password))) return json({ error: "bad password" }, 401);
      await audit(db, "review", id, "delete", "guest", { name: row.name, text: row.text, rating: row.rating }, null);
      await db.prepare("DELETE FROM reviews WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    /* ---------------- admin: reviews ---------------- */
    if (route === "/admin/reviews" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db.prepare("SELECT id,name,rating,text,hidden,created_at,updated_at FROM reviews ORDER BY id DESC LIMIT 300").all();
      return json({ reviews: results || [] });
    }
    if (route === "/admin/review/hide" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id, hidden } = await request.json();
      const row = await db.prepare("SELECT hidden FROM reviews WHERE id=?").bind(id).first();
      await db.prepare("UPDATE reviews SET hidden=?, updated_at=? WHERE id=?").bind(hidden ? 1 : 0, nowISO(), id).run();
      await audit(db, "review", id, hidden ? "hide" : "show", "admin", { hidden: row ? row.hidden : null }, { hidden: hidden ? 1 : 0 });
      return json({ ok: true });
    }
    if (route === "/admin/review/del" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      const row = await db.prepare("SELECT * FROM reviews WHERE id=?").bind(id).first();
      if (row) await audit(db, "review", id, "delete", "admin", { name: row.name, text: row.text, rating: row.rating }, null);
      await db.prepare("DELETE FROM reviews WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
    if (route === "/admin/audit" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all();
      return json({ log: (results || []).map((r) => ({ ...r, before_data: safeParse(r.before_data), after_data: safeParse(r.after_data) })) });
    }

    return json({ error: "not found", route }, 404);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}
