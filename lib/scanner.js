// The scanner: gets Google Flights' round-trip prices (SearchApi's date-grid
// "calendar" search, one week of departures per search) for each airport and
// destination, keeps the trips we care about, compares them with what's
// normal for the route, double-checks the best ones with a full Google
// Flights search, and records the deals (which alerts.js then emails).
//
// Searches cost money, so each scan does only its share of the daily limit
// (Admin → Settings), starting with the route-weeks scanned longest ago:
// over a few days every week from 2 weeks to 6 months out gets covered.

const deals = require("./deals");
const { SourceError, googleFlightsUrl } = require("./sources/searchapi");

/** Today's date (YYYY-MM-DD) in the site's time zone. */
function localDate(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// A Google Flights price can move a little between the scan and the check.
const CHECK_TOLERANCE = 1.05;
// The most deals one route can produce in one scan (one weekend trip, one longer trip).
const SHAPES = ["weekend", "week"];
// One calendar search: departures Monday–Sunday of a week, returns from the
// Wednesday to the Wednesday after (weekends and 4–7 night trips).
const RETURN_FROM = 2;
const RETURN_TO = 9;
// Errors that mean no search will work right now: stop the scan.
const FATAL = /refused|out of searches/;

function calendarWindow(weekStart) {
  return {
    outboundStart: weekStart,
    outboundEnd: deals.addDays(weekStart, 6),
    returnStart: deals.addDays(weekStart, RETURN_FROM),
    returnEnd: deals.addDays(weekStart, RETURN_TO),
  };
}

function createScanner({
  store,
  keys,
  searchapi, // (apiKey) => { calendar, check }
  alerts, // { sendInstant(deals) }
  timeZone,
  log = console,
  pauseMs = 500,
  now = () => new Date(),
}) {
  let running = null;
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : Promise.resolve());

  /** The double-check for one possible deal. Returns the fields for store.addDeal. */
  async function checkDeal(candidate, api, settings) {
    const { origin, destination, fare, normal, limit } = candidate;
    const result = await api.check({
      origin,
      arrival: destination.google_codes || destination.code,
      destination: destination.name,
      departDate: fare.departDate,
      returnDate: fare.returnDate,
      domestic: destination.domestic,
      maxOvernightMinutes: settings.max_overnight_layover_hours * 60,
    });
    const fields = {
      checkedPrice: result.price,
      priceLevel: result.priceLevel,
      airline: result.airline,
      stopsText: result.stopsText,
      bookUrl: result.url,
      searches: result.searches,
    };
    if (!result.ok) return { ...fields, status: "rejected", reason: result.reason };
    const googleSaysLow = result.priceLevel === "low" && normal && result.price < normal;
    if (result.price <= limit * CHECK_TOLERANCE || googleSaysLow) {
      return { ...fields, status: "confirmed", reason: googleSaysLow && result.price > limit * CHECK_TOLERANCE ? "Google Flights rates this price low." : null };
    }
    return { ...fields, status: "rejected", reason: `With no basic economy it's $${result.price} now (a deal is $${limit} or less).` };
  }

  async function scan() {
    const settings = await store.settings();
    const apiKey = await keys.get("searchapi");
    const record = await store.startScan();
    const today = localDate(timeZone, now());
    const counts = { searches: 0, routes: 0, prices: 0, possible: 0, confirmed: 0, rejected: 0, unchecked: 0, errors: 0 };
    const summary = () =>
      `${counts.searches} calendar searches (${counts.routes} routes, ${counts.prices.toLocaleString("en-US")} prices): ` +
      `${counts.confirmed} deals confirmed, ${counts.rejected} didn't hold up, ${counts.unchecked} not checked` +
      (counts.errors ? ` (${counts.errors} searches failed)` : "") +
      ".";
    try {
      if (!apiKey) throw new Error("There's no SearchApi key yet (see README: the price service's key).");
      if (!settings.searches_per_day) {
        await store.finishScan(record.id, "Scanning is paused: Admin → Settings → calendar searches per day is 0.");
        return { scanId: record.id, counts, deals: [], paused: true };
      }
      const api = searchapi(apiKey);
      const destinations = new Map((await store.destinations({ activeOnly: true })).map((d) => [d.code, d]));

      // 1. This scan's share of the day's calendar searches, oldest route-weeks first.
      const perScan = Math.ceil(settings.searches_per_day / Math.max(1, settings.scan_hours.length));
      const left = settings.searches_per_day - (await store.searchesUsed(today, "calendar"));
      const slots = await store.dueSlots(deals.weekStarts(today), Math.max(0, Math.min(perScan, left)));
      const byRoute = new Map();
      for (const slot of slots) {
        const destination = destinations.get(slot.destination);
        let fares;
        try {
          counts.searches += 1;
          await store.useSearches(today, "calendar", 1);
          ({ fares } = await api.calendar({
            origin: slot.origin,
            arrival: destination.google_codes || destination.code,
            domestic: destination.domestic,
            ...calendarWindow(slot.week_start),
          }));
        } catch (err) {
          if (!(err instanceof SourceError) || FATAL.test(err.message)) throw err;
          counts.errors += 1;
          log.warn(`${slot.origin}-${slot.destination} week of ${slot.week_start}: ${err.message}`);
          // To the back of the line, so a route that keeps failing doesn't use up every scan.
          await store.markSlot(slot.origin, slot.destination, slot.week_start);
          continue;
        } finally {
          await pause();
        }
        await store.markSlot(slot.origin, slot.destination, slot.week_start);
        const key = `${slot.origin}|${slot.destination}`;
        if (!byRoute.has(key)) byRoute.set(key, []);
        byRoute.get(key).push(...fares.filter((f) => deals.wanted(f, today)));
      }

      // 2. Record the prices, and find the possible deals on each route.
      const candidates = [];
      for (const [key, fares] of byRoute) {
        const [origin, code] = key.split("|");
        const destination = destinations.get(code);
        counts.routes += 1;
        counts.prices += fares.length;
        await store.addFares(record.id, origin, code, fares);
        const history = await store.routeHistory(origin, code);
        const limit = deals.dealLimit({
          normal: history.normal,
          historyCount: history.count,
          percent: settings.deal_percent,
          minHistory: settings.min_history,
          maxPrice: destination.max_price,
        });
        if (!limit) continue;
        for (const shape of SHAPES) {
          const fare = fares
            .filter((f) => f.price <= limit && deals.tripShape(f.departDate, f.returnDate) === shape)
            .sort((a, b) => a.price - b.price)[0];
          if (!fare) continue;
          // Already found this week at the same price or lower.
          const earlier = await store.recentDealPrice({ origin, destination: code, ...fare });
          if (earlier && earlier <= fare.price) continue;
          candidates.push({ origin, destination, fare, normal: history.normal, limit });
        }
      }
      counts.possible = candidates.length;

      // 3. Double-check the best ones, as far as today's checks allow.
      candidates.sort((a, b) => a.fare.price / a.limit - b.fare.price / b.limit);
      const found = [];
      for (const candidate of candidates) {
        const { fare, destination } = candidate;
        let fields;
        const checksLeft = settings.max_checks_per_day * 2 - (await store.searchesUsed(today, "check"));
        if (checksLeft < 2) fields = { status: "unchecked", reason: "Today's Google Flights double-checks were used up." };
        else {
          try {
            fields = await checkDeal(candidate, api, settings);
          } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            fields = { status: "unchecked", reason: err.message, searches: 1 };
          }
          await store.useSearches(today, "check", fields.searches || 0);
        }
        const deal = await store.addDeal({
          scanId: record.id,
          origin: candidate.origin,
          destination: destination.code,
          departDate: fare.departDate,
          returnDate: fare.returnDate,
          foundPrice: fare.price,
          normalPrice: candidate.normal,
          ...fields,
          bookUrl: fields.bookUrl || googleFlightsUrl({ origin: candidate.origin, destination: destination.name, ...fare }),
        });
        counts[deal.status] += 1;
        if (deal.status === "confirmed" || (deal.status === "unchecked" && !settings.require_check)) found.push(deal);
      }

      await store.finishScan(record.id, summary());
      await store.pruneFares();
      log.log(`scan ${record.id}: ${summary()}`);

      // 4. Tell the subscribers.
      if (found.length && alerts) await alerts.sendInstant(found);
      return { scanId: record.id, counts, deals: found };
    } catch (err) {
      await store.failScan(record.id, err.message, counts.searches ? summary() : null);
      throw err;
    }
  }

  return {
    /** Runs a scan (or waits for the one already running). */
    run() {
      if (!running) running = scan().finally(() => (running = null));
      return running;
    },
    get running() {
      return Boolean(running);
    },

    /**
     * Admin → "Check a route": one calendar search (one week of departures,
     * `weeksAhead` weeks from now), and optionally the full Google Flights
     * check of the cheapest trip. Nothing is saved except the searches used.
     */
    async checkRoute({ origin, destination, weeksAhead, withGoogle }) {
      const today = localDate(timeZone, now());
      const apiKey = await keys.get("searchapi");
      const weekStart = deals.addDays(today, 7 * weeksAhead + ((8 - deals.weekday(deals.addDays(today, 7 * weeksAhead))) % 7));
      const out = { origin, destination: destination.code, weekStart, fares: [], raw: null, google: null, error: null, history: null };
      if (!apiKey) {
        out.error = "There's no SearchApi key yet.";
        return out;
      }
      const api = searchapi(apiKey);
      try {
        await store.useSearches(today, "calendar", 1);
        const { fares, raw } = await api.calendar({ origin, arrival: destination.google_codes || destination.code, domestic: destination.domestic, ...calendarWindow(weekStart) });
        out.raw = raw;
        out.fares = fares
          .sort((a, b) => a.price - b.price)
          .map((f) => ({ ...f, shape: deals.tripShape(f.departDate, f.returnDate), wanted: deals.wanted(f, today), url: googleFlightsUrl({ origin, destination: destination.name, ...f }) }));
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        out.error = err.message;
        return out;
      }
      out.history = await store.routeHistory(origin, destination.code);

      const cheapest = out.fares.find((f) => f.wanted) || out.fares[0];
      if (withGoogle && cheapest) {
        try {
          const result = await api.check({
            origin,
            arrival: destination.google_codes || destination.code,
            destination: destination.name,
            departDate: cheapest.departDate,
            returnDate: cheapest.returnDate,
            domestic: destination.domestic,
            maxOvernightMinutes: (await store.settings()).max_overnight_layover_hours * 60,
          });
          await store.useSearches(today, "check", result.searches);
          out.google = { ...result, departDate: cheapest.departDate, returnDate: cheapest.returnDate };
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          out.google = { error: err.message };
        }
      }
      return out;
    },
  };
}

module.exports = { createScanner, localDate, calendarWindow };
