const test = require("node:test");
const assert = require("node:assert/strict");
const deals = require("../lib/deals");

test("trip shapes: weekends and 4–7 night trips", () => {
  assert.equal(deals.tripShape("2026-11-12", "2026-11-15"), "weekend"); // Thu → Sun
  assert.equal(deals.tripShape("2026-11-13", "2026-11-16"), "weekend"); // Fri → Mon
  assert.equal(deals.tripShape("2026-11-12", "2026-11-16"), "weekend"); // Thu → Mon (4 nights)
  assert.equal(deals.tripShape("2026-11-10", "2026-11-14"), "week"); // Tue → Sat, 4 nights
  assert.equal(deals.tripShape("2026-11-10", "2026-11-17"), "week"); // 7 nights
  assert.equal(deals.tripShape("2026-11-10", "2026-11-12"), null); // 2 nights midweek
  assert.equal(deals.tripShape("2026-11-10", "2026-11-18"), null); // 8 nights
});

test("weeks to scan: Mondays from two weeks out, ending within six months", () => {
  const weeks = deals.weekStarts("2026-10-09");
  assert.equal(weeks[0], "2026-10-26");
  assert.equal(weeks.at(-1), "2027-03-29");
  assert.equal(weeks.length, 23);
  assert.ok(weeks.every((w) => deals.weekday(w) === 1));
  assert.equal(deals.weekStarts("2026-10-12")[0], "2026-10-26", "a Monday two weeks out is included");
});

test("wanted: right dates, at most one stop each way", () => {
  const fare = { departDate: "2026-11-12", returnDate: "2026-11-15", stopsOut: 1, stopsBack: 0 };
  assert.equal(deals.wanted(fare, "2026-10-09"), true);
  assert.equal(deals.wanted({ ...fare, stopsBack: 2 }, "2026-10-09"), false);
  assert.equal(deals.wanted(fare, "2026-11-01"), false); // less than 2 weeks out
  assert.equal(deals.wanted(fare, "2026-04-01"), false); // more than 6 months out
});

test("median, deal limits and percent below", () => {
  assert.equal(deals.median([300, 100, 200]), 200);
  assert.equal(deals.median([100, 200, 300, 400]), 250);
  assert.equal(deals.median([]), null);
  const base = { percent: 30, minHistory: 20 };
  assert.equal(deals.dealLimit({ ...base, normal: 400, historyCount: 25 }), 280);
  assert.equal(deals.dealLimit({ ...base, normal: 400, historyCount: 5 }), null, "not enough history yet");
  assert.equal(deals.dealLimit({ ...base, normal: 400, historyCount: 5, maxPrice: 150 }), 150);
  assert.equal(deals.dealLimit({ ...base, normal: 400, historyCount: 25, maxPrice: 300 }), 300, "the higher limit wins");
  assert.equal(deals.percentBelow(200, 400), 50);
  assert.equal(deals.percentBelow(500, 400), null);
});
