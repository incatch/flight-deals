-- The flight deals site: airports, prices seen, deals found, subscribers.

-- Site-wide settings, changed in Admin → Settings.
create table settings (
  key text primary key,
  value text not null
);
insert into settings (key, value) values
  ('site_name', 'Flight Deals'),
  -- Required in every email (US CAN-SPAM law).
  ('mailing_address', '209 Meadowlark, Willard, MO 65781'),
  -- A deal is a price at least this many percent below normal for the route...
  ('deal_percent', '30'),
  -- ...judged once we've seen at least this many prices on the route.
  ('min_history', '20'),
  -- When the scanner runs (hours of the day, site time zone).
  ('scan_hours', '6,18'),
  -- Google Flights double-checks per day (each uses up to 2 SerpApi searches).
  ('max_checks_per_day', '4'),
  -- Only email deals Google Flights has confirmed (no basic economy, no
  -- overnight connections, price still there).
  ('require_check', 'true'),
  -- At most this many deal alert emails per subscriber per 7 days.
  ('max_alerts_per_week', '3'),
  -- Travelpayouts partner ID ("marker"), added to Aviasales links once approved.
  ('affiliate_marker', '');

-- Small airports people fly from.
create table origins (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into origins (code, name) values ('SGF', 'Springfield, MO');

-- Popular places people want to go.
create table destinations (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  name text not null,
  region text not null check (region in ('us', 'caribbean', 'europe', 'other')),
  -- Inside the US (incl. Hawaii, Puerto Rico): Google Flights can leave out
  -- basic economy for these.
  domestic boolean not null default false,
  -- Airports to ask Google Flights about when the code is a city (NYC → JFK,LGA,EWR).
  google_codes text,
  -- Always a deal at or under this round-trip price (optional).
  max_price integer check (max_price > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into destinations (code, name, region, domestic, google_codes) values
  ('LAS', 'Las Vegas', 'us', true, null),
  ('MCO', 'Orlando', 'us', true, null),
  ('TPA', 'Tampa', 'us', true, null),
  ('MIA', 'Miami', 'us', true, null),
  ('FLL', 'Fort Lauderdale', 'us', true, null),
  ('DEN', 'Denver', 'us', true, null),
  ('PHX', 'Phoenix', 'us', true, null),
  ('LAX', 'Los Angeles', 'us', true, null),
  ('SAN', 'San Diego', 'us', true, null),
  ('SFO', 'San Francisco', 'us', true, null),
  ('SEA', 'Seattle', 'us', true, null),
  ('NYC', 'New York', 'us', true, 'JFK,LGA,EWR'),
  ('BOS', 'Boston', 'us', true, null),
  ('WAS', 'Washington, DC', 'us', true, 'DCA,IAD,BWI'),
  ('CHI', 'Chicago', 'us', true, 'ORD,MDW'),
  ('BNA', 'Nashville', 'us', true, null),
  ('MSY', 'New Orleans', 'us', true, null),
  ('HNL', 'Honolulu', 'us', true, null),
  ('OGG', 'Maui', 'us', true, null),
  ('SJU', 'San Juan, Puerto Rico', 'caribbean', true, null),
  ('CUN', 'Cancún', 'caribbean', false, null),
  ('SJD', 'Los Cabos', 'caribbean', false, null),
  ('PVR', 'Puerto Vallarta', 'caribbean', false, null),
  ('PUJ', 'Punta Cana', 'caribbean', false, null),
  ('MBJ', 'Montego Bay, Jamaica', 'caribbean', false, null),
  ('NAS', 'Nassau, Bahamas', 'caribbean', false, null),
  ('AUA', 'Aruba', 'caribbean', false, null),
  ('LON', 'London', 'europe', false, 'LHR,LGW'),
  ('PAR', 'Paris', 'europe', false, 'CDG,ORY'),
  ('ROM', 'Rome', 'europe', false, 'FCO'),
  ('BCN', 'Barcelona', 'europe', false, null),
  ('DUB', 'Dublin', 'europe', false, null),
  ('AMS', 'Amsterdam', 'europe', false, null),
  ('LIS', 'Lisbon', 'europe', false, null);

-- Each run of the scanner.
create table scans (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  -- e.g. "Checked 33 routes, 1,204 prices, 3 deals"
  summary text,
  error text
);

-- Every price the scanner has seen (kept 120 days): the history that says
-- what "normal" is for a route.
create table fares (
  id bigserial primary key,
  scan_id bigint references scans (id) on delete set null,
  origin text not null,
  destination text not null,
  depart_date date not null,
  return_date date not null,
  price integer not null check (price > 0),
  stops_out integer not null default 0,
  stops_back integer not null default 0,
  airline text,
  link text,
  seen_at timestamptz not null default now()
);
create index fares_route on fares (origin, destination, seen_at);

-- Good prices the scanner found, and what the Google Flights check said.
create table deals (
  id bigserial primary key,
  scan_id bigint references scans (id) on delete set null,
  origin text not null,
  destination text not null,
  depart_date date not null,
  return_date date not null,
  -- The price from the scan (recent searches)...
  found_price integer not null,
  -- ...and from Google Flights, if it was checked.
  checked_price integer,
  normal_price integer,
  -- Google's own rating of the price: low / typical / high.
  price_level text,
  airline text,
  -- e.g. "Nonstop" or "1 stop (DFW)"
  stops_text text,
  book_url text,
  -- confirmed: emailed and shown; rejected: the check didn't hold up;
  -- unchecked: not checked yet (no Google Flights key, or the day's checks used up).
  status text not null check (status in ('confirmed', 'rejected', 'unchecked')),
  reason text,
  found_at timestamptz not null default now()
);
create index deals_recent on deals (origin, found_at);

-- People who want alerts, one row per email and airport.
create table subscribers (
  id bigserial primary key,
  email text not null check (email = lower(email)),
  origin text not null references origins (code) on update cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'unsubscribed')),
  -- In the links in every email (confirm, settings, unsubscribe).
  token text not null unique,
  instant boolean not null default true,
  weekly boolean not null default true,
  created_at timestamptz not null default now(),
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  unique (email, origin)
);

-- Which deals went to whom.
create table alerts_sent (
  id bigserial primary key,
  subscriber_id bigint not null references subscribers (id) on delete cascade,
  deal_id bigint references deals (id) on delete set null,
  kind text not null check (kind in ('instant', 'weekly')),
  -- The same for every deal in one email.
  email_id text not null,
  origin text not null,
  destination text not null,
  price integer not null,
  sent_at timestamptz not null default now()
);
create index alerts_sent_by_subscriber on alerts_sent (subscriber_id, sent_at);

-- Google Flights (SerpApi) searches used per day, to stay inside the plan.
create table check_usage (
  day date primary key,
  searches integer not null default 0
);

-- When the background jobs last ran (so a restart doesn't run them twice).
create table job_runs (
  job text primary key,
  last_run_at timestamptz not null
);
