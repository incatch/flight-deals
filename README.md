# Flight Deals

Email alerts for great round-trip prices from small airports (starting with
Springfield, MO — SGF) to popular places. Live at https://flights.plopza.com.

## How it works

1. **Scan** (6 am and 6 pm Central, set in Admin → Settings). For each
   airport and destination, the site asks **Travelpayouts** (Aviasales'
   partner program, free) for the cheapest round trips other travelers found
   in recent days, for every month from 2 weeks to 6 months out. It keeps:
   - weekend trips (out Thursday/Friday, back Sunday/Monday) and 4–7 night trips;
   - at most one stop each way.
2. **Is it a deal?** "Normal" for a route is the middle price seen in the
   last 45 days. A deal is at least 30% below normal (once a route has 20
   prices on record), or at/under the destination's "Deal under $" limit.
3. **Double-check** on **Google Flights** (through SerpApi), live, for the
   best few deals a day: the price must still be there, with no basic
   economy and no overnight connections. Google's own "low / typical / high"
   rating also counts.
4. **Email** confirmed deals right away to subscribers of that airport (at
   most 3 emails a week each, and the same route again only if it's 5%+
   cheaper), plus a weekly roundup on Sunday afternoons.

Sign-up needs only an email address, confirmed by a click. Every email has
one-click unsubscribe, a settings link and the mailing address (Admin →
Settings), as US law requires.

Admin (https://flights.plopza.com/admin) uses the household sign-in:
airports, destinations and price limits, settings, deals found, scans, and
"Check a route" to see what the price services say about one route.

## The price services' keys

Kept in AWS Secrets Manager (never in the code), pasted in by the owner:

- `flight-deals/travelpayouts-token`: from travelpayouts.com → Profile → API token.
- `flight-deals/serpapi-key`: from serpapi.com → Your account → API key.

AWS console → **Secrets Manager** → the secret → **Retrieve secret value** →
**Edit** → replace `not-set` with the key (plain text) → **Save**. The site
picks it up within 5 minutes.

## Running it on your computer

Needs Node.js 22 and PostgreSQL.

    npm install
    DATABASE_URL=postgres://postgres@localhost/flights APP_SECRET=$(openssl rand -hex 32) \
      OWNER_EMAIL=you@example.com LOCAL_ADMIN=yes SCHEDULER=off npm start

Emails are printed instead of sent. Add `TRAVELPAYOUTS_TOKEN=…` /
`SERPAPI_KEY=…` to use the real price services.

Tests: `npm test` (uses the database in `DATABASE_URL`, default
`postgres://postgres@127.0.0.1:55432/flights_test`, and wipes it).

## AWS

`infra/` is the AWS setup (CDK). It shares ticket-hub's network, load
balancer and database server (see incatch/ticket-hub). Merging to `main`
deploys it (GitHub Actions → Deploy, as the `flights-github-deploy` role).
