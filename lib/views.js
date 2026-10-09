// The site's pages, as HTML.

const { describeDeal } = require("./alerts");
const { REGIONS } = require("./store");

const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout({ title, siteName, body, admin = null, headScript = "" }) {
  const nav = admin
    ? `<nav class="admin-nav">
  <a href="/admin">Overview</a> <a href="/admin/deals">Deals</a> <a href="/admin/airports">Airports</a>
  <a href="/admin/check">Check a route</a> <a href="/admin/settings">Settings</a>
  <span class="who">${h(admin.email)}${admin.signOutUrl ? ` · <a href="${h(admin.signOutUrl)}">Sign out</a>` : ""}</span>
</nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title ? `${title} · ${siteName}` : siteName)}</title>
<link rel="stylesheet" href="/static/style.css">
${headScript ? `<script async src="${h(headScript)}"></script>\n` : ""}</head>
<body${admin ? ' class="admin"' : ""}>
<header class="top"><a class="brand" href="${admin ? "/admin" : "/"}">✈ ${h(siteName)}</a>${admin ? ' <span class="badge">Admin</span>' : ""}</header>
${nav}
<main>
${body}
</main>
</body>
</html>`;
}

function errorBox(error) {
  return error ? `<p class="error" role="alert">${h(error)}</p>` : "";
}
function noticeBox(notice) {
  return notice ? `<p class="notice" role="status">${h(notice)}</p>` : "";
}

function dealCard(deal) {
  const d = describeDeal(deal);
  return `<article class="deal">
  <div class="deal-head"><span class="place">${h(d.place)}</span> <span class="price">${h(d.price)}</span> <span class="muted">round trip</span></div>
  ${d.note ? `<div class="good">${h(d.note)}</div>` : ""}
  <div>${h(d.dates)}</div>
  ${d.details ? `<div class="muted">${h(d.details)}</div>` : ""}
  ${d.url ? `<a class="button small" href="${h(d.url)}" rel="nofollow noopener" target="_blank">See flights</a>` : ""}
</article>`;
}

// ── Public pages ─────────────────────────────────────────────────────────

function homePage({ settings, origins, selected, deals, error = null, email = "" }) {
  const options = origins
    .map((o) => `<option value="${h(o.code)}"${o.code === selected?.code ? " selected" : ""}>${h(o.code)} · ${h(o.name)}</option>`)
    .join("");
  const list = deals.length
    ? deals.map(dealCard).join("\n")
    : `<p class="muted">No deals in the last 30 days yet. We check prices twice a day; sign up and we'll email you when one turns up.</p>`;
  return layout({
    siteName: settings.site_name,
    // Travelpayouts' Drive script, if switched on in Admin → Settings: only
    // on the home page, never on pages whose address carries someone's link.
    headScript: settings.drive_script,
    body: `<section class="hero">
  <h1>Cheap flights from your small airport</h1>
  <p>We check prices from small airports to popular places every day, for dates up to six months out, and email you when a round trip is a real bargain. Free.</p>
  ${errorBox(error)}
  <form method="post" action="/subscribe" class="signup">
    <label for="origin">Your airport</label>
    <select id="origin" name="origin" required>${options}</select>
    <label for="email">Your email</label>
    <input type="email" id="email" name="email" required maxlength="200" autocomplete="email" value="${h(email)}" placeholder="you@example.com">
    <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
    <button type="submit">Email me deals</button>
    <p class="hint">No basic economy, no overnight layovers. At most ${h(settings.max_alerts_per_week)} emails a week, and you can unsubscribe any time.</p>
  </form>
</section>
<section>
  <h2>Recent deals from ${h(selected ? `${selected.code} (${selected.name})` : "your airport")}</h2>
  ${origins.length > 1 ? `<form method="get" action="/" class="inline"><select name="from" aria-label="Airport">${options}</select> <button type="submit" class="secondary small">Show</button></form>` : ""}
  ${list}
</section>
<footer class="foot muted">${h(settings.site_name)} · ${h(settings.mailing_address)}</footer>`,
  });
}

function messagePage({ settings, title, message, extra = "" }) {
  return layout({
    title,
    siteName: settings.site_name,
    body: `<section class="card narrow"><h1>${h(title)}</h1><p>${h(message)}</p>${extra}<p><a href="/">Back to ${h(settings.site_name)}</a></p></section>`,
  });
}

