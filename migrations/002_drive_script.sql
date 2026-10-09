-- Travelpayouts' "Drive" script, only while their account setup checks the
-- site for it (Admin → Settings). Empty = not on the site.
insert into settings (key, value) values ('drive_script', '') on conflict (key) do nothing;
