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
      const [packages, hours, dayhours, closed, blocked, zh] = await Promise.all([
        getSetting(db, "packages", null),
        getSetting(db, "hours", { open: 10, close: 21 }),
        getSetting(db, "dayhours", {}),
        getSetting(db, "closed", []),
        getSetting(db, "blocked", {}),
        getSetting(db, "zh", false),
      ]);
      return json({ packages, hours, dayhours, closed, blocked, zh });
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
      const { name, email, pkg, date, time, people, note, addons } = body || {};
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

      const code = makeCode();
      const queueAhead = live.filter(
        (b) => b.status === "pending" && overlaps(time, pk.dur_h, b.time, b.dur_h || 1)
      ).length;

      await db
        .prepare(
          `INSERT INTO bookings (code,name,email,pkg_id,pkg_name,dur_h,date,time,people,note,addons,status,seen,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`
        )
        .bind(
          code,
          String(name).slice(0, 120),
          String(email).slice(0, 160),
          pkg,
          (pk.title && pk.title.en) || pkg,
          pk.dur_h,
          date,
          time,
          parseInt(people) || 1,
          String(note || "").slice(0, 1000),
          JSON.stringify(addons || []),
          nowISO(),
          nowISO()
        )
        .run();

      return json({ ok: true, code, queueAhead });
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
      return json({ ok: true });
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
      return json({ ok: true, autoDeclined: clash.length });
    }

    /* ---------------- admin: decline with reason ---------------- */
    if (route === "/admin/decline" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id, reason } = await request.json();
      await db
        .prepare("UPDATE bookings SET status='declined', reason=?, seen=1, updated_at=? WHERE id=?")
        .bind(String(reason || "").slice(0, 500), nowISO(), id)
        .run();
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
      const keys = ["packages", "hours", "dayhours", "closed", "blocked", "zh"];
      for (const k of keys) if (body[k] !== undefined) await putSetting(db, k, body[k]);
      return json({ ok: true });
    }

    return json({ error: "not found", route }, 404);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}
