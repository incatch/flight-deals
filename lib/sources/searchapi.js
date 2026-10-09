// Prices from Google Flights, through SearchApi (searchapi.io). Two kinds of
// search, each billed as one search:
//
// - The calendar: round-trip prices for a week of departure dates against a
//   range of return dates (Google Flights' date grid). The scanner uses this
//   to cover every date cheaply.
// - A regular flight search for one pair of dates: the double-check before a
//   deal is emailed. It leaves out basic economy (US trips) and lets us skip
//   long overnight connections. A round trip may take a second search for the
//   flights home.
//
// Docs: https://www.searchapi.io/docs/google-flights-calendar-api
//       https://www.searchapi.io/docs/google-flights-api

const API = "https://www.searchapi.io/api/v1/search";

class SourceError extends Error {}

/** "$1,234" or 1234 → 1234 (whole dollars), or null. */
function dollars(value) {
  if (typeof value === "number") return value > 0 ? Math.round(value) : null;
  const n = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return n > 0 ? Math.round(n) : null;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (value) => String(value ?? "").slice(0, 10);

/** A Google Flights page for the trip (for links in emails and on the site). */
function googleFlightsUrl({ origin, destination, departDate, returnDate }) {
  const q = `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&curr=USD&hl=en`;
}

/** Basic economy (no carry-on or seat choice) — never sent to subscribers. */
function isBasicEconomy(option) {
  const text = [
    ...(option.extensions || []),
    ...(option.flights || []).flatMap((f) => [f.travel_class || "", ...(f.extensions || [])]),
  ].join(" | ");
  return /basic economy|\bbasic\b/i.test(text);
}

/** A layover's length in minutes (a number, or text like "1 hr 5 min"), or null. */
function minutes(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "");
  const h = /(\d+)\s*h/i.exec(text);
  const m = /(\d+)\s*m/i.exec(text);
  return h || m ? Number(h?.[1] || 0) * 60 + Number(m?.[1] || 0) : null;
}
function isOvernight(layover) {
  return Boolean(layover.overnight || layover.is_overnight);
}

/**
 * Why we'd skip this flight option, or null if it's fine. An overnight
 * connection means a long wait in an airport overnight (longer than
 * `maxOvernightMinutes`); a red-eye with a short connection is fine. If
 * Google doesn't say how long an overnight layover is, it's skipped.
 */
function problemWith(option, { maxOvernightMinutes = 180 } = {}) {
  const layovers = option.layovers || [];
  if (layovers.length > 1) return "more than one stop";
  const short = (l) => {
    const m = minutes(l.duration);
    return m !== null && m <= maxOvernightMinutes;
  };
  if (layovers.some((l) => isOvernight(l) && !short(l))) return "a long overnight connection";
  if (isBasicEconomy(option)) return "basic economy";
  return null;
}

function stopsText(option) {
  const layovers = option?.layovers || [];
  if (!layovers.length) return "Nonstop";
  const describe = (l) => {
    const m = minutes(l.duration);
    const length = m === null ? "" : `, ${Math.floor(m / 60) ? `${Math.floor(m / 60)}h ` : ""}${m % 60}m`;
    return `${l.id || l.airport_code || l.name}${length}${isOvernight(l) ? " overnight" : ""}`;
  };
  return `1 stop (${layovers.map(describe).join("; ")})`;
}