function confirmPage({ settings, sub }) {
  return layout({
    title: "Confirm",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>One more click</h1>
  <p>Send deal alerts for flights from <strong>${h(sub.origin)}</strong> to <strong>${h(sub.email)}</strong>?</p>
  <form method="post" action="/confirm/${h(sub.token)}"><button type="submit">Yes, send me deals</button></form>
</section>`,
  });
}

function preferencesPage({ settings, sub, notice = null }) {
  const off = sub.status === "unsubscribed";
  return layout({
    title: "Your alerts",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>Your alerts from ${h(sub.origin)}</h1>
  ${noticeBox(notice)}
  <p class="muted">For ${h(sub.email)}${off ? " — you're unsubscribed. Save below to start again." : ""}</p>
  <form method="post" action="/s/${h(sub.token)}">
    <label class="check"><input type="checkbox" name="instant"${sub.instant ? " checked" : ""}> Email me right away when there's a great deal (at most ${h(settings.max_alerts_per_week)} a week)</label>
    <label class="check"><input type="checkbox" name="weekly"${sub.weekly ? " checked" : ""}> A weekly roundup of the best deals (Sunday afternoon)</label>
    <button type="submit">Save</button>
  </form>
  ${off ? "" : `<form method="post" action="/u/${h(sub.token)}" class="spaced"><button type="submit" class="secondary">Unsubscribe from everything</button></form>`}
</section>`,
  });
}

