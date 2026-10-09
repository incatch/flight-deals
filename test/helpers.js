// Shared test setup: a fresh database, fake price services, captured emails
// and a running copy of the site.
//
// Needs a PostgreSQL database in DATABASE_URL (default: a local one on port
// 55432). Everything in it is wiped at the start of each test file.

const http = require("http");
const { Pool } = require("pg");
const { migrate } = require("../lib/db");
const { createStore } = require("../lib/store");
const { createAlerts } = require("../lib/alerts");
const { createScanner } = require("../lib/scanner");
const { createApp } = require("../lib/app");

const OWNER = "owner@example.com";
const SITE_URL = "https://flights.example.test";
const SECRET = "test-secret-that-is-long-enough-0123456789";
const TZ = "America/Chicago";
// "Now" in the tests: Friday 9 October 2026, 7 am in Springfield.
const NOW = new Date("2026-10-09T12:00:00Z");
const quiet = { log: () => {}, error: () => {}, warn: () => {} };

/** Fake Travelpayouts: `fares[dest]` lists the round trips for that destination (any month). */
function fakeTravelpayouts(state) {
  return () => ({
    async roundTrips({ origin, destination, month }) {
      state.calls.push({ origin, destination, month });
      if (state.fail) throw state.fail;
      return (state.fares[destination] || []).filter((f) => f.departDate.startsWith(month));
    },
  });
}

/** Fake Google Flights check: `answers[dest]` is the result (default: confirms at the scan's price). */
function fakeSerpApi(state) {
  return () => ({
    async check(args) {
      state.checks.push(args);
      const answer = state.answers[args.arrival];
      if (answer instanceof Error) throw answer;
      return {
        ok: true,
        price: null,
        priceLevel: "low",
        typicalRange: [300, 450],
        airline: "American",
        stopsText: "Out: Nonstop · Back: Nonstop",
        url: `https://www.google.com/travel/flights?test=${args.arrival}`,
        reason: null,
        searches: 2,
        ...answer,
      };
    },
  });
}

async function startApp() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/flights_test" });
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool, { log: () => {} });
  const store = createStore(pool);

  const emails = [];
  const prices = { fares: {}, calls: [], fail: null, checks: [], answers: {} };
  const keyValues = { travelpayouts: "tp-token", serpapi: "serp-key" };
  const keys = { get: async (name) => keyValues[name] || null };
  const alerts = createAlerts({ store, sendEmail: async (e) => emails.push(e), siteUrl: SITE_URL, log: quiet, pauseMs: 0 });
  const scanner = createScanner({
    store,
    keys,
    alerts,
    timeZone: TZ,
    travelpayouts: fakeTravelpayouts(prices),
    serpapi: fakeSerpApi(prices),
    log: quiet,
    pauseMs: 0,
    now: () => NOW,
  });
  const auth = { signedInUser: async (req) => (req.headers["x-test-user"] ? { email: req.headers["x-test-user"] } : null) };
  const handler = createApp({ store, alerts, scanner, auth, admins: [OWNER], secret: SECRET, siteUrl: SITE_URL, timeZone: TZ, keys, log: quiet });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    pool,
    store,
    alerts,
    scanner,
    base,
    emails,
    prices,
    keyValues,
    async stop() {
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}

/** Request helper: `form` is sent as a POST form; `user` signs in to Admin. */
async function request(base, path, { form, user, headers = {}, method } = {}) {
  const res = await fetch(base + path, {
    method: method || (form ? "POST" : "GET"),
    redirect: "manual",
    headers: {
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(user ? { "x-test-user": user } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text(), headers: res.headers };
}

/** The admin form token on a page. */
function formToken(html) {
  return html.match(/name="_token" value="([^"]+)"/)[1];
}

/** Round trips SGF → `dest`: `n` ordinary ones at `normal`, plus the given extras. */
function routeFares(normal, n, extras = []) {
  const fares = [];
  // Weeks of Thursday → Monday trips from mid-November on.
  let day = Date.UTC(2026, 10, 12);
  for (let i = 0; i < n; i++) {
    const depart = new Date(day).toISOString().slice(0, 10);
    const ret = new Date(day + 4 * 86400000).toISOString().slice(0, 10);
    fares.push({ departDate: depart, returnDate: ret, price: normal + (i % 5), stopsOut: 0, stopsBack: 0, airline: "AA", link: `/search/SGF${i}` });
    day += 7 * 86400000;
  }
  return [...fares, ...extras];
}

module.exports = { startApp, request, formToken, routeFares, OWNER, SITE_URL, NOW, TZ, quiet };
