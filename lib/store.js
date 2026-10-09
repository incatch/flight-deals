// Everything the site keeps in the database.

const crypto = require("crypto");

class InputError extends Error {}

const SETTINGS = {
  site_name: { type: "text", max: 60 },
  mailing_address: { type: "text", max: 200 },
  deal_percent: { type: "int", min: 5, max: 90 },
  min_history: { type: "int", min: 1, max: 1000 },
  scan_hours: { type: "hours" },
  max_checks_per_day: { type: "int", min: 0, max: 500 },
  require_check: { type: "bool" },
  max_alerts_per_week: { type: "int", min: 1, max: 50 },
  searches_per_day: { type: "int", min: 0, max: 5000 },
};

function parseSetting(key, raw) {
  const spec = SETTINGS[key];
  if (spec.type === "int") return Number(raw);
  if (spec.type === "bool") return raw === "true";
  if (spec.type === "hours") return raw.split(",").filter(Boolean).map(Number);
  return raw;
}

function checkSetting(key, value) {
  const spec = SETTINGS[key];
  const text = String(value ?? "").trim();
  switch (spec.type) {
    case "text":
      if (!text || text.length > spec.max) throw new InputError(`Please fill in ${key.replace(/_/g, " ")} (up to ${spec.max} characters).`);
      return text;
    case "int": {
      const n = Number(text);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new InputError(`${key.replace(/_/g, " ")} must be a whole number from ${spec.min} to ${spec.max}.`);
      return String(n);
    }
    case "bool":
      return value === true || value === "true" || value === "on" ? "true" : "false";
    case "hours": {
      const hours = [...new Set(text.split(/[\s,]+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
      if (!hours.length || hours.length > 6 || hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
        throw new InputError("Scan times must be 1–6 hours of the day from 0 to 23, e.g. 6, 18.");
      }
      return hours.join(",");
    }
  }
  throw new Error(`unknown setting ${key}`);
}

const CODE = /^[A-Z]{3}$/;
function airportCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!CODE.test(code)) throw new InputError("Airport codes are 3 letters, e.g. SGF.");
  return code;
}
function googleCodes(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const codes = text.split(/[\s,]+/).filter(Boolean);
  if (codes.length > 5 || codes.some((c) => !CODE.test(c))) throw new InputError("Google Flights airports must be up to 5 three-letter codes, e.g. JFK, LGA, EWR.");
  return codes.join(",");
}
function placeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 60) throw new InputError("Please give the place a name (up to 60 characters).");
  return name;
}
function optionalPrice(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text.replace(/[$,]/g, ""));
  if (!Number.isInteger(n) || n < 1 || n > 20000) throw new InputError("A price limit must be a whole number of dollars.");
  return n;
}
const REGIONS = ["us", "caribbean", "europe", "other"];

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/;
function normalEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 200 || !EMAIL.test(email)) throw new InputError("Please enter a valid email address.");
  return email;
}

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function createStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    // ── Settings ──────────────────────────────────────────────────────────
    async settings() {
      const { rows } = await q("select key, value from settings");
      const out = {};
      for (const { key, value } of rows) if (SETTINGS[key]) out[key] = parseSetting(key, value);
      return out;
    },
    async saveSettings(values) {
      const checked = Object.entries(values)
        .filter(([key]) => SETTINGS[key])
        .map(([key, value]) => [key, checkSetting(key, value)]);
      for (const [key, value] of checked) {
        await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = $2", [key, value]);
      }
    },

    // ── Airports ──────────────────────────────────────────────────────────
    async origins({ activeOnly = false } = {}) {
      return (await q(`select * from origins ${activeOnly ? "where active" : ""} order by code`)).rows;
    },
    async origin(code) {
      return one("select * from origins where code = $1", [String(code || "").toUpperCase()]);
    },
    async addOrigin({ code, name }) {
      code = airportCode(code);
      name = placeName(name);
      const added = await one("insert into origins (code, name) values ($1, $2) on conflict (code) do nothing returning *", [code, name]);
      if (!added) throw new InputError(`${code} is already on the list.`);
      return added;
    },
    async updateOrigin(code, { name, active }) {
      await q("update origins set name = $2, active = $3 where code = $1", [airportCode(code), placeName(name), Boolean(active)]);
    },

    /** Removes a "from" airport — only if nobody ever signed up for it (otherwise turn it off). */
    async deleteOrigin(code) {
      code = airportCode(code);
      const { n } = await one("select count(*)::int as n from subscribers where origin = $1", [code]);
      if (n) throw new InputError(`${code} has ${n} subscriber${n === 1 ? "" : "s"} (including unconfirmed and unsubscribed), so it can't be removed. Untick "Scanning" to turn it off instead.`);
      await q("delete from scan_slots where origin = $1", [code]);
      await q("delete from origins where code = $1", [code]);
    },

    async destinations({ activeOnly = false } = {}) {
      return (await q(`select * from destinations ${activeOnly ? "where active" : ""} order by region = 'us' desc, region, name`)).rows;
    },
    async destination(code) {
      return one("select * from destinations where code = $1", [String(code || "").toUpperCase()]);
    },
    async addDestination(values) {
      const code = airportCode(values.code);
      const added = await one(
        `insert into destinations (code, name, region, domestic, google_codes, max_price)
         values ($1, $2, $3, $4, $5, $6) on conflict (code) do nothing returning *`,
        [code, placeName(values.name), region(values.region), Boolean(values.domestic), googleCodes(values.google_codes), optionalPrice(values.max_price)],
      );
      if (!added) throw new InputError(`${code} is already on the list.`);
      return added;
    },
    async updateDestination(code, values) {
      await q(
        `update destinations set name = $2, region = $3, domestic = $4, google_codes = $5, max_price = $6, active = $7 where code = $1`,
        [airportCode(code), placeName(values.name), region(values.region), Boolean(values.domestic), googleCodes(values.google_codes), optionalPrice(values.max_price), Boolean(values.active)],
      );
    },
    async deleteDestination(code) {
      await q("delete from scan_slots where destination = $1", [airportCode(code)]);
      await q("delete from destinations where code = $1", [airportCode(code)]);
    },

    // ── Scans and prices ─────────────────────────────────────────────────
    async startScan() {
      return one("insert into scans default values returning *");
    },
    async finishScan(id, summary) {
      await q("update scans set finished_at = now(), status = 'done', summary = $2 where id = $1", [id, summary]);
    },
    async failScan(id, error, summary = null) {
      await q("update scans set finished_at = now(), status = 'failed', error = $2, summary = $3 where id = $1", [id, String(error).slice(0, 2000), summary]);
    },
    async scans(limit = 20) {
      return (await q("select * from scans order by id desc limit $1", [limit])).rows;
    },
    /** A scan left "running" by a container that stopped part way. */
    async closeAbandonedScans() {
      await q("update scans set status = 'failed', finished_at = now(), error = 'Stopped part way (the site restarted).' where status = 'running' and started_at < now() - interval '2 hours'");
    },

    async addFares(scanId, origin, destination, fares) {
      if (!fares.length) return;
      await q(
        `insert into fares (scan_id, origin, destination, depart_date, return_date, price, stops_out, stops_back, airline)
         select $1, $2, $3, d, r, p, so, sb, a
           from unnest($4::date[], $5::date[], $6::int[], $7::int[], $8::int[], $9::text[]) as t(d, r, p, so, sb, a)`,
        [
          scanId,
          origin,
          destination,
          fares.map((f) => f.departDate),
          fares.map((f) => f.returnDate),
          fares.map((f) => f.price),
          fares.map((f) => f.stopsOut),
          fares.map((f) => f.stopsBack),
          fares.map((f) => f.airline || null),
        ],
      );
    },
    /** What's normal on a route: the middle price seen in the last 45 days. */
    async routeHistory(origin, destination) {
      const row = await one(
        `select count(*)::int as count, round(percentile_cont(0.5) within group (order by price))::int as normal
           from fares where origin = $1 and destination = $2 and seen_at > now() - interval '45 days'`,
        [origin, destination],
      );
      return { count: row.count, normal: row.normal };
    },
    async pruneFares() {
      await q("delete from fares where seen_at < now() - interval '120 days'");
    },

    // ── Deals ─────────────────────────────────────────────────────────────
    /** The lowest price we've already recorded a deal at for this trip this week. */
    async recentDealPrice({ origin, destination, departDate, returnDate }) {
      const row = await one(
        `select min(coalesce(checked_price, found_price))::int as price from deals
          where origin = $1 and destination = $2 and depart_date = $3 and return_date = $4
            and found_at > now() - interval '7 days'`,
        [origin, destination, departDate, returnDate],
      );
      return row.price;
    },
    async addDeal(d) {
      return one(
        `insert into deals (scan_id, origin, destination, depart_date, return_date, found_price, checked_price, normal_price,
                            price_level, airline, stops_text, book_url, status, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
        [d.scanId, d.origin, d.destination, d.departDate, d.returnDate, d.foundPrice, d.checkedPrice ?? null, d.normalPrice ?? null,
          d.priceLevel ?? null, d.airline ?? null, d.stopsText ?? null, d.bookUrl ?? null, d.status, d.reason ?? null],
      );
    },
    /** Deals to show and send: confirmed (or, if checking is off, unchecked) and not yet departed. */
    async publicDeals(origin, { days = 30, includeUnchecked = false, since = null } = {}) {
      return (
        await q(
          `select d.*, dest.name as destination_name from deals d
             left join destinations dest on dest.code = d.destination
            where d.origin = $1 and d.found_at > coalesce($3::timestamptz, now() - make_interval(days => $2))
              and d.depart_date > current_date
              and (d.status = 'confirmed' or ($4 and d.status = 'unchecked'))
            order by d.found_at desc limit 100`,
          [origin, days, since, includeUnchecked],
        )
      ).rows;
    },
    async adminDeals(limit = 100) {
      return (
        await q(
          `select d.*, dest.name as destination_name from deals d
             left join destinations dest on dest.code = d.destination
            order by d.found_at desc limit $1`,
          [limit],
        )
      ).rows;
    },

    /** Records `n` SearchApi searches of `kind` ("calendar" or "check") on `day`. */
    async useSearches(day, kind, n) {
      if (!n) return;
      await q(
        `insert into api_usage (day, kind, searches) values ($1, $2, $3)
         on conflict (day, kind) do update set searches = api_usage.searches + $3`,
        [day, kind, n],
      );
    },
    /** Searches used on `day` (of one kind, or all). */
    async searchesUsed(day, kind = null) {
      return (await one("select coalesce(sum(searches), 0)::int as n from api_usage where day = $1 and ($2::text is null or kind = $2)", [day, kind])).n;
    },
    async searchesThisMonth(month) {
      return (await one("select coalesce(sum(searches), 0)::int as n from api_usage where to_char(day, 'YYYY-MM') = $1", [month])).n;
    },

    /**
     * The next `limit` route-weeks to scan, longest since last scanned (or
     * never) first: [{ origin, destination, week_start }] for active routes.
     */
    async dueSlots(weeks, limit) {
      if (!limit || !weeks.length) return [];
      return (
        await q(
          `select o.code as origin, d.code as destination, w::text as week_start
             from origins o cross join destinations d cross join unnest($1::date[]) as w
             left join scan_slots s on s.origin = o.code and s.destination = d.code and s.week_start = w
            where o.active and d.active and o.code <> d.code
            order by s.last_scanned_at nulls first, w, o.code, d.code
            limit $2`,
          [weeks, limit],
        )
      ).rows;
    },
    async markSlot(origin, destination, weekStart) {
      await q(
        `insert into scan_slots (origin, destination, week_start, last_scanned_at) values ($1, $2, $3, now())
         on conflict (origin, destination, week_start) do update set last_scanned_at = now()`,
        [origin, destination, weekStart],
      );
    },

    // ── Subscribers ──────────────────────────────────────────────────────
    /**
     * Signs `email` up for alerts from `origin`. Returns the subscriber and
     * whether to (re)send the confirmation email.
     */
    async subscribe(email, origin) {
      email = normalEmail(email);
      const airport = await one("select * from origins where code = $1 and active", [String(origin || "").toUpperCase()]);
      if (!airport) throw new InputError("Please pick an airport from the list.");
      const existing = await one("select * from subscribers where email = $1 and origin = $2", [email, airport.code]);
      if (!existing) {
        const sub = await one(
          "insert into subscribers (email, origin, token, confirm_sent_at) values ($1, $2, $3, now()) on conflict (email, origin) do nothing returning *",
          [email, airport.code, newToken()],
        );
        return { subscriber: sub, sendConfirm: Boolean(sub) };
      }
      if (existing.status === "active") return { subscriber: existing, sendConfirm: false };
      // Pending or unsubscribed: (re)send the confirmation, at most every 10 minutes.
      const sub = await one(
        `update subscribers set status = 'pending', confirm_sent_at = now()
          where id = $1 and (confirm_sent_at is null or confirm_sent_at < now() - interval '10 minutes') returning *`,
        [existing.id],
      );
      return { subscriber: sub || existing, sendConfirm: Boolean(sub) };
    },
    async subscriberByToken(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
      return one("select * from subscribers where token = $1", [token]);
    },
    async confirm(token) {
      return one(
        `update subscribers set status = 'active', confirmed_at = coalesce(confirmed_at, now()), unsubscribed_at = null
          where token = $1 and status = 'pending' returning *`,
        [token],
      );
    },
    async unsubscribe(token) {
      return one("update subscribers set status = 'unsubscribed', unsubscribed_at = now() where token = $1 and status <> 'unsubscribed' returning *", [token]);
    },
    async savePreferences(token, { instant, weekly }) {
      return one(
        "update subscribers set instant = $2, weekly = $3, status = 'active', unsubscribed_at = null where token = $1 and status <> 'pending' returning *",
        [token, Boolean(instant), Boolean(weekly)],
      );
    },
    async subscriberCounts() {
      return (
        await q(
          `select o.code, o.name, o.active,
                  count(s.id) filter (where s.status = 'active')::int as active_count,
                  count(s.id) filter (where s.status = 'pending')::int as pending_count,
                  count(s.id) filter (where s.status = 'unsubscribed')::int as unsubscribed_count
             from origins o left join subscribers s on s.origin = o.code
            group by o.code order by o.code`,
        )
      ).rows;
    },
    async activeSubscribers(origin, kind) {
      const column = kind === "weekly" ? "weekly" : "instant";
      return (await q(`select * from subscribers where origin = $1 and status = 'active' and ${column} order by id`, [origin])).rows;
    },

    // ── Alerts sent ──────────────────────────────────────────────────────
    async instantAlertsSince(subscriberId, days) {
      // Counts emails (one email can carry several deals).
      return (
        await one(
          `select count(distinct email_id)::int as n from alerts_sent
            where subscriber_id = $1 and kind = 'instant' and sent_at > now() - make_interval(days => $2)`,
          [subscriberId, days],
        )
      ).n;
    },
    /** The lowest price this subscriber was told about for a route in the last 14 days. */
    async lastAlertPrice(subscriberId, origin, destination) {
      return (
        await one(
          `select min(price)::int as price from alerts_sent
            where subscriber_id = $1 and origin = $2 and destination = $3 and sent_at > now() - interval '14 days'`,
          [subscriberId, origin, destination],
        )
      ).price;
    },
    async recordAlerts(subscriberId, kind, deals) {
      const emailId = crypto.randomUUID();
      for (const d of deals) {
        await q(
          "insert into alerts_sent (subscriber_id, deal_id, kind, email_id, origin, destination, price) values ($1, $2, $3, $4, $5, $6, $7)",
          [subscriberId, d.id, kind, emailId, d.origin, d.destination, d.checked_price ?? d.found_price],
        );
      }
    },

    // ── Background jobs ──────────────────────────────────────────────────
    /** Claims a job's run at `at` for the slot starting at `slotStart` (true once per slot). */
    async claimJob(job, slotStart, at) {
      const row = await one(
        `insert into job_runs (job, last_run_at) values ($1, $3)
         on conflict (job) do update set last_run_at = $3 where job_runs.last_run_at < $2
         returning job`,
        [job, slotStart, at],
      );
      return Boolean(row);
    },
  };
}

function region(value) {
  if (!REGIONS.includes(value)) throw new InputError("Please pick a region.");
  return value;
}

module.exports = { createStore, InputError, normalEmail, REGIONS };
