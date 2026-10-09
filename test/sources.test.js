const test = require("node:test");
const assert = require("node:assert/strict");
const { createTravelpayouts, aviasalesUrl, SourceError } = require("../lib/sources/travelpayouts");
const { createSerpApi, isBasicEconomy } = require("../lib/sources/serpapi");

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const next = responses.shift();
    return { ok: next.status === undefined || next.status < 400, status: next.status || 200, json: async () => next.body };
  };
  return { fetch, calls };
}

test("Travelpayouts: asks for round trips in a month and tidies the answer", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        success: true,
        data: [
          { price: 189.4, airline: "AA", departure_at: "2026-11-12T06:00:00-06:00", return_at: "2026-11-15T18:00:00-08:00", transfers: 1, return_transfers: 0, link: "/search/SGF1211LAS15111?t=x" },
          { price: 210, departure_at: "2026-11-13T06:00:00-06:00" }, // no return: skipped
        ],
      },
    },
  ]);
  const tp = createTravelpayouts({ token: "tok", fetch });
  const fares = await tp.roundTrips({ origin: "SGF", destination: "LAS", month: "2026-11" });
  assert.deepEqual(fares, [
    { departDate: "2026-11-12", returnDate: "2026-11-15", price: 189, stopsOut: 1, stopsBack: 0, airline: "AA", link: "/search/SGF1211LAS15111?t=x" },
  ]);
  const { url, options } = calls[0];
  assert.equal(url.searchParams.get("origin"), "SGF");
  assert.equal(url.searchParams.get("departure_at"), "2026-11");
  assert.equal(url.searchParams.get("one_way"), "false");
  assert.equal(url.searchParams.get("currency"), "usd");
  assert.equal(url.searchParams.get("token"), null, "the token goes in a header, not the address");
  assert.equal(options.headers["x-access-token"], "tok");
});

test("Travelpayouts: a refused token is an error", async () => {
  const { fetch } = fakeFetch([{ status: 401, body: {} }]);
  await assert.rejects(createTravelpayouts({ token: "bad", fetch }).roundTrips({ origin: "SGF", destination: "LAS", month: "2026-11" }), (err) => err instanceof SourceError && /refused/.test(err.message));
});

test("Aviasales links get the partner ID", () => {
  assert.equal(aviasalesUrl("/search/X?t=1", ""), "https://www.aviasales.com/search/X?t=1");
  assert.equal(aviasalesUrl("/search/X?t=1", "123"), "https://www.aviasales.com/search/X?t=1&marker=123");
  assert.equal(aviasalesUrl(null, "123"), null);
});

const option = (price, extra = {}) => ({
  price,
  flights: [{ airline: "American", travel_class: "Economy", extensions: [] }],
  layovers: [],
  departure_token: `dep-${price}`,
  ...extra,
});

test("Google Flights: picks the cheapest flights out and back without overnight connections or basic economy", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        search_metadata: { google_flights_url: "https://g/out" },
        price_insights: { price_level: "low", typical_price_range: [300, 450] },
        best_flights: [option(150, { layovers: [{ id: "DFW", overnight: true }] }), option(170, { flights: [{ airline: "X", travel_class: "Basic Economy" }] })],
        other_flights: [option(199, { layovers: [{ id: "DFW", duration: 60 }] }), option(240)],
      },
    },
    {
      body: {
        search_metadata: { google_flights_url: "https://g/back" },
        best_flights: [option(199, { booking_token: "b1", departure_token: undefined })],
      },
    },
  ]);
  const result = await createSerpApi({ apiKey: "k", fetch }).check({ origin: "SGF", arrival: "LAS", departDate: "2026-11-12", returnDate: "2026-11-15", domestic: true });
  assert.equal(result.ok, true);
  assert.equal(result.price, 199);
  assert.equal(result.priceLevel, "low");
  assert.equal(result.stopsText, "Out: 1 stop (DFW) · Back: Nonstop");
  assert.equal(result.url, "https://g/back");
  assert.equal(result.searches, 2);
  assert.equal(calls[0].url.searchParams.get("exclude_basic"), "true", "US trips ask Google to leave out basic economy");
  assert.equal(calls[0].url.searchParams.get("stops"), "2");
  assert.equal(calls[1].url.searchParams.get("departure_token"), "dep-199");
});

test("Google Flights: says why when nothing qualifies, and doesn't ask for exclude_basic abroad", async () => {
  const { fetch, calls } = fakeFetch([{ body: { best_flights: [option(150, { layovers: [{ id: "JFK", overnight: true }] })] } }]);
  const result = await createSerpApi({ apiKey: "k", fetch }).check({ origin: "SGF", arrival: "LHR,LGW", departDate: "2026-11-12", returnDate: "2026-11-18", domestic: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /overnight/);
  assert.equal(calls[0].url.searchParams.get("exclude_basic"), null);
  assert.equal(calls.length, 1);
});

test("basic economy is spotted wherever Google mentions it", () => {
  assert.equal(isBasicEconomy({ flights: [{ travel_class: "Economy", extensions: ["Basic economy: no carry-on"] }] }), true);
  assert.equal(isBasicEconomy({ extensions: ["Basic Economy"], flights: [] }), true);
  assert.equal(isBasicEconomy({ flights: [{ travel_class: "Economy", extensions: ["Wi-Fi for a fee"] }] }), false);
});
