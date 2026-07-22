const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const pad = (n) => (n < 10 ? "0" : "") + n;

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
function bookableStarts(date, dur, lastStart, hours, dayhours, blocked, bookings) {
  const h = hoursFor(date, hours, dayhours);
  const blk = blocked[date] || [];
  const ranges = bookings
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

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const route = "/" + (Array.isArray(params.route) ? params.route.join("/") : params.route || "");

  if (!db) return json({ error: "D1 binding 'DB' is missing" }, 500);

  try {
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
        .prepare("SELECT pkg_id, date, time, dur_h FROM bookings WHERE date = ?")
        .bind(date)
        .all();
      const bookings = results || [];

      const sameCount = bookings.filter((b) => b.pkg_id === pkgId).length;
      if (pk.max_per_day && sameCount >= pk.max_per_day) return json({ slots: [], reason: "full" });

      const slots = bookableStarts(date, pk.dur_h, pk.last_start, hours, dayhours, blocked, bookings);
      return json({ slots });
    }

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
        .prepare("SELECT pkg_id, date, time, dur_h FROM bookings WHERE date = ?")
        .bind(date)
        .all();
      const bookings = results || [];

      const sameCount = bookings.filter((b) => b.pkg_id === pkg).length;
      if (pk.max_per_day && sameCount >= pk.max_per_day) return json({ error: "full" }, 409);

      const ok = bookableStarts(date, pk.dur_h, pk.last_start, hours, dayhours, blocked, bookings);
      if (!ok.includes(time)) return json({ error: "taken" }, 409);

      await db
        .prepare(
          "INSERT INTO bookings (name, email, pkg_id, pkg_name, dur_h, date, time, people, note, addons, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        )
        .bind(
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
          new Date().toISOString()
        )
        .run();

      return json({ ok: true });
    }

    if (route === "/admin/login" && request.method === "POST") {
      const { password } = await request.json();
      if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD not set" }, 500);
      if (password !== env.ADMIN_PASSWORD) return json({ ok: false }, 401);
      return json({ ok: true, token: env.ADMIN_PASSWORD });
    }

    if (route === "/admin/bookings" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await db
        .prepare("SELECT * FROM bookings ORDER BY date DESC, time DESC, id DESC LIMIT 500")
        .all();
      const rows = (results || []).map((r) => ({ ...r, addons: safeParse(r.addons) }));
      return json({ bookings: rows });
    }

    if (route === "/admin/bookings/del" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const { id } = await request.json();
      await db.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

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
