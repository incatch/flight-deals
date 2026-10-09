// Handles each request: the public sign-up pages, the links in emails, and
// the admin pages (behind the household sign-in).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { InputError } = require("./store");
const views = require("./views");

const STYLE = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"));
const MAX_FORM_BYTES = 16 * 1024;
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000",
};
const DONE = {
  saved: "Saved.",
  added: "Added.",
  removed: "Removed.",
  scan: "Scan started. It takes a few minutes; refresh this page to see how it went.",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function redirect(res, location) {
  res.writeHead(303, { location, ...SECURITY_HEADERS });
  res.end();
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        reject(new InputError("That's too much."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
    req.on("error", reject);
  });
}

/** The visitor's address as the load balancer saw it (it adds it last). */
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded[forwarded.length - 1] || req.socket.remoteAddress || "unknown";
}

/** At most `max` uses per key per hour. */
function createLimiter(max) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

function createApp({
  store,
  alerts,
  scanner,
  auth, // { signedInUser(req) } — the household sign-in, checked by the load balancer
  admins, // emails allowed into Admin
  secret, // signs the admin forms' tokens
  siteUrl,
  timeZone,
  keys,
  signOutUrl = null,
  log = console,
}) {
  const adminEmails = new Set(admins.map((e) => e.toLowerCase()));
  const signupLimit = createLimiter(10);
  const formToken = (email) => crypto.createHmac("sha256", secret).update(`admin-form:${email}`).digest("base64url");
  const siteOrigin = new URL(siteUrl).origin;

  async function handle(req, res) {
    const url = new URL(req.url, siteUrl);
    const p = url.pathname;
    const method = req.method;

    if (p === "/health") return send(res, 200, "ok", { "content-type": "text/plain" });
    if (p === "/static/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", ...SECURITY_HEADERS });
      return res.end(STYLE);
    }
    // Forms only ever come from our own pages (one-click unsubscribe from
    // email apps sends no Origin header).
    if (method === "POST" && req.headers.origin && req.headers.origin !== siteOrigin) {
      return send(res, 403, "This form has to be sent from the site itself.", { "content-type": "text/plain" });
    }

    if (p.startsWith("/admin")) return handleAdmin(req, res, url);

    const settings = await store.settings();
    const page = (status, html) => send(res, status, html);
    const notFound = () => page(404, views.messagePage({ settings, title: "Not found", message: "That page doesn't exist, or the link has expired." }));

    // ── Home and sign-up ─────────────────────────────────────────────────
    if (p === "/" && method === "GET") {
      const origins = await store.origins({ activeOnly: true });
      const selected = origins.find((o) => o.code === String(url.searchParams.get("from") || "").toUpperCase()) || origins[0] || null;
      const deals = selected ? await store.publicDeals(selected.code, { includeUnchecked: !settings.require_check }) : [];
      return page(200, views.homePage({ settings, origins, selected, deals }));
    }
    if (p === "/subscribe" && method === "POST") {
      const form = await readForm(req);
      const checkEmail = () =>
        page(200, views.messagePage({ settings, title: "Check your email", message: "We've sent you a link to confirm. Click it and you're all set. (Not there? Check your spam folder.)" }));
      // A filled-in hidden field means a robot; pretend it worked.
      if (form.website) return checkEmail();
      if (!signupLimit(clientIp(req))) {
        return page(429, views.messagePage({ settings, title: "Slow down", message: "Too many sign-ups from here. Please try again in an hour." }));
      }
      try {
        const { subscriber, sendConfirm } = await store.subscribe(form.email, form.origin);
        if (sendConfirm) await alerts.sendConfirmation(subscriber);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        const origins = await store.origins({ activeOnly: true });
        const selected = origins.find((o) => o.code === form.origin) || origins[0] || null;
        const deals = selected ? await store.publicDeals(selected.code, { includeUnchecked: !settings.require_check }) : [];
        return page(400, views.homePage({ settings, origins, selected, deals, error: err.message, email: form.email }));
      }
      // The same answer whether or not the address was already signed up.
      return checkEmail();
    }

    // ── Links in emails ──────────────────────────────────────────────────
    let m = p.match(/^\/confirm\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const sub = await store.subscriberByToken(m[1]);
      if (!sub) return notFound();
      // Confirming takes a click on the page, so link checkers in email
      // systems (which open links) can't confirm for someone.
      if (method === "GET") {
        if (sub.status === "active") return redirect(res, `/s/${sub.token}`);
        return page(200, views.confirmPage({ settings, sub }));
      }
      if (method === "POST") {
        await store.confirm(sub.token);
        const fresh = await store.subscriberByToken(sub.token);
        return page(200, views.preferencesPage({ settings, sub: fresh, notice: "You're in! We'll email you when we find a great price." }));
      }
    }
    m = p.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const sub = await store.subscriberByToken(m[1]);
      if (!sub || sub.status === "pending") return notFound();
      if (method === "GET") return page(200, views.preferencesPage({ settings, sub }));
      if (method === "POST") {
        const form = await readForm(req);
        const saved = await store.savePreferences(sub.token, { instant: form.instant === "on", weekly: form.weekly === "on" });
        return page(200, views.preferencesPage({ settings, sub: saved, notice: "Saved." }));
      }
    }
    m = p.match(/^\/u\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const sub = await store.subscriberByToken(m[1]);
      if (!sub) return notFound();
      if (method === "GET") {
        if (sub.status === "unsubscribed") return page(200, views.preferencesPage({ settings, sub }));
        return page(200, views.unsubscribePage({ settings, sub }));
      }
      if (method === "POST") {
        // Also the one-click unsubscribe email apps send (RFC 8058).
        await readForm(req).catch(() => ({}));
        await store.unsubscribe(sub.token);
        return page(200, views.messagePage({ settings, title: "Unsubscribed", message: `You won't get any more emails about flights from ${sub.origin}.` }));
      }
    }
    return notFound();
  }

  // ── Admin ──────────────────────────────────────────────────────────────
  async function handleAdmin(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const user = await auth.signedInUser(req);
    if (!user) return send(res, 401, "Please sign in.", { "content-type": "text/plain" });
    if (!adminEmails.has(user.email)) return send(res, 403, "This page is for the site's admins.", { "content-type": "text/plain" });

    const settings = await store.settings();
    const admin = { email: user.email, formToken: formToken(user.email), signOutUrl };
    const page = (status, html) => send(res, status, html);
    const back = (where, done) => redirect(res, `${where}${done ? `?done=${done}` : ""}`);
    const notice = DONE[url.searchParams.get("done")] || null;

    let form = {};
    if (method === "POST") {
      form = await readForm(req);
      const given = Buffer.from(String(form._token || ""));
      const expected = Buffer.from(admin.formToken);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return send(res, 403, "This form has expired. Go back, reload the page and try again.", { "content-type": "text/plain" });
      }
    }

    if (p === "/admin" && method === "GET") {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
      return page(
        200,
        views.adminHome({
          admin,
          settings,
          timeZone,
          notice,
          scans: await store.scans(15),
          counts: await store.subscriberCounts(),
          keys: { travelpayouts: Boolean(await keys.get("travelpayouts").catch(() => null)), serpapi: Boolean(await keys.get("serpapi").catch(() => null)) },
          searches: { today: await store.searchesUsed(today), month: await store.searchesThisMonth(today.slice(0, 7)) },
          scanning: scanner.running,
        }),
      );
    }
    if (p === "/admin/scan" && method === "POST") {
      scanner.run().catch((err) => log.error(`scan failed: ${err.message}`));
      return back("/admin", "scan");
    }
    if (p === "/admin/deals" && method === "GET") {
      return page(200, views.adminDeals({ admin, settings, timeZone, deals: await store.adminDeals(200) }));
    }

    // Airports
    const airportsPage = async (status, error = null) =>
      page(status, views.adminAirports({ admin, settings, error, notice, origins: await store.origins(), destinations: await store.destinations() }));
    if (p === "/admin/airports" && method === "GET") return airportsPage(200);
    try {
      if (p === "/admin/origins" && method === "POST") {
        await store.addOrigin(form);
        return back("/admin/airports", "added");
      }
      let m = p.match(/^\/admin\/origins\/([A-Z]{3})$/);
      if (m && method === "POST") {
        await store.updateOrigin(m[1], { name: form.name, active: form.active === "on" });
        return back("/admin/airports", "saved");
      }
      if (p === "/admin/destinations" && method === "POST") {
        await store.addDestination({ ...form, domestic: form.domestic === "on" });
        return back("/admin/airports", "added");
      }
      m = p.match(/^\/admin\/destinations\/([A-Z]{3})$/);
      if (m && method === "POST") {
        await store.updateDestination(m[1], { ...form, domestic: form.domestic === "on", active: form.active === "on" });
        return back("/admin/airports", "saved");
      }
      m = p.match(/^\/admin\/destinations\/([A-Z]{3})\/delete$/);
      if (m && method === "POST") {
        await store.deleteDestination(m[1]);
        return back("/admin/airports", "removed");
      }
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      return airportsPage(400, err.message);
    }

    // Check a route
    if (p === "/admin/check") {
      const origins = await store.origins();
      const destinations = await store.destinations();
      if (method === "GET") return page(200, views.adminCheck({ admin, settings, origins, destinations }));
      if (method === "POST") {
        const destination = destinations.find((d) => d.code === form.destination);
        const origin = origins.find((o) => o.code === form.origin);
        const shown = { origin: form.origin, destination: form.destination, google: form.google === "on" };
        if (!origin || !destination) return page(400, views.adminCheck({ admin, settings, origins, destinations, form: shown, error: "Pick both airports." }));
        const result = await scanner.checkRoute({ origin: origin.code, destination, withGoogle: shown.google });
        return page(200, views.adminCheck({ admin, settings, origins, destinations, form: shown, result }));
      }
    }

    // Settings
    if (p === "/admin/settings") {
      if (method === "GET") return page(200, views.adminSettings({ admin, settings, notice }));
      if (method === "POST") {
        try {
          await store.saveSettings({ ...form, require_check: form.require_check === "on" });
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return page(400, views.adminSettings({ admin, settings, values: { ...settings, ...form, require_check: form.require_check === "on" }, error: err.message }));
        }
        return back("/admin/settings", "saved");
      }
    }

    return send(res, 404, "Not found.", { "content-type": "text/plain" });
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof InputError) return send(res, 400, err.message, { "content-type": "text/plain" });
      log.error(err);
      if (!res.headersSent) send(res, 500, "Something went wrong. Please try again.", { "content-type": "text/plain" });
    }
  };
}

module.exports = { createApp, clientIp };
