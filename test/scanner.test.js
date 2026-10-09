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

const cheap = { departDate: "2026-12-03", returnDate: "2026-12-06", price: 150, stopsOut: 0, stopsBack: 1, airline: "AA", link: "/search/cheap" };

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
  // Every month ahead was asked about, for both destinations.
  assert.equal(app.prices.calls.length, 14);

  const [deal] = await app.store.adminDeals();
  assert.equal(deal.destination, "LAS");
  assert.equal(deal.found_price, 150);
  assert.equal(deal.checked_price, 158);
  assert.equal(deal.normal_price, 402);
  assert.equal(deal.status, "confirmed");
  assert.match(deal.book_url, /google\.com/);
  assert.deepEqual(app.prices.checks[0], { origin: "SGF", arrival: "LAS", departDate: "2026-12-03", returnDate: "2026-12-06", domestic: true });

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
  assert.match(scans[0].summary, /1 deals confirmed/);
});

test("a price that doesn't hold up on Google Flights isn't sent", async () => {
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  app.prices.answers.LAS = { price: 390, priceLevel: "typical" };
  await activeSubscriber("fan@example.com");
  await app.scanner.run();
  const [deal] = await app.store.adminDeals();
  assert.equal(deal.status, "rejected");
  assert.match(deal.reason, /\$390 now \(a deal is \$281 or less\)/);
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

test("without a Google Flights key, deals wait unchecked (and aren't sent unless checking is turned off)", async () => {
  app.keyValues.serpapi = null;
  app.prices.fares.LAS = routeFares(400, 25, [cheap]);
  await activeSubscriber("fan@example.com");
  await app.scanner.run();
  let [deal] = await app.store.adminDeals();
  assert.equal(deal.status, "unchecked");
  assert.match(deal.reason, /No Google Flights/);
  assert.match(deal.book_url, /aviasales\.com\/search\/cheap/);
  assert.equal(app.emails.length, 0);

  // With checking off, the next (cheaper) one goes out, marked as not double-checked.
  await app.store.saveSettings({ require_check: false });
  app.prices.fares.LAS = routeFares(400, 25, [{ ...cheap, price: 140 }]);
  await app.scanner.run();
  [deal] = await app.store.adminDeals();
  assert.equal(deal.found_price, 140);
  assert.equal(app.emails.length, 1);
  assert.match(app.emails[0].text, /not double-checked/);
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
  await app.scanner.run();
  assert.equal((await app.store.adminDeals()).length, 1);
  assert.equal(app.emails.length, 1);
});

test("a refused Travelpayouts token fails the scan and says so", async () => {
  const { SourceError } = require("../lib/sources/travelpayouts");
  app.prices.fail = new SourceError("Travelpayouts refused the API token");
  await assert.rejects(app.scanner.run(), /refused/);
  const [scan] = await app.store.scans();
  assert.equal(scan.status, "failed");
  assert.match(scan.error, /refused/);
});

test("no token yet: the scan fails with a plain explanation", async () => {
  app.keyValues.travelpayouts = null;
  await assert.rejects(app.scanner.run(), /no Travelpayouts API token/);
});
