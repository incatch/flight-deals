// The scanner: for each airport and destination, gets recent round-trip
// prices for the next six months, keeps the trips we care about, compares
// them with what's normal for the route, double-checks the best ones on
// Google Flights, and records the deals (which alerts.js then emails).

const deals = require("./deals");
const { SourceError, aviasalesUrl } = require("./sources/travelpayouts");

/** Today's date (YYYY-MM-DD) in the site's time zone. */
function localDate(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// A Google Flights price can move a little between the scan and the check.
const CHECK_TOLERANCE = 1.05;
// The most deals one route can produce in one scan (one weekend trip, one longer trip).
const SHAPES = ["weekend", "week"];

function createScanner({
  store,
  keys,
  travelpayouts, // (token) => { roundTrips }
  serpapi, // (key) => { check }
  alerts, // { sendInstant(deals) }
  timeZone,
  log = console,
  pauseMs = 250,
  now = () => new Date(),
}) {
  let running = null;
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : Promise.resolve());

  /** Every wanted round trip on a route, cheapest per pair of dates. */
  async function routeFares(source, origin, destination, today) {
    const best = new Map();
    let errors = 0;
    for (const month of deals.monthsToScan(today)) {
      let fares;
      try {
        fares = await source.roundTrips({ origin, destination, month });
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (/refused/.test(err.message)) throw err; // a bad token: stop the whole scan
        errors += 1;
        log.warn(`${origin}-${destination} ${month}: ${err.message}`);
        continue;
      } finally {
        await pause();
      }
      for (const fare of fares) {
        if (!deals.wanted(fare, today)) continue;
        const key = `${fare.departDate}/${fare.returnDate}`;
        if (!best.has(key) || best.get(key).price > fare.price) best.set(key, fare);
      }
    }
    return { fares: [...best.values()], errors };
  }

  /** The Google Flights check for one possible deal. Returns the fields for store.addDeal. */
  async function checkDeal(candidate, checker, limit) {
    const { origin, destination, fare, normal } = candidate;
    const result = await checker.check({
      origin,
      arrival: destination.google_codes || destination.code,
      departDate: fare.departDate,
      returnDate: fare.returnDate,
      domestic: destination.domestic,
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
    return { ...fields, status: "rejected", reason: `On Google Flights it's $${result.price} now (a deal is $${limit} or less).` };
  }

  async function scan() {
    const settings = await store.settings();
    const token = await keys.get("travelpayouts");
    const record = await store.startScan();
    const today = localDate(timeZone, now());
    const counts = { routes: 0, prices: 0, possible: 0, confirmed: 0, rejected: 0, unchecked: 0, errors: 0 };
    const summary = () =>
      `Checked ${counts.routes} routes and ${counts.prices.toLocaleString("en-US")} prices: ` +
      `${counts.confirmed} deals confirmed, ${counts.rejected} didn't hold up, ${counts.unchecked} not checked` +
      (counts.errors ? ` (${counts.errors} price lookups failed)` : "") +
      ".";
    try {
      if (!token) throw new Error("There's no Travelpayouts API token yet (see Admin → Price services).");
      const source = travelpayouts(token);
      const origins = await store.origins({ activeOnly: true });
      const destinations = await store.destinations({ activeOnly: true });

      // 1. Prices for every route, and the possible deals among them.
      const candidates = [];
      for (const origin of origins) {
        for (const destination of destinations) {
          if (origin.code === destination.code) continue;
          const { fares, errors } = await routeFares(source, origin.code, destination.code, today);
          counts.routes += 1;
          counts.errors += errors;
          counts.prices += fares.length;
          await store.addFares(record.id, origin.code, destination.code, fares);
          const history = await store.routeHistory(origin.code, destination.code);
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
            const earlier = await store.recentDealPrice({ origin: origin.code, destination: destination.code, ...fare });
            if (earlier && earlier <= fare.price) continue;
            candidates.push({ origin: origin.code, destination, fare, normal: history.normal, limit });
          }
        }
      }
      counts.possible = candidates.length;

      // 2. Double-check the best ones on Google Flights, as far as today's checks allow.
      candidates.sort((a, b) => a.fare.price / a.limit - b.fare.price / b.limit);
      const serpKey = await keys.get("serpapi");
      const checker = serpKey ? serpapi(serpKey) : null;
      const found = [];
      for (const candidate of candidates) {
        const { fare, destination } = candidate;
        let fields;
        const searchesLeft = settings.max_checks_per_day * 2 - (await store.searchesUsed(today));
        if (!checker) fields = { status: "unchecked", reason: "No Google Flights (SerpApi) key yet." };
        else if (searchesLeft < 2) fields = { status: "unchecked", reason: "Today's Google Flights checks were used up." };
        else {
          try {
            fields = await checkDeal(candidate, checker, candidate.limit);
          } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            fields = { status: "unchecked", reason: err.message, searches: 1 };
          }
          await store.useSearches(today, fields.searches || 0);
        }
        const deal = await store.addDeal({
          scanId: record.id,
          origin: candidate.origin,
          destination: destination.code,
          departDate: fare.departDate,
          returnDate: fare.returnDate,
          foundPrice: fare.price,
          normalPrice: candidate.normal,
          airline: fields.airline || fare.airline,
          ...fields,
          bookUrl: fields.bookUrl || aviasalesUrl(fare.link, settings.affiliate_marker),
        });
        counts[deal.status] += 1;
        if (deal.status === "confirmed" || (deal.status === "unchecked" && !settings.require_check)) found.push(deal);
      }

      await store.finishScan(record.id, summary());
      await store.pruneFares();
      log.log(`scan ${record.id}: ${summary()}`);

      // 3. Tell the subscribers.
      if (found.length && alerts) await alerts.sendInstant(found);
      return { scanId: record.id, counts, deals: found };
    } catch (err) {
      await store.failScan(record.id, err.message, counts.routes ? summary() : null);
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
     * Admin → "Check a route": what the price services say about one route
     * right now, without recording anything (except Google Flights searches used).
     */
    async checkRoute({ origin, destination, withGoogle }) {
      const settings = await store.settings();
      const today = localDate(timeZone, now());
      const token = await keys.get("travelpayouts");
      const out = { origin, destination: destination.code, months: [], fares: [], raw: 0, google: null, error: null };
      if (!token) {
        out.error = "There's no Travelpayouts API token yet.";
        return out;
      }
      const source = travelpayouts(token);
      const best = new Map();
      for (const month of deals.monthsToScan(today)) {
        try {
          const fares = await source.roundTrips({ origin, destination: destination.code, month });
          const kept = fares.filter((f) => deals.wanted(f, today));
          out.raw += fares.length;
          out.months.push({ month, prices: fares.length, kept: kept.length });
          for (const f of kept) {
            const key = `${f.departDate}/${f.returnDate}`;
            if (!best.has(key) || best.get(key).price > f.price) best.set(key, f);
          }
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          out.months.push({ month, error: err.message });
        }
        await pause();
      }
      out.fares = [...best.values()].sort((a, b) => a.price - b.price).slice(0, 15).map((f) => ({
        ...f,
        shape: deals.tripShape(f.departDate, f.returnDate),
        url: aviasalesUrl(f.link, settings.affiliate_marker),
      }));
      out.history = await store.routeHistory(origin, destination.code);

      if (withGoogle && out.fares.length) {
        const key = await keys.get("serpapi");
        if (!key) out.google = { error: "There's no Google Flights (SerpApi) key yet." };
        else {
          const cheapest = out.fares[0];
          try {
            const result = await serpapi(key).check({
              origin,
              arrival: destination.google_codes || destination.code,
              departDate: cheapest.departDate,
              returnDate: cheapest.returnDate,
              domestic: destination.domestic,
            });
            await store.useSearches(today, result.searches);
            out.google = { ...result, departDate: cheapest.departDate, returnDate: cheapest.returnDate };
          } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            out.google = { error: err.message };
          }
        }
      }
      return out;
    },
  };
}

module.exports = { createScanner, localDate };
