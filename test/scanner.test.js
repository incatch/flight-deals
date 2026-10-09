const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, routeFares } = require("./helpers");

let app;
test.beforeEach(async () => {
  app = await startApp();
  // Only scan to Las Vegas and Cancún, to keep the tests small.
  await app.pool.query("update destinations set active = (code in ('LAS', 'CUN'))");
});
test.afterEach(() => app.stop());

const cheap = { departDate: "2026-12-03", returnDate: "2026-12-06", price: 150, stopsOut: 0, stopsBack: 0 };

async function activeSubscriber(email, origin = "SGF") {
  const { subscriber } = await app.store.subscribe(email, origin);
  await app.store.confirm(subscriber.token);
  return subscriber;
}

test("a scan records prices, finds the deal, double-checks it and emails subscribers", async () => {
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  app.prices.answers.LAS = { price: 158 };
  const sub = await activeSubscriber("fan@example.com");

  const result = await app.scanner.run();
  assert.equal(result.counts.confirmed, 1);
  // Every week from 2 weeks to 6 months out was asked about, for both destinations.
  assert.equal(app.prices.calls.length, 46);
  assert.deepEqual(app.prices.calls[0], { origin: "SGF", arrival: "CUN", domestic: false, outboundStart: "2026-10-26", outboundEnd: "2026-11-01", returnStart: "2026-10-28", returnEnd: "2026-11-04" });
  assert.equal(await app.store.searchesUsed("2026-10-09", "calendar"), 46);
  assert.equal(await app.store.searchesUsed("2026-10-09", "check"), 2);

  const [deal] = await app.store.adminDeals();
  assert.equal(deal.destination, "LAS");
  assert.equal(deal.found_price, 150);
  assert.equal(deal.checked_price, 158);
  assert.equal(deal.normal_price, 402);
  assert.equal(deal.status, "confirmed");
  assert.match(deal.book_url, /google\.com/);
  assert.deepEqual(app.prices.checks[0], { origin: "SGF", arrival: "LAS", destination: "Las Vegas", departDate: "2026-12-03", returnDate: "2026-12-06", domestic: true, maxOvernightMinutes: 180 });

  assert.equal(app.emails.length, 1);
  const email = app.emails[0];
  assert.equal(email.to, "fan@example.com");
  assert.match(email.subject, /SGF → Las Vegas: \$158 round trip/);
  assert.match(email.text, /61% below normal/);
  assert.match(email.text, /Thu, Dec 3 → Sun, Dec 6 \(3 nights\)/);
  assert.match(email.text, /209 Meadowlark, Willard, MO 65781/);
  assert.match(email.text, new RegExp(`/u/${sub.token}`));
  assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const scans = await app.store.scans();
  assert.equal(scans[0].status, "done");
  assert.match(scans[0].summary, /^46 calendar searches \(2 routes, 22 prices\): 1 deals confirmed/);
});

test("a price that doesn't hold up on Google Flights isn't sent", async () => {
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  app.prices.answers.LAS = { price: 390, priceLevel: "typical" };
  await activeSubscriber("fan@example.com");
  await app.scanner.run();
  const [deal] = await app.store.adminDeals();
  assert.equal(deal.status, "rejected");
  assert.match(deal.reason, /no basic economy it's \$390 now \(a deal is \$281 or less\)/);
  assert.equal(app.emails.length, 0);
});

test("no deals until a route has enough history, unless a price limit is set", async () => {
  app.prices.fares.LAS = routeFares(400, 5, [cheap]);
  await app.scanner.run();
  assert.equal((await app.store.adminDeals()).length, 0);

  await app.pool.query("update destinations set max_price = 160 where code = 'LAS'");
  app.prices.answers.LAS = { price: 155, priceLevel: "typical" };
  await app.scanner.run();
  const [deal] = await app.store.adminDeals();
  assert.equal(deal.status, "confirmed");
});

test("with today's double-checks used up, deals wait unchecked (and aren't sent unless checking is turned off)", async () => {
  await app.store.saveSettings({ max_checks_per_day: 0 });
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  await activeSubscriber("fan@example.com");
  await app.scanner.run();
  let [deal] = await app.store.adminDeals();
  assert.equal(deal.status, "unchecked");
  assert.match(deal.reason, /double-checks were used up/);
  assert.match(deal.book_url, /google\.com\/travel\/flights\?q=Flights%20from%20SGF%20to%20Las%20Vegas%20on%202026-12-03%20through%202026-12-06/);
  assert.equal(app.emails.length, 0);

  // With checking off, the next (cheaper) one goes out, marked as not double-checked.
  await app.store.saveSettings({ require_check: false });
  await app.pool.query("delete from scan_slots");
  app.prices.fares.LAS = routeFares(400, 25, [{ ...cheap, price: 140 }]);
  await app.scanner.run();
  [deal] = await app.store.adminDeals();
  assert.equal(deal.found_price, 140);
  assert.equal(app.emails.length, 1);
  assert.match(app.emails[0].text, /not double-checked/);
});

test("each scan does its share of the day's calendar searches, oldest route-weeks first", async () => {
  await app.store.saveSettings({ searches_per_day: 20, scan_hours: "6,18" });
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  await app.scanner.run();
  assert.equal(app.prices.calls.length, 10, "half the day's 20 per scan");
  const first = app.prices.calls.map((c) => `${c.arrival} ${c.outboundStart}`);
  await app.scanner.run();
  await app.scanner.run();
  assert.equal(app.prices.calls.length, 20, "the day's limit is kept");
  const second = app.prices.calls.slice(10).map((c) => `${c.arrival} ${c.outboundStart}`);
  assert.equal(second.filter((x) => first.includes(x)).length, 0, "the second scan does weeks the first didn't");
});

test("scanning is paused while calendar searches per day is 0", async () => {
  await app.store.saveSettings({ searches_per_day: 0 });
  const result = await app.scanner.run();
  assert.equal(result.paused, true);
  assert.equal(app.prices.calls.length, 0);
  assert.match((await app.store.scans())[0].summary, /paused/);
});

test("the daily Google Flights limit is kept", async () => {
  await app.store.saveSettings({ max_checks_per_day: 1 });
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  app.prices.fares.CUN = routeFares(600, 25, [{ ...cheap, price: 200 }]);
  app.prices.answers.LAS = { price: 150 };
  app.prices.answers.CUN = { price: 200 };
  await app.scanner.run();
  const statuses = (await app.store.adminDeals()).map((d) => d.status).sort();
  assert.deepEqual(statuses, ["confirmed", "unchecked"]);
  assert.equal(app.prices.checks.length, 1);
  // The best deal (furthest below its limit) was the one checked.
  assert.equal(app.prices.checks[0].arrival, "CUN");
});

test("the same deal isn't recorded or sent twice", async () => {
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  app.prices.answers.LAS = { price: 150 };
  await activeSubscriber("fan@example.com");
  await app.scanner.run();
  await app.pool.query("delete from scan_slots");
  await app.scanner.run();
  assert.equal((await app.store.adminDeals()).length, 1);
  assert.equal(app.emails.length, 1);
});

test("a refused SearchApi key fails the scan and says so", async () => {
  const { SourceError } = require("../lib/sources/searchapi");
  app.prices.fail = new SourceError("SearchApi refused the API key");
  await assert.rejects(app.scanner.run(), /refused/);
  const [scan] = await app.store.scans();
  assert.equal(scan.status, "failed");
  assert.match(scan.error, /refused/);
});

test("no token yet: the scan fails with a plain explanation", async () => {
  app.keyValues.searchapi = null;
  await assert.rejects(app.scanner.run(), /no SearchApi key/);
});
