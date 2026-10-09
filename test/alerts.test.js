const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");

let app;
test.beforeEach(async () => {
  app = await startApp();
});
test.afterEach(() => app.stop());

let n = 0;
async function deal(fields = {}) {
  n += 1;
  return app.store.addDeal({
    origin: "SGF",
    destination: "LAS",
    departDate: "2026-12-03",
    returnDate: "2026-12-06",
    foundPrice: 150,
    checkedPrice: 150,
    normalPrice: 400,
    status: "confirmed",
    bookUrl: `https://g/${n}`,
    ...fields,
  });
}
async function subscriber(email, prefs = {}) {
  const { subscriber: sub } = await app.store.subscribe(email, "SGF");
  await app.store.confirm(sub.token);
  if (Object.keys(prefs).length) await app.store.savePreferences(sub.token, { instant: true, weekly: true, ...prefs });
  return sub;
}

test("deal alerts: several deals go in one email; only to people who want them right away", async () => {
  await subscriber("now@example.com");
  await subscriber("weekly-only@example.com", { instant: false });
  const { subscriber: pending } = await app.store.subscribe("pending@example.com", "SGF");
  assert.equal(pending.status, "pending");

  await app.alerts.sendInstant([await deal(), await deal({ destination: "MCO", checkedPrice: 120 })]);
  assert.equal(app.emails.length, 1);
  assert.equal(app.emails[0].to, "now@example.com");
  assert.equal(app.emails[0].subject, "2 flight deals from SGF, from $120");
  assert.ok(app.emails[0].text.indexOf("Orlando") < app.emails[0].text.indexOf("Las Vegas"), "cheapest first");
});

test("deal alerts: the same route again only if it's at least 5% cheaper", async () => {
  await subscriber("fan@example.com");
  await app.alerts.sendInstant([await deal({ checkedPrice: 150 })]);
  await app.alerts.sendInstant([await deal({ checkedPrice: 145, departDate: "2026-12-10", returnDate: "2026-12-13" })]);
  assert.equal(app.emails.length, 1, "3% cheaper isn't news");
  await app.alerts.sendInstant([await deal({ checkedPrice: 140, departDate: "2026-12-17", returnDate: "2026-12-20" })]);
  assert.equal(app.emails.length, 2);
});

test("deal alerts: at most the weekly limit of emails per person", async () => {
  await app.store.saveSettings({ max_alerts_per_week: 2 });
  await subscriber("fan@example.com");
  for (const dest of ["LAS", "MCO", "DEN"]) await app.alerts.sendInstant([await deal({ destination: dest })]);
  assert.equal(app.emails.length, 2);
});

test("weekly roundup: the week's best deal per place, to those who want it", async () => {
  await subscriber("weekly@example.com", { instant: false });
  await subscriber("none@example.com", { instant: false, weekly: false });
  await deal({ checkedPrice: 200 });
  await deal({ checkedPrice: 150 }); // further below normal: this one is shown for Las Vegas
  await deal({ destination: "CUN", checkedPrice: 300, normalPrice: 600 });
  await deal({ destination: "DEN", status: "rejected" });
  await deal({ destination: "SEA", departDate: "2026-10-01", returnDate: "2026-10-05" }); // already gone

  assert.equal(await app.alerts.sendWeekly(), 1);
  const [email] = app.emails;
  assert.equal(email.to, "weekly@example.com");
  assert.equal(email.subject, "This week's best flight deals from SGF");
  assert.match(email.text, /Las Vegas: \$150/);
  assert.doesNotMatch(email.text, /\$200/);
  assert.match(email.text, /Cancún: \$300/);
  assert.doesNotMatch(email.text, /Denver|Seattle/);
});

test("weekly roundup: nothing to say, no email", async () => {
  await subscriber("weekly@example.com");
  assert.equal(await app.alerts.sendWeekly(), 0);
  assert.equal(app.emails.length, 0);
});
