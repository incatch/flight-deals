-- Prices now come from Google Flights through SearchApi (Travelpayouts had
-- almost no prices for US routes, and SerpApi has no date-grid search).

-- Travelpayouts is gone.
delete from settings where key in ('affiliate_marker', 'drive_script');

-- Calendar searches the scanner may use per day (0 = scanning paused).
insert into settings (key, value) values ('searches_per_day', '0') on conflict (key) do nothing;

-- SearchApi searches used, per day and kind ("calendar" for the scan,
-- "check" for the double-checks), to stay inside the plan.
drop table check_usage;
create table api_usage (
  day date not null,
  kind text not null check (kind in ('calendar', 'check')),
  searches integer not null default 0,
  primary key (day, kind)
);

-- When each route's week of departures was last scanned: each scan does
-- the ones scanned longest ago (or never).
create table scan_slots (
  origin text not null,
  destination text not null,
  week_start date not null,
  last_scanned_at timestamptz not null,
  primary key (origin, destination, week_start)
);

-- Fares from the calendar don't link anywhere.
alter table fares drop column link;
