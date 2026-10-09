// Runs the scanner at the hours set in Admin → Settings, and sends the
// weekly roundup on Sunday afternoons (both in the site's time zone).
// Checks once a minute; the database makes sure each run happens once, even
// across restarts and deploys.

const WEEKLY = { weekday: 0, hour: 17 }; // Sunday, 5 pm

function localParts(timeZone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function createScheduler({ store, scanner, alerts, timeZone, log = console, now = () => new Date() }) {
  let timer = null;

  /** One check: starts whatever is due. Returns the names of the jobs started. */
  async function tick() {
    const date = now();
    const t = localParts(timeZone, date);
    // When this local hour began: each job runs at most once per hour slot.
    const slotStart = new Date(date.getTime() - (t.minute * 60 + t.second) * 1000 - date.getMilliseconds());
    const started = [];
    const settings = await store.settings();

    if (settings.scan_hours.includes(t.hour) && !scanner.running && (await store.claimJob("scan", slotStart, date))) {
      started.push("scan");
      scanner.run().catch((err) => log.error(`scan failed: ${err.message}`));
    }
    if (t.weekday === WEEKLY.weekday && t.hour === WEEKLY.hour && (await store.claimJob("weekly", slotStart, date))) {
      started.push("weekly");
      alerts.sendWeekly().catch((err) => log.error(`weekly roundup failed: ${err.message}`));
    }
    return started;
  }

  return {
    tick,
    start() {
      store.closeAbandonedScans().catch(() => {});
      const run = () => tick().catch((err) => log.error(`scheduler: ${err.message}`));
      timer = setInterval(run, 60 * 1000);
      timer.unref();
      run();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { createScheduler, localParts };
