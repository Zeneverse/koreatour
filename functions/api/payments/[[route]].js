/**
 * PortOne V2 payment verification + webhook
 *
 * Routes:
 *   GET  /api/payments/config          -> public keys + channel keys for the browser SDK
 *   POST /api/payments/prepare         -> {code} -> creates a paymentId, returns amount to charge
 *   POST /api/payments/complete        -> {paymentId, code} -> verifies with PortOne, marks deposit paid
 *   POST /api/payments/webhook         -> PortOne server-to-server notification
 *
 * Cloudflare environment variables required:
 *   PORTONE_API_SECRET        (Secret)  - from PortOne console
 *   PORTONE_STORE_ID          (Plaintext)
 *   PORTONE_CHANNEL_GLOBAL    (Plaintext) - Eximbay channel key
 *   PORTONE_CHANNEL_DOMESTIC  (Plaintext) - Toss Payments channel key
 *   PORTONE_WEBHOOK_SECRET    (Secret, optional)
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const nowISO = () => new Date().toISOString();

async function getSetting(db, key, fallback) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

/* Ask PortOne what actually happened. Never trust the browser. */
async function fetchPortOnePayment(env, paymentId) {
  const r = await fetch(
    `https://api.portone.io/payments/${encodeURIComponent(paymentId)}`,
    { headers: { Authorization: `PortOne ${env.PORTONE_API_SECRET}` } }
  );
  if (!r.ok) throw new Error(`PortOne lookup failed (${r.status})`);
  return r.json();
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return true;
  } catch (e) { return false; }
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const route = "/" + (Array.isArray(params.route) ? params.route.join("/") : params.route || "");

  if (!db) return json({ error: "D1 binding 'DB' is missing" }, 500);

  try {
    /* ---------- public: what the browser SDK needs ---------- */
    if (route === "/config" && request.method === "GET") {
      const enabled = !!(env.PORTONE_STORE_ID && (env.PORTONE_CHANNEL_GLOBAL || env.PORTONE_CHANNEL_DOMESTIC));
      return json({
        enabled,
        storeId: env.PORTONE_STORE_ID || "",
        channels: {
          global: env.PORTONE_CHANNEL_GLOBAL || "",
          domestic: env.PORTONE_CHANNEL_DOMESTIC || "",
        },
      });
    }

    /* ---------- prepare: server decides the amount ---------- */
    if (route === "/prepare" && request.method === "POST") {
      const { code } = await request.json();
      if (!code) return json({ error: "code required" }, 400);

      const b = await db
        .prepare("SELECT * FROM bookings WHERE code = ?")
        .bind(String(code).toUpperCase())
        .first();
      if (!b) return json({ error: "booking not found" }, 404);
      if (b.deposit_status === "paid") return json({ error: "already paid" }, 409);
      if (b.status === "cancelled" || b.status === "declined")
        return json({ error: "booking closed" }, 409);

      const amount = b.deposit_amount || 0;
      if (amount <= 0) return json({ error: "no deposit required" }, 400);

      /* unique, traceable payment id */
      const paymentId = `zv-${b.code}-${Date.now()}`;
      await db
        .prepare("UPDATE bookings SET deposit_method = ?, updated_at = ? WHERE id = ?")
        .bind(`portone:${paymentId}`, nowISO(), b.id)
        .run();

      return json({
        paymentId,
        amount,
        currency: "KRW",
        orderName: `${b.pkg_name || "Tour"} — Deposit`,
        customer: {
          fullName: b.name || "",
          email: b.email || "",
          phoneNumber: b.contact_channel === "whatsapp" ? (b.contact_id || "") : "",
        },
      });
    }

    /* ---------- complete: verify against PortOne, then mark paid ---------- */
    if (route === "/complete" && request.method === "POST") {
      const { paymentId, code } = await request.json();
      if (!paymentId || !code) return json({ error: "paymentId and code required" }, 400);
      if (!env.PORTONE_API_SECRET) return json({ error: "PORTONE_API_SECRET not set" }, 500);

      const b = await db
        .prepare("SELECT * FROM bookings WHERE code = ?")
        .bind(String(code).toUpperCase())
        .first();
      if (!b) return json({ error: "booking not found" }, 404);

      const payment = await fetchPortOnePayment(env, paymentId);
      const paidAmount = (payment.amount && payment.amount.total) || 0;
      const status = payment.status;

      /* the two checks that actually matter */
      if (status !== "PAID")
        return json({ ok: false, status, error: "payment not completed" }, 402);
      if (paidAmount !== (b.deposit_amount || 0))
        return json({ ok: false, error: "amount mismatch", expected: b.deposit_amount, paid: paidAmount }, 400);

      await db
        .prepare(
          "UPDATE bookings SET deposit_status='paid', deposit_method=?, deposit_paid_at=?, updated_at=? WHERE id=?"
        )
        .bind(`portone:${payment.channel && payment.channel.pgProvider ? payment.channel.pgProvider : "card"}`,
              nowISO(), nowISO(), b.id)
        .run();

      await sendTelegram(
        env,
        `💳 <b>예약금 결제 완료</b>\n\n👤 ${b.name}\n📅 ${b.date} ⏰ ${b.time}\n` +
          `💰 ₩${Number(paidAmount).toLocaleString("en-US")}\n🔑 <code>${b.code}</code>`
      );

      return json({ ok: true, status, amount: paidAmount });
    }

    /* ---------- webhook: PortOne tells us server-to-server ---------- */
    if (route === "/webhook" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const paymentId = body.paymentId || (body.data && body.data.paymentId);
      if (!paymentId) return json({ ok: true });

      /* paymentId looks like zv-CODE-timestamp */
      const parts = String(paymentId).split("-");
      const code = parts.length >= 3 ? `${parts[1]}-${parts[2]}`.toUpperCase() : "";

      try {
        const payment = await fetchPortOnePayment(env, paymentId);
        if (payment.status === "PAID") {
          const b = await db
            .prepare("SELECT * FROM bookings WHERE deposit_method LIKE ? OR code = ?")
            .bind(`%${paymentId}%`, code)
            .first();
          if (b && b.deposit_status !== "paid") {
            const paid = (payment.amount && payment.amount.total) || 0;
            if (paid === (b.deposit_amount || 0)) {
              await db
                .prepare("UPDATE bookings SET deposit_status='paid', deposit_paid_at=?, updated_at=? WHERE id=?")
                .bind(nowISO(), nowISO(), b.id)
                .run();
              await sendTelegram(env, `💳 <b>예약금 입금 확인 (webhook)</b>\n\n🔑 <code>${b.code}</code>`);
            }
          }
        }
      } catch (e) { /* never fail a webhook — PortOne will retry */ }

      return json({ ok: true });
    }

    return json({ error: "not found", route }, 404);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}
