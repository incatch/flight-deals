// Prices from Travelpayouts (Aviasales' partner program): the cheapest round
// trips other travelers found in recent days, for a route and month. Free,
// but cached, so a price may already be gone; the Google Flights check
// (serpapi.js) confirms a deal before anyone is emailed about it.
//
// Docs: https://support.travelpayouts.com/hc/en-us/articles/203956163 (prices_for_dates)

const API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

class SourceError extends Error {}

function createTravelpayouts({ token, fetch = globalThis.fetch, timeoutMs = 20000 }) {
  /**
   * Round trips from `origin` to `destination` leaving in `month` (YYYY-MM),
   * as [{ departDate, returnDate, price, stopsOut, stopsBack, airline, link }].
   * Prices are whole US dollars.
   */
  async function roundTrips({ origin, destination, month }) {
    const params = new URLSearchParams({
      origin,
      destination,
      departure_at: month,
      one_way: "false",
      direct: "false",
      unique: "false",
      sorting: "price",
      currency: "usd",
      market: "us",
      limit: "1000",
      page: "1",
    });
    let res;
    try {
      res = await fetch(`${API}?${params}`, {
        headers: { "x-access-token": token, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SourceError(`Travelpayouts didn't answer (${err.message})`);
    }
    if (res.status === 401 || res.status === 403) throw new SourceError("Travelpayouts refused the API token");
    if (res.status === 429) throw new SourceError("Travelpayouts says we're asking too often");
    if (!res.ok) throw new SourceError(`Travelpayouts returned ${res.status}`);
    const body = await res.json();
    if (body.success === false) throw new SourceError(`Travelpayouts: ${body.error || "request failed"}`);
    return (body.data || []).map(normalize).filter(Boolean);
  }

  return { roundTrips };
}

function normalize(item) {
  const departDate = String(item.departure_at || "").slice(0, 10);
  const returnDate = String(item.return_at || "").slice(0, 10);
  const price = Math.round(Number(item.price));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate) || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || !(price > 0)) return null;
  return {
    departDate,
    returnDate,
    price,
    stopsOut: Number(item.transfers) || 0,
    stopsBack: Number(item.return_transfers ?? item.transfers) || 0,
    airline: item.airline ? String(item.airline).slice(0, 10) : null,
    link: typeof item.link === "string" && item.link.startsWith("/") ? item.link.slice(0, 500) : null,
  };
}

/** The Aviasales page for a price (with our partner ID once we have one). */
function aviasalesUrl(link, marker) {
  if (!link) return null;
  const url = new URL(link, "https://www.aviasales.com");
  if (marker) url.searchParams.set("marker", marker);
  return url.toString();
}

module.exports = { createTravelpayouts, aviasalesUrl, SourceError, normalize };
