const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, quiet } = require("./helpers");
const { createScheduler, localParts } = require("../lib/scheduler");

let app;
test.beforeEach(async () => {
  app = await startApp();
});
test.afterEach(() => app.stop());

function scheduler(at, ran) {
  const scanner = { running: false, run: async () => ran.push("scan") };
  const alerts = { sendWeekly: async () => ran.push("weekly") };
  return createScheduler({ store: app.store, scanner, alerts, timeZone: "America/Chicago", log: quiet, now: () => new Date(at) });
}

test("local time in the site's time zone", () => {
  assert.deepEqual(localParts("America/Chicago", new Date("2026-10-11T22:05:09Z")), { weekday: 0, hour: 17, minute: 5, second: 9 });
});

test("scans run once in each scan hour, even if checked every minute", async () => {
  const ran = [];
  // 6:00 and 6:30 am in Springfield (CDT = UTC-5).
  assert.deepEqual(await scheduler("2026-10-09T11:00:30Z", ran).tick(), ["scan"]);
  assert.deepEqual(await scheduler("2026-10-09T11:30:00Z", ran).tick(), []);
  // 7 am: not a scan hour.
  assert.deepEqual(await scheduler("2026-10-09T12:00:00Z", ran).tick(), []);
  // 6 pm: the next one.
  assert.deepEqual(await scheduler("2026-10-09T23:01:00Z", ran).tick(), ["scan"]);
  // 6 am the next day.
  assert.deepEqual(await scheduler("2026-10-10T11:10:00Z", ran).tick(), ["scan"]);
  assert.deepEqual(ran, ["scan", "scan", "scan"]);
});

test("the weekly roundup goes on Sunday at 5 pm, once", async () => {
  const ran = [];
  assert.deepEqual(await scheduler("2026-10-11T22:00:10Z", ran).tick(), ["weekly"]);
  assert.deepEqual(await scheduler("2026-10-11T22:59:00Z", ran).tick(), []);
  assert.deepEqual(await scheduler("2026-10-12T22:00:10Z", ran).tick(), [], "Monday");
});
