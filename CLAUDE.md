# Notes for Claude

- This is the flight deals site at https://flights.plopza.com: email alerts
  for cheap round trips from small airports (SGF first). It's a ticket-hub
  project: the agents in `incatch/ticket-hub` plan, build, review and
  release changes to it. See README.md for how it works.
- The owner is a smart non-engineer. Explain in plain English.
- Never put API keys or secrets in the code. They live in AWS Secrets
  Manager (`flight-deals/*`), entered by the owner.
- Prices come from Google Flights through SearchApi (searchapi.io); the
  owner pays per search ($40/month for 10,000). Anything that searches must
  count its searches (`store.useSearches`) and stay within Admin → Settings'
  daily limits. (Travelpayouts was tried first and had almost no US prices.)
- The owner's rules for alerts: no basic economy ever (not even labeled),
  no overnight connections (long flights are fine), at most one stop each
  way. Every email needs the mailing address, a settings link and one-click
  unsubscribe (CAN-SPAM). Nobody gets emails without confirming by click.
- Run `npm test` (needs PostgreSQL; see README.md) before finishing.
