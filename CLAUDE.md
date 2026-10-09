# Notes for Claude

- This is the flight deals site at https://flights.plopza.com: email alerts
  for cheap round trips from small airports (SGF first). It's a ticket-hub
  project: the agents in `incatch/ticket-hub` plan, build, review and
  release changes to it. See README.md for how it works.
- The owner is a smart non-engineer. Explain in plain English.
- Never put API keys or secrets in the code. They live in AWS Secrets
  Manager (`flight-deals/*`), entered by the owner.
- The owner's rules for alerts: no basic economy ever (not even labeled),
  no overnight connections (long flights are fine), at most one stop each
  way. Every email needs the mailing address, a settings link and one-click
  unsubscribe (CAN-SPAM). Nobody gets emails without confirming by click.
- The SerpApi plan is small: anything that uses Google Flights searches must
  stay within Admin → Settings' daily limit.
- Run `npm test` (needs PostgreSQL; see README.md) before finishing.