function createSearchApi({ apiKey, fetch = globalThis.fetch, timeoutMs = 90000 }) {
  /** One search. Returns the parsed answer; throws SourceError if it failed outright. */
  async function search(params) {
    let res;
    try {
      res = await fetch(`${API}?${new URLSearchParams({ ...params, api_key: apiKey })}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SourceError(`SearchApi didn't answer (${err.message})`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new SourceError("SearchApi refused the API key");
    if (res.status === 429) throw new SourceError("SearchApi says we're out of searches (or asking too fast)");
    if (!res.ok && !body.error) throw new SourceError(`SearchApi returned ${res.status}`);
    return body;
  }

  const common = { currency: "USD", gl: "us", hl: "en", travel_class: "economy", stops: "one_stop_or_fewer" };

  /**
   * The date grid: round trips leaving `outboundStart`–`outboundEnd` and
   * coming back `returnStart`–`returnEnd`. Returns { fares, raw } where fares
   * are [{ departDate, returnDate, price }] in whole US dollars.
   */
  async function calendar({ origin, arrival, outboundStart, outboundEnd, returnStart, returnEnd, domestic }) {
    const raw = await search({
      engine: "google_flights_calendar",
      flight_type: "round_trip",
      departure_id: origin,
      arrival_id: arrival,
      outbound_date: outboundStart,
      return_date: returnStart,
      outbound_date_start: outboundStart,
      outbound_date_end: outboundEnd,
      return_date_start: returnStart,
      return_date_end: returnEnd,
      ...common,
      // Basic economy fares make the grid look cheaper than anything we'd
      // send; Google can leave them out on US trips.
      ...(domestic ? { exclude_basic_economy: "true" } : {}),
    });
    if (raw.error && !raw.calendar) throw new SourceError(`SearchApi: ${raw.error}`);
    const fares = [];
    for (const item of raw.calendar || []) {
      const departDate = day(item.departure ?? item.departure_date ?? item.outbound_date);
      const returnDate = day(item.return ?? item.return_date);
      const price = dollars(item.price);
      if (!DATE.test(departDate) || !DATE.test(returnDate) || !price || item.has_no_flights) continue;
      fares.push({ departDate, returnDate, price, stopsOut: 0, stopsBack: 0 });
    }
    return { fares, raw };
  }

  /**
   * The cheapest acceptable option in a flight search, plus every option
   * looked at (for Admin → Check a route).
   */
  function pick(body, rules) {
    const options = [...(body.best_flights || []), ...(body.other_flights || []), ...(body.flights || [])];
    const skipped = new Set();
    const good = [];
    const rows = [];
    for (const raw of options) {
      const option = { ...raw, price: dollars(raw.price) };
      const problem = option.price ? problemWith(option, rules) : "no price shown on Google Flights";
      rows.push({
        airline: [...new Set((option.flights || []).map((f) => f.airline).filter(Boolean))].join(" / ") || "?",
        price: option.price,
        stops: stopsText(option),
        problem,
      });
      if (problem) skipped.add(problem);
      else good.push(option);
    }
    good.sort((a, b) => a.price - b.price);
    rows.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    return { best: good[0] || null, skipped: [...skipped], rows };
  }

  /**
   * The double-check for one round trip. Returns { ok, price, priceLevel,
   * typicalRange, airline, stopsText, url, reason, searches, raw }.
   */
  async function check({ origin, arrival, destination, departDate, returnDate, domestic, maxOvernightMinutes }) {
    const rules = { maxOvernightMinutes };
    const params = {
      engine: "google_flights",
      flight_type: "round_trip",
      departure_id: origin,
      arrival_id: arrival,
      outbound_date: departDate,
      return_date: returnDate,
      ...common,
      // Google can leave out basic economy, but only on US trips; elsewhere
      // we skip it ourselves (isBasicEconomy).
      ...(domestic ? { exclude_basic_economy: "true" } : {}),
    };
    const out = await search(params);
    const insights = out.price_insights || {};
    const result = {
      ok: false,
      price: null,
      priceLevel: insights.price_level || null,
      typicalRange: Array.isArray(insights.typical_price_range) ? insights.typical_price_range.map(dollars) : null,
      airline: null,
      stopsText: null,
      url: out.search_metadata?.google_flights_url || googleFlightsUrl({ origin, destination: destination || arrival, departDate, returnDate }),
      reason: null,
      searches: 1,
      raw: { outbound: out },
      // Every option looked at, out and back (for Admin → Check a route).
      options: { out: [], back: null },
    };
    const outbound = pick(out, rules);
    result.options.out = outbound.rows;
    if (!outbound.best) {
      result.reason = out.error
        ? `Google Flights: ${out.error}`
        : outbound.skipped.length
          ? `Only flights with ${outbound.skipped.join(" or ")}.`
          : "No flights on Google Flights for these dates.";
      return result;
    }
    result.airline = outbound.best.flights?.[0]?.airline || null;
    let price = outbound.best.price;
    let back = null;

    if (outbound.best.departure_token) {
      result.searches = 2;
      const ret = await search({ ...params, departure_token: outbound.best.departure_token });
      result.raw.back = ret;
      const inbound = pick(ret, rules);
      result.options.back = inbound.rows;
      if (!inbound.best) {
        result.reason = inbound.skipped.length
          ? `The flights home are all ${inbound.skipped.join(" or ")}.`
          : "No flights home on Google Flights for that date.";
        return result;
      }
      back = inbound.best;
      price = back.price;
    }

    result.ok = true;
    result.price = price;
    result.stopsText = back ? `Out: ${stopsText(outbound.best)} · Back: ${stopsText(back)}` : stopsText(outbound.best);
    return result;
  }

  return { calendar, check };
}

module.exports = { createSearchApi, SourceError, googleFlightsUrl, isBasicEconomy, problemWith, stopsText, dollars, minutes };
