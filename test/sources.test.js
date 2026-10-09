const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchApi, isBasicEconomy, googleFlightsUrl, dollars, SourceError } = require("../lib/sources/searchapi");

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(new URL(url));
    const next = responses.shift();
    return { ok: next.status === undefined || next.status < 400, status: next.status || 200, json: async () => next.body };
  };
  return { fetch, calls };
}

const window = { outboundStart: "2026-11-09", outboundEnd: "2026-11-15", returnStart: "2026-11-11", returnEnd: "2026-11-18" };

test("calendar: asks Google Flights' date grid for a week of departures and tidies the answer", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        calendar: [
          { departure: "2026-11-12", return: "2026-11-16", price: 189, is_lowest_price: true },
          { departure: "2026-11-13", return: "2026-11-16", price: "$1,204" },
          { departure: "2026-11-14", return: "2026-11-17", has_no_flights: true },
          { departure: "2026-11-15", price: 99 }, // no return date: skipped
        ],
      },
    },
  ]);
  const { fares } = await createSearchApi({ apiKey: "k", fetch }).calendar({ origin: "SGF", arrival: "LAS", ...window });
  assert.deepEqual(fares, [
    { departDate: "2026-11-12", returnDate: "2026-11-16", price: 189, stopsOut: 0, stopsBack: 0 },
    { departDate: "2026-11-13", returnDate: "2026-11-16", price: 1204, stopsOut: 0, stopsBack: 0 },
  ]);
  const url = calls[0];
  assert.equal(url.origin + url.pathname, "https://www.searchapi.io/api/v1/search");
  assert.equal(url.searchParams.get("engine"), "google_flights_calendar");
  assert.equal(url.searchParams.get("flight_type"), "round_trip");
  assert.equal(url.searchParams.get("outbound_date_start"), "2026-11-09");
  assert.equal(url.searchParams.get("outbound_date_end"), "2026-11-15");
  assert.equal(url.searchParams.get("return_date_start"), "2026-11-11");
  assert.equal(url.searchParams.get("return_date_end"), "2026-11-18");
  assert.equal(url.searchParams.get("stops"), "one_stop_or_fewer");
  assert.equal(url.searchParams.get("currency"), "USD");
});

test("calendar: a refused key or an error message is an error", async () => {
  let { fetch } = fakeFetch([{ status: 401, body: { error: "Invalid API key" } }]);
  await assert.rejects(createSearchApi({ apiKey: "bad", fetch }).calendar({ origin: "SGF", arrival: "LAS", ...window }), (err) => err instanceof SourceError && /refused/.test(err.message));
  ({ fetch } = fakeFetch([{ body: { error: "Unsupported arrival_id" } }]));
  await assert.rejects(createSearchApi({ apiKey: "k", fetch }).calendar({ origin: "SGF", arrival: "XXX", ...window }), /Unsupported arrival_id/);
});

const option = (price, extra = {}) => ({
  price,
  flights: [{ airline: "American", travel_class: "Economy", extensions: [] }],
  layovers: [],
  departure_token: `dep-${price}`,
  ...extra,
});

test("full check: the cheapest flights out and back without overnight connections or basic economy", async () => {
  const { fetch, calls } = fakeFetch([
    {
      body: {
        price_insights: { price_level: "low", typical_price_range: [300, 450] },
        best_flights: [option(150, { layovers: [{ id: "DFW", overnight: true }] }), option(170, { flights: [{ airline: "X", travel_class: "Basic Economy" }] })],
        other_flights: [option(199, { layovers: [{ id: "DFW", duration: 60 }] }), option(240)],
      },
    },
    { body: { best_flights: [option(199, { booking_token: "b1", departure_token: undefined })] } },
  ]);
  const result = await createSearchApi({ apiKey: "k", fetch }).check({ origin: "SGF", arrival: "LAS", destination: "Las Vegas", departDate: "2026-11-12", returnDate: "2026-11-15", domestic: true });
  assert.equal(result.ok, true);
  assert.equal(result.price, 199);
  assert.equal(result.priceLevel, "low");
  assert.deepEqual(result.typicalRange, [300, 450]);
  assert.equal(result.stopsText, "Out: 1 stop (DFW) · Back: Nonstop");
  assert.equal(result.url, googleFlightsUrl({ origin: "SGF", destination: "Las Vegas", departDate: "2026-11-12", returnDate: "2026-11-15" }));
  assert.equal(result.searches, 2);
  // Every option looked at, cheapest first, with why it was skipped.
  assert.deepEqual(result.options.out.map((o) => [o.price, o.stops, o.problem]), [
    [150, "1 stop (DFW)", "an overnight connection"],
    [170, "Nonstop", "basic economy"],
    [199, "1 stop (DFW)", null],
    [240, "Nonstop", null],
  ]);
  assert.deepEqual(result.options.back, [{ airline: "American", price: 199, stops: "Nonstop", problem: null }]);
  assert.ok(result.raw.outbound && result.raw.back);
  assert.equal(calls[0].searchParams.get("engine"), "google_flights");
  assert.equal(calls[0].searchParams.get("exclude_basic_economy"), "true", "US trips ask Google to leave out basic economy");
  assert.equal(calls[1].searchParams.get("departure_token"), "dep-199");
});

test("full check: says why when nothing qualifies, and doesn't ask for exclude_basic_economy abroad", async () => {
  const { fetch, calls } = fakeFetch([{ body: { best_flights: [option(150, { layovers: [{ id: "JFK", overnight: true }] })] } }]);
  const result = await createSearchApi({ apiKey: "k", fetch }).check({ origin: "SGF", arrival: "LHR,LGW", departDate: "2026-11-12", returnDate: "2026-11-18", domestic: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /overnight/);
  assert.equal(calls[0].searchParams.get("exclude_basic_economy"), null);
  assert.equal(calls.length, 1);
});

test("full check: flights Google shows without a price are listed, not used", async () => {
  const { fetch } = fakeFetch([
    { body: { best_flights: [option(214)] } },
    { body: { best_flights: [{ ...option(null, { flights: [{ airline: "Allegiant" }] }), price: undefined }] } },
  ]);
  const result = await createSearchApi({ apiKey: "k", fetch }).check({ origin: "SGF", arrival: "LAS", departDate: "2026-11-09", returnDate: "2026-11-13", domestic: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no price shown/);
  assert.deepEqual(result.options.back, [{ airline: "Allegiant", price: null, stops: "Nonstop", problem: "no price shown on Google Flights" }]);
});

test("basic economy is spotted wherever Google mentions it", () => {
  assert.equal(isBasicEconomy({ flights: [{ travel_class: "Economy", extensions: ["Basic economy: no carry-on"] }] }), true);
  assert.equal(isBasicEconomy({ extensions: ["Basic Economy"], flights: [] }), true);
  assert.equal(isBasicEconomy({ flights: [{ travel_class: "Economy", extensions: ["Wi-Fi for a fee"] }] }), false);
});

test("prices and Google Flights links", () => {
  assert.equal(dollars("$1,204"), 1204);
  assert.equal(dollars(189.6), 190);
  assert.equal(dollars(null), null);
  assert.equal(
    googleFlightsUrl({ origin: "SGF", destination: "Las Vegas", departDate: "2026-11-12", returnDate: "2026-11-15" }),
    "https://www.google.com/travel/flights?q=Flights%20from%20SGF%20to%20Las%20Vegas%20on%202026-11-12%20through%202026-11-15&curr=USD&hl=en",
  );
});