function unsubscribePage({ settings, sub }) {
  return layout({
    title: "Unsubscribe",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>Unsubscribe?</h1>
  <p>Stop all ${h(settings.site_name)} emails about flights from ${h(sub.origin)} to ${h(sub.email)}?</p>
  <form method="post" action="/u/${h(sub.token)}"><button type="submit">Unsubscribe</button></form>
  <p><a href="/s/${h(sub.token)}">Or change what you get instead</a></p>
</section>`,
  });
}

// ── Admin pages ──────────────────────────────────────────────────────────

const STATUS_LABEL = { confirmed: "Confirmed", rejected: "Didn't hold up", unchecked: "Not checked" };
const fmtTime = (t, timeZone) =>
  t ? new Date(t).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;

function adminHome({ admin, settings, scans, counts, keys, searches, scanning, notice, timeZone }) {
  const scanRows = scans
    .map(
      (s) => `<tr><td>${h(fmtTime(s.started_at, timeZone))}</td><td class="status-${h(s.status)}">${h(s.status)}</td><td>${h(s.summary || "")}${s.error ? `<div class="error-text">${h(s.error)}</div>` : ""}</td></tr>`,
    )
    .join("");
  const countRows = counts
    .map((c) => `<tr><td>${h(c.code)} · ${h(c.name)}${c.active ? "" : " (off)"}</td><td>${c.active_count}</td><td>${c.pending_count}</td><td>${c.unsubscribed_count}</td></tr>`)
    .join("");
  const keyLine = (label, ok) => `<li>${h(label)}: ${ok ? '<span class="good">set up</span>' : '<span class="error-text">not set up yet</span>'}</li>`;
  return layout({
    title: "Admin",
    siteName: settings.site_name,
    admin,
    body: `<h1>Overview</h1>
${noticeBox(notice)}
<div class="grid">
<section class="card">
  <h2>Price services</h2>
  <ul>${keyLine("Travelpayouts (prices)", keys.travelpayouts)}${keyLine("Google Flights via SerpApi (double-check)", keys.serpapi)}</ul>
  <p class="muted">Google Flights searches used: ${searches.today} today (limit ${settings.max_checks_per_day * 2}), ${searches.month} this month.</p>
</section>
<section class="card">
  <h2>Subscribers</h2>
  <table><tr><th>Airport</th><th>Active</th><th>Not confirmed</th><th>Unsubscribed</th></tr>${countRows}</table>
</section>
</div>
<section class="card">
  <h2>Scans</h2>
  <p class="muted">Runs automatically at ${h(settings.scan_hours.map((x) => `${x % 12 || 12} ${x < 12 ? "am" : "pm"}`).join(" and "))} (${h(timeZone)}).</p>
  <form method="post" action="/admin/scan">${hidden(admin.formToken)}<button type="submit"${scanning ? " disabled" : ""}>${scanning ? "Scanning now…" : "Scan now"}</button></form>
  <table><tr><th>Started</th><th>Status</th><th>Result</th></tr>${scanRows || '<tr><td colspan="3" class="muted">No scans yet.</td></tr>'}</table>
</section>`,
  });
}

function adminDeals({ admin, settings, deals, timeZone }) {
  const rows = deals
    .map((d) => {
      const desc = describeDeal(d);
      return `<tr>
  <td>${h(fmtTime(d.found_at, timeZone))}</td>
  <td>${h(d.origin)} → ${h(desc.place)}</td>
  <td>${h(desc.dates)}</td>
  <td>$${h(d.found_price)}${d.checked_price ? ` → $${h(d.checked_price)}` : ""}${d.normal_price ? `<div class="muted">normal $${h(d.normal_price)}</div>` : ""}</td>
  <td class="status-${h(d.status)}">${h(STATUS_LABEL[d.status])}${d.reason ? `<div class="muted">${h(d.reason)}</div>` : ""}</td>
  <td>${h(d.stops_text || "")}${d.book_url ? ` <a href="${h(d.book_url)}" target="_blank" rel="noopener">link</a>` : ""}</td>
</tr>`;
    })
    .join("");
  return layout({
    title: "Deals",
    siteName: settings.site_name,
    admin,
    body: `<h1>Deals found</h1>
<p class="muted">Prices are the scan's price, then Google Flights' price when it was double-checked. Only "Confirmed" deals are emailed and shown on the site${settings.require_check ? "" : " (plus \"Not checked\" ones, since double-checking is off in Settings)"}.</p>
<div class="table-wrap"><table><tr><th>Found</th><th>Route</th><th>Dates</th><th>Price</th><th>Status</th><th>Flights</th></tr>${rows || '<tr><td colspan="6" class="muted">None yet.</td></tr>'}</table></div>`,
  });
}

function regionOptions(selected) {
  const names = { us: "United States", caribbean: "Mexico & Caribbean", europe: "Europe", other: "Other" };
  return REGIONS.map((r) => `<option value="${r}"${r === selected ? " selected" : ""}>${names[r]}</option>`).join("");
}

function adminAirports({ admin, settings, origins, destinations, error, notice }) {
  const originRows = origins
    .map(
      (o) => `<tr><td><strong>${h(o.code)}</strong></td><td colspan="2">
  <form method="post" action="/admin/origins/${h(o.code)}" class="row">${hidden(admin.formToken)}
    <input name="name" value="${h(o.name)}" aria-label="Name" maxlength="60" required>
    <label class="check"><input type="checkbox" name="active"${o.active ? " checked" : ""}> Scanning</label>
    <button class="small" type="submit">Save</button>
  </form></td></tr>`,
    )
    .join("");
  const destRows = destinations
    .map(
      (d) => `<tr><td><strong>${h(d.code)}</strong></td><td>
  <form method="post" action="/admin/destinations/${h(d.code)}" class="row">${hidden(admin.formToken)}
    <input name="name" value="${h(d.name)}" aria-label="Name" maxlength="60" required>
    <select name="region" aria-label="Region">${regionOptions(d.region)}</select>
    <label class="check"><input type="checkbox" name="domestic"${d.domestic ? " checked" : ""}> In the US</label>
    <input name="google_codes" value="${h(d.google_codes || "")}" aria-label="Google Flights airports" placeholder="Google airports" size="12">
    <input name="max_price" value="${h(d.max_price || "")}" aria-label="Always a deal under $" placeholder="Deal under $" size="8">
    <label class="check"><input type="checkbox" name="active"${d.active ? " checked" : ""}> Scanning</label>
    <button class="small" type="submit">Save</button>
  </form></td><td>
  <form method="post" action="/admin/destinations/${h(d.code)}/delete" onsubmit="return confirm('Remove ${h(d.code)}?')">${hidden(admin.formToken)}<button class="small secondary" type="submit">Remove</button></form>
</td></tr>`,
    )
    .join("");
  return layout({
    title: "Airports",
    siteName: settings.site_name,
    admin,
    body: `<h1>Airports</h1>
${errorBox(error)}${noticeBox(notice)}
<section class="card">
  <h2>From (small airports)</h2>
  <p class="muted">People sign up for alerts from one of these. Turning one off stops scanning it and hides it from the sign-up form.</p>
  <table>${originRows}</table>
  <form method="post" action="/admin/origins" class="row spaced">${hidden(admin.formToken)}
    <input name="code" placeholder="Code" maxlength="3" size="5" required aria-label="Airport code">
    <input name="name" placeholder="City, e.g. Fayetteville, AR" maxlength="60" required aria-label="Name">
    <button type="submit">Add airport</button>
  </form>
</section>
<section class="card">
  <h2>To (popular places)</h2>
  <p class="muted">"In the US" lets Google Flights leave out basic economy for us (it can only do that for US trips; elsewhere we skip basic economy ourselves). "Google airports" is for city codes, e.g. NYC → JFK, LGA, EWR. "Deal under $" makes any round trip at or below that price a deal, whatever the history says.</p>
  <div class="table-wrap"><table>${destRows}</table></div>
  <form method="post" action="/admin/destinations" class="row spaced">${hidden(admin.formToken)}
    <input name="code" placeholder="Code" maxlength="3" size="5" required aria-label="Airport or city code">
    <input name="name" placeholder="Name" maxlength="60" required aria-label="Name">
    <select name="region" aria-label="Region">${regionOptions("us")}</select>
    <label class="check"><input type="checkbox" name="domestic" checked> In the US</label>
    <input name="google_codes" placeholder="Google airports (optional)" size="16" aria-label="Google Flights airports">
    <input name="max_price" placeholder="Deal under $ (optional)" size="10" aria-label="Always a deal under $">
    <button type="submit">Add place</button>
  </form>
</section>`,
  });
}

function adminCheck({ admin, settings, origins, destinations, form = {}, result = null, error = null }) {
  const originOptions = origins.map((o) => `<option value="${h(o.code)}"${o.code === form.origin ? " selected" : ""}>${h(o.code)} · ${h(o.name)}</option>`).join("");
  const destOptions = destinations.map((d) => `<option value="${h(d.code)}"${d.code === form.destination ? " selected" : ""}>${h(d.code)} · ${h(d.name)}</option>`).join("");
  let out = "";
  if (result) {
    const months = result.months
      .map((m) => `<tr><td>${h(m.month)}</td><td>${m.error ? `<span class="error-text">${h(m.error)}</span>` : `${m.prices} prices, ${m.kept} trips we'd look at`}</td></tr>`)
      .join("");
    const fares = result.fares
      .map(
        (f) => `<tr><td>${h(f.departDate)} → ${h(f.returnDate)}</td><td>${h(f.shape)}</td><td>$${h(f.price)}</td><td>${f.stopsOut === 0 && f.stopsBack === 0 ? "Nonstop" : `${f.stopsOut} / ${f.stopsBack} stops`}</td><td>${h(f.airline || "")}</td><td>${f.url ? `<a href="${h(f.url)}" target="_blank" rel="noopener">Aviasales</a>` : ""}</td></tr>`,
      )
      .join("");
    const g = result.google;
    const google = !g
      ? ""
      : g.error
        ? `<p class="error-text">Google Flights: ${h(g.error)}</p>`
        : `<p><strong>Google Flights for ${h(g.departDate)} → ${h(g.returnDate)}:</strong> ${g.ok ? `$${h(g.price)} (${h(g.stopsText)}${g.airline ? `, ${h(g.airline)}` : ""})` : h(g.reason)}${g.priceLevel ? ` · Google rates prices on this route <strong>${h(g.priceLevel)}</strong>` : ""}${g.typicalRange ? ` (typical $${h(g.typicalRange[0])}–$${h(g.typicalRange[1])})` : ""}${g.url ? ` · <a href="${h(g.url)}" target="_blank" rel="noopener">open</a>` : ""} <span class="muted">(${g.searches} searches used)</span></p>`;
    out = result.error
      ? errorBox(result.error)
      : `<section class="card">
  <h2>${h(result.origin)} → ${h(result.destination)}</h2>
  <p>${result.raw} prices from Travelpayouts in total. ${result.history.count} seen by earlier scans (last 45 days)${result.history.normal ? `, normally about $${h(result.history.normal)}` : ""}.</p>
  <table><tr><th>Month</th><th>What came back</th></tr>${months}</table>
  ${google}
  <h3>Cheapest trips we'd look at</h3>
  ${fares ? `<div class="table-wrap"><table><tr><th>Dates</th><th>Trip</th><th>Price</th><th>Stops (out / back)</th><th>Airline</th><th></th></tr>${fares}</table></div>` : '<p class="muted">None (no weekend or 4–7 night trips with at most one stop each way).</p>'}
</section>`;
  }
  return layout({
    title: "Check a route",
    siteName: settings.site_name,
    admin,
    body: `<h1>Check a route</h1>
<p class="muted">See what the price services say about one route right now. Nothing is saved or emailed. Ticking Google Flights uses up to 2 of your SerpApi searches.</p>
${errorBox(error)}
<form method="post" action="/admin/check" class="row card">${hidden(admin.formToken)}
  <select name="origin" aria-label="From">${originOptions}</select>
  <select name="destination" aria-label="To">${destOptions}</select>
  <label class="check"><input type="checkbox" name="google"${form.google ? " checked" : ""}> Also check the cheapest on Google Flights</label>
  <button type="submit">Check</button>
</form>
${out}`,
  });
}

function adminSettings({ admin, settings, values = settings, error = null, notice = null }) {
  const field = (name, label, hint = "", attrs = "") =>
    `<label for="${name}">${h(label)}</label><input id="${name}" name="${name}" value="${h(Array.isArray(values[name]) ? values[name].join(", ") : values[name])}" ${attrs}>${hint ? `<div class="hint">${h(hint)}</div>` : ""}`;
  return layout({
    title: "Settings",
    siteName: settings.site_name,
    admin,
    body: `<h1>Settings</h1>
${errorBox(error)}${noticeBox(notice)}
<form method="post" action="/admin/settings" class="card narrow">${hidden(admin.formToken)}
  ${field("site_name", "Site name", "Shown on the site and in emails.", 'maxlength="60" required')}
  ${field("mailing_address", "Mailing address", "Printed at the bottom of every email (US law requires a postal address; a PO box is fine).", 'maxlength="200" required')}
  ${field("deal_percent", "A deal is at least this % below normal", "Normal = the middle price seen on the route in the last 45 days.", 'type="number" min="5" max="90"')}
  ${field("min_history", "Prices needed before judging a route", "Until a route has this many prices on record, only the \"Deal under $\" limits apply.", 'type="number" min="1" max="1000"')}
  ${field("scan_hours", "Scan at these hours", "Hours of the day, 0–23, comma-separated (e.g. 6, 18 = 6 am and 6 pm).")}
  ${field("max_checks_per_day", "Google Flights double-checks per day", "Each uses up to 2 SerpApi searches. SerpApi's free plan has 250 searches a month (about 4 checks a day); $25/month gets 1,000.", 'type="number" min="0" max="500"')}
  <label class="check"><input type="checkbox" name="require_check"${values.require_check ? " checked" : ""}> Only send deals Google Flights has confirmed</label>
  <div class="hint">Recommended: it's what leaves out basic economy and overnight connections. Off = deals are also sent straight from the scan, marked "not double-checked".</div>
  ${field("max_alerts_per_week", "Most deal emails per person per week", "", 'type="number" min="1" max="50"')}
  ${field("affiliate_marker", "Travelpayouts partner ID (marker)", "Optional. Once Travelpayouts approves the site, put your partner ID here so Aviasales links earn commission.", 'maxlength="40"')}
  ${field("drive_script", "Travelpayouts Drive code (temporary)", "Only while Travelpayouts' account setup checks the site for it: paste the whole code they show you, save, click their check button, then empty this box and save again. While it's set, their script runs on the home page.", 'maxlength="2000"')}
  <p><button type="submit">Save</button></p>
</form>`,
  });
}

module.exports = {
  homePage,
  messagePage,
  confirmPage,
  preferencesPage,
  unsubscribePage,
  adminHome,
  adminDeals,
  adminAirports,
  adminCheck,
  adminSettings,
  layout,
};
