const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, request, formToken, OWNER, SITE_URL } = require("./helpers");

let app;
test.before(async () => {
  app = await startApp();
});
test.after(() => app.stop());

const tokenFrom = (text, kind) => text.match(new RegExp(`/${kind}/([A-Za-z0-9_-]+)`))[1];

test("home page: sign-up form with the airports, and recent deals", async () => {
  await app.store.addDeal({ origin: "SGF", destination: "MCO", departDate: "2026-12-03", returnDate: "2026-12-07", foundPrice: 129, checkedPrice: 129, normalPrice: 300, status: "confirmed", bookUrl: "https://g/1" });
  await app.store.addDeal({ origin: "SGF", destination: "DEN", departDate: "2026-12-03", returnDate: "2026-12-07", foundPrice: 99, status: "rejected" });
  const res = await request(app.base, "/");
  assert.equal(res.status, 200);
  assert.match(res.body, /<option value="SGF" selected>SGF · Springfield, MO<\/option>/);
  assert.match(res.body, /Orlando/);
  assert.match(res.body, /\$129/);
  assert.match(res.body, /57% below normal/);
  assert.doesNotMatch(res.body, /Denver/, "deals that didn't hold up aren't shown");
  assert.match(res.body, /209 Meadowlark/);
});

test("sign up → confirm → change settings → unsubscribe", async () => {
  let res = await request(app.base, "/subscribe", { form: { origin: "SGF", email: " Traveler@Example.com " } });
  assert.match(res.body, /Check your email/);
  assert.equal(app.emails.length, 1);
  const email = app.emails[0];
  assert.equal(email.to, "traveler@example.com");
  const token = tokenFrom(email.text, "confirm");
  assert.ok(email.text.includes(`${SITE_URL}/confirm/${token}`));

  // Signing up again right away doesn't send another email.
  await request(app.base, "/subscribe", { form: { origin: "SGF", email: "traveler@example.com" } });
  assert.equal(app.emails.length, 1);

  // Opening the link only shows a button (email scanners open links).
  res = await request(app.base, `/confirm/${token}`);
  assert.match(res.body, /Yes, send me deals/);
  assert.equal((await app.store.subscriberByToken(token)).status, "pending");
  res = await request(app.base, `/confirm/${token}`, { form: {} });
  assert.match(res.body, /You&#39;re in!/);
  assert.equal((await app.store.subscriberByToken(token)).status, "active");

  res = await request(app.base, `/s/${token}`, { form: { weekly: "on" } });
  assert.match(res.body, /Saved/);
  let sub = await app.store.subscriberByToken(token);
  assert.equal(sub.instant, false);
  assert.equal(sub.weekly, true);

  res = await request(app.base, `/u/${token}`);
  assert.match(res.body, /Unsubscribe\?/);
  assert.equal((await app.store.subscriberByToken(token)).status, "active", "opening the link alone doesn't unsubscribe");
  // The one-click unsubscribe email apps send.
  res = await request(app.base, `/u/${token}`, { form: { "List-Unsubscribe": "One-Click" } });
  assert.match(res.body, /won&#39;t get any more emails/);
  sub = await app.store.subscriberByToken(token);
  assert.equal(sub.status, "unsubscribed");

  // Signing up again needs confirming again.
  await app.pool.query("update subscribers set confirm_sent_at = now() - interval '1 hour' where id = $1", [sub.id]);
  await request(app.base, "/subscribe", { form: { origin: "SGF", email: "traveler@example.com" } });
  assert.equal(app.emails.length, 2);
  assert.equal((await app.store.subscriberByToken(token)).status, "pending");
});

test("sign-up problems", async () => {
  const before = app.emails.length;
  let res = await request(app.base, "/subscribe", { form: { origin: "SGF", email: "not-an-email" } });
  assert.equal(res.status, 400);
  assert.match(res.body, /valid email/);
  res = await request(app.base, "/subscribe", { form: { origin: "XXX", email: "a@example.com" } });
  assert.match(res.body, /pick an airport/);
  // Robots fill in the hidden field: they're told it worked, but nothing is sent.
  res = await request(app.base, "/subscribe", { form: { origin: "SGF", email: "bot@example.com", website: "spam" } });
  assert.match(res.body, /Check your email/);
  // Forms posted from other websites are refused.
  res = await request(app.base, "/subscribe", { form: { origin: "SGF", email: "x@example.com" }, headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.equal(app.emails.length, before);
  assert.equal((await request(app.base, "/s/not-a-real-token-at-all-123")).status, 404);
});

test("admin needs the household sign-in and an admin's email", async () => {
  assert.equal((await request(app.base, "/admin")).status, 401);
  assert.equal((await request(app.base, "/admin", { user: "someone@example.com" })).status, 403);
  const res = await request(app.base, "/admin", { user: OWNER });
  assert.equal(res.status, 200);
  assert.match(res.body, /Travelpayouts \(prices\): <span class="good">set up/);
  assert.match(res.body, /SGF · Springfield, MO<\/td><td>\d+<\/td>/);
});

test("admin forms need the page's token", async () => {
  const res = await request(app.base, "/admin/settings", { user: OWNER, form: { site_name: "Hacked" } });
  assert.equal(res.status, 403);
  assert.equal((await app.store.settings()).site_name, "Flight Deals");
});

test("admin: settings, including the mailing address", async () => {
  const page = await request(app.base, "/admin/settings", { user: OWNER });
  const _token = formToken(page.body);
  const settings = await app.store.settings();
  const form = { _token, ...settings, scan_hours: "18, 6", mailing_address: "PO Box 1, Willard, MO 65781", require_check: "on" };
  let res = await request(app.base, "/admin/settings", { user: OWNER, form });
  assert.equal(res.status, 303);
  const saved = await app.store.settings();
  assert.equal(saved.mailing_address, "PO Box 1, Willard, MO 65781");
  assert.deepEqual(saved.scan_hours, [6, 18]);
  assert.equal(saved.require_check, true);

  res = await request(app.base, "/admin/settings", { user: OWNER, form: { ...form, scan_hours: "25" } });
  assert.equal(res.status, 400);
  assert.match(res.body, /Scan times/);
  res = await request(app.base, "/admin/settings", { user: OWNER, form: { ...form, require_check: "" } });
  assert.equal((await app.store.settings()).require_check, false);
});

test("admin: add and change airports", async () => {
  const page = await request(app.base, "/admin/airports", { user: OWNER });
  const _token = formToken(page.body);
  assert.match(page.body, /JFK,LGA,EWR/);

  let res = await request(app.base, "/admin/origins", { user: OWNER, form: { _token, code: "xna", name: "Fayetteville, AR" } });
  assert.equal(res.status, 303);
  assert.equal((await app.store.origin("XNA")).name, "Fayetteville, AR");
  res = await request(app.base, "/admin/origins", { user: OWNER, form: { _token, code: "XNA", name: "Again" } });
  assert.match(res.body, /already on the list/);

  res = await request(app.base, "/admin/destinations", { user: OWNER, form: { _token, code: "ATH", name: "Athens", region: "europe", max_price: "$650" } });
  assert.equal(res.status, 303);
  let ath = await app.store.destination("ATH");
  assert.equal(ath.domestic, false);
  assert.equal(ath.max_price, 650);

  res = await request(app.base, "/admin/destinations/ATH", { user: OWNER, form: { _token, name: "Athens, Greece", region: "europe", google_codes: "ath", max_price: "", active: "on" } });
  ath = await app.store.destination("ATH");
  assert.equal(ath.name, "Athens, Greece");
  assert.equal(ath.google_codes, "ATH");
  assert.equal(ath.max_price, null);

  res = await request(app.base, "/admin/destinations/ATH", { user: OWNER, form: { _token, name: "Athens", region: "mars" } });
  assert.equal(res.status, 400);

  res = await request(app.base, "/admin/destinations/ATH/delete", { user: OWNER, form: { _token } });
  assert.equal(await app.store.destination("ATH"), null);

  // The new airport is on the sign-up form.
  assert.match((await request(app.base, "/")).body, /XNA · Fayetteville, AR/);
});

test("admin: check a route", async () => {
  const page = await request(app.base, "/admin/check", { user: OWNER });
  const _token = formToken(page.body);
  app.prices.fares.LAS = [{ departDate: "2026-11-12", returnDate: "2026-11-15", price: 189, stopsOut: 0, stopsBack: 1, airline: "AA", link: "/search/a" }];
  app.prices.answers.LAS = { price: 199 };
  const res = await request(app.base, "/admin/check", { user: OWNER, form: { _token, origin: "SGF", destination: "LAS", google: "on" } });
  assert.equal(res.status, 200);
  assert.match(res.body, /2026-11-12 → 2026-11-15/);
  assert.match(res.body, /\$189/);
  assert.match(res.body, /Google Flights for 2026-11-12 → 2026-11-15:<\/strong> \$199/);
  assert.match(res.body, /Google rates prices on this route <strong>low/);
  assert.equal(await app.store.searchesUsed("2026-10-09"), 2);
});

test("admin: deals and scan now", async () => {
  const page = await request(app.base, "/admin", { user: OWNER });
  const res = await request(app.base, "/admin/scan", { user: OWNER, form: { _token: formToken(page.body) } });
  assert.equal(res.location, "/admin?done=scan");
  await app.scanner.run();
  const deals = await request(app.base, "/admin/deals", { user: OWNER });
  assert.match(deals.body, /Orlando/);
  assert.match(deals.body, /Didn&#39;t hold up/);
});
