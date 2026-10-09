-- An overnight connection is only skipped when it's long (hours in an
-- airport overnight); a red-eye with a short change of planes is fine.
insert into settings (key, value) values ('max_overnight_layover_hours', '3') on conflict (key) do nothing;
