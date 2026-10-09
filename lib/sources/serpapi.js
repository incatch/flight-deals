// The double-check before a deal is emailed: the same trip on Google Flights
// (through SerpApi), live. It confirms the price is still there, leaves out
// basic economy and overnight connections, and gives Google's own rating of
// the price (low / typical / high for the route).
//
// A round trip takes two searches: the flights out (each with the round-trip
// price), then the flights back for the one we picked.
//
// Docs: https://serpapi.com/google-flights-api

const { SourceError } = require("./travelpayouts");

const API = "https://serpapi.com/search.json";

/** Basic economy (no carry-on or seat choice) — never sent to subscribers. */
function isBasicEconomy(option) {
  const text = [
    ...(option.extensions || []),
    ...(option.flights || []).flatMap((f) => [f.travel_class || "", ...(f.extensions || [])]),
  ].join(" | ");
  return /basic economy|\bbasic\b/i.test(text);
}

/** Why we'd skip this flight option, or null if it's fine. */
function problemWith(option) {
  const layovers = option.layovers || [];
  if (layovers.length > 1) return "more than one stop";
  if (layovers.some((l) => l.overnight)) return "an overnight connection";
  if (isBasicEconomy(option)) return "basic economy";
  return null;
}

function stopsText(option) {
  const layovers = option?.layovers || [];
  if (!layovers.length) return "Nonstop";
  return `1 stop (${layovers.map((l) => l.id || l.name).join(", ")})`;
}

function createSerpApi({ apiKey, fetch = globalThis.fetch, timeoutMs = 60000 }) {
  async function search(params) {
    let res;
    try {
      res = await fetch(`${API}?${new URLSearchParams({ ...params, api_key: apiKey })}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SourceError(`Google Flights (SerpApi) didn't answer (${err.message})`);
    }
    if (res.status === 401) throw new SourceError("SerpApi refused the API key");
    if (res.status === 429) throw new SourceError("SerpApi says this month's searches are used up");
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.error) throw new SourceError(`SerpApi returned ${res.status}`);
    return body;
  }

  function pick(body) {
    const options = [...(body.best_flights || []), ...(body.other_flights || [])].filter((o) => Number(o.price) > 0);
    const skipped = new Set();
    const good = [];
    for (const option of options) {
      const problem = problemWith(option);
      if (problem) skipped.add(problem);
      else good.push(option);
    }
    good.sort((a, b) => a.price - b.price);
    return { best: good[0] || null, skipped: [...skipped] };
  }

  /**
   * Checks a round trip. Returns { ok, price, priceLevel, typicalRange,
   * airline, stopsText, url, reason, searches }.
   */
  async function check({ origin, arrival, departDate, returnDate, domestic }) {
    const params = {
      engine: "google_flights",
      departure_id: origin,
      arrival_id: arrival,
      outbound_date: departDate,
      return_date: returnDate,
      type: "1", // round trip
      travel_class: "1", // economy
      stops: "2", // one stop or fewer
      currency: "USD",
      hl: "en",
      gl: "us",
      // Google can leave out basic economy, but only on US domestic trips;
      // elsewhere we skip it ourselves (isBasicEconomy).
      ...(domestic ? { exclude_basic: "true" } : {}),
    };
    let searches = 1;
    const out = await search(params);
    const insights = out.price_insights || {};
    const result = {
      ok: false,
      price: null,
      priceLevel: insights.price_level || null,
      typicalRange: Array.isArray(insights.typical_price_range) ? insights.typical_price_range : null,
      airline: null,
      stopsText: null,
      url: out.search_metadata?.google_flights_url || null,
      reason: null,
      searches,
    };
    if (out.error) {
      result.reason = /no results|hasn't returned any/i.test(out.error) ? "No flights on Google Flights for these dates." : `Google Flights: ${out.error}`;
      return result;
    }

    const outbound = pick(out);
    if (!outbound.best) {
      result.reason = outbound.skipped.length ? `Only flights with ${outbound.skipped.join(" or ")}.` : "No flights on Google Flights for these dates.";
      return result;
    }
    result.airline = outbound.best.flights?.[0]?.airline || null;
    let price = Number(outbound.best.price);
    let back = null;

    if (outbound.best.departure_token) {
      searches += 1;
      const ret = await search({ ...params, departure_token: outbound.best.departure_token });
      result.searches = searches;
      if (ret.search_metadata?.google_flights_url) result.url = ret.search_metadata.google_flights_url;
      const inbound = pick(ret);
      if (!inbound.best) {
        result.reason = inbound.skipped.length
          ? `The flights home are all ${inbound.skipped.join(" or ")}.`
          : "No flights home on Google Flights for that date.";
        return result;
      }
      back = inbound.best;
      price = Number(back.price);
    }

    result.ok = true;
    result.price = Math.round(price);
    result.stopsText = back ? `Out: ${stopsText(outbound.best)} · Back: ${stopsText(back)}` : stopsText(outbound.best);
    return result;
  }

  return { check };
}

module.exports = { createSerpApi, isBasicEconomy, problemWith, stopsText };
