# Flight Deals

Email alerts for great round-trip prices from small airports (starting with
Springfield, MO — SGF) to popular places. Live at https://flights.plopza.com.

## How it works

All prices come from **Google Flights**, through **SearchApi** (searchapi.io).

1. **Scan** (6 am and 6 pm Central, set in Admin → Settings). SearchApi's
   *calendar* search returns Google Flights' date grid: round-trip prices
   for one week of departures (Monday–Sunday) against returns from that
   Wednesday to the next, in one search. Each route has 23 such weeks
   (2 weeks to 6 months out). Each scan does its share of the day's
   "calendar searches per day" (Admin → Settings), starting with the
   route-weeks scanned longest ago, so with about 250 a day every route and
   week is refreshed about every 3 days. It keeps:
   - weekend trips (out Thursday/Friday, back Sunday/Monday) and 4–7 night trips;
   - at most one stop each way.
2. **Is it a deal?** "Normal" for a route is the middle price seen in the
   last 45 days. A deal is at least 30% below normal (once a route has 20
   prices on record), or at/under the destination's "Deal under $" limit.
3. **Double-check** with a full Google Flights search for those dates (1–2
   searches): the price must still be there with no basic economy and no
   overnight connections. Google's own "low / typical / high" rating also
   counts.
4. **Email** confirmed deals right away to subscribers of that airport (at
   most 3 emails a week each, and the same route again only if it's 5%+
   cheaper), plus a weekly roundup on Sunday afternoons.

Sign-up needs only an email address, confirmed by a click. Every email has
one-click unsubscribe, a settings link and the mailing address (Admin →
Settings), as US law requires.

Admin (https://flights.plopza.com/admin) uses the household sign-in:
airports, destinations and price limits, settings, deals found, scans, and
"Check a route" to see Google Flights' prices for one route and week (with
what SearchApi sent back, for checking details).

## The price service's key

SearchApi's API key is kept in AWS Secrets Manager (never in the code), as
`flight-deals/searchapi-key`, pasted in by the owner: AWS console →
**Secrets Manager** → the secret → **Retrieve secret value** → **Edit** →
replace `not-set` with the key (plain text) → **Save**. The site picks it up
within 5 minutes. Scanning stays paused until Admin → Settings → "calendar
searches per day" is above 0.

## Running it on your computer

Needs Node.js 22 and PostgreSQL.

    npm install
    DATABASE_URL=postgres://postgres@localhost/flights APP_SECRET=$(openssl rand -hex 32) \
      OWNER_EMAIL=you@example.com LOCAL_ADMIN=yes SCHEDULER=off npm start

Emails are printed instead of sent. Add `SEARCHAPI_KEY=…` to use real prices.

Tests: `npm test` (uses the database in `DATABASE_URL`, default
`postgres://postgres@127.0.0.1:55432/flights_test`, and wipes it).

## AWS

`infra/` is the AWS setup (CDK). It shares ticket-hub's network, load
balancer and database server (see incatch/ticket-hub). Merging to `main`
deploys it (GitHub Actions → Deploy, as the `flights-github-deploy` role).
