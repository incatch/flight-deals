// The emails: sign-up confirmations, deal alerts (right after a scan finds
// deals) and the weekly roundup. Every email says who it's from, how to
// change settings or unsubscribe (one click), and the mailing address, as
// US law (CAN-SPAM) requires.

const { percentBelow, nightsBetween } = require("./deals");

const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function niceDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function dealPrice(deal) {
  return deal.checked_price ?? deal.found_price;
}

/** The facts about one deal, as lines of text (used by emails and the site). */
function describeDeal(deal) {
  const price = dealPrice(deal);
  const below = percentBelow(price, deal.normal_price);
  const nights = nightsBetween(deal.depart_date, deal.return_date);
  return {
    place: deal.destination_name || deal.destination,
    price: `$${price.toLocaleString("en-US")}`,
    headline: `${deal.origin} → ${deal.destination_name || deal.destination}: $${price.toLocaleString("en-US")} round trip`,
    note: [
      below ? `${below}% below normal` : null,
      deal.price_level === "low" ? "Google rates it low" : null,
      deal.status === "unchecked" ? "price from recent searches, not double-checked" : null,
    ].filter(Boolean).join(" · "),
    dates: `${niceDate(deal.depart_date)} → ${niceDate(deal.return_date)} (${nights} night${nights === 1 ? "" : "s"})`,
    details: [deal.stops_text, deal.airline].filter(Boolean).join(" · "),
    url: deal.book_url,
  };
}

function createAlerts({ store, sendEmail, siteUrl, log = console, pauseMs = 600 }) {
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : Promise.resolve());
  const links = (sub) => ({
    settings: `${siteUrl}/s/${sub.token}`,
    unsubscribe: `${siteUrl}/u/${sub.token}`,
  });

  function footer(settings, sub) {
    const l = links(sub);
    const why = `You're getting this because you signed up for ${settings.site_name} alerts from ${sub.origin} at ${siteUrl}.`;
    return {
      text: `\n--\n${why}\nChange what you get: ${l.settings}\nUnsubscribe: ${l.unsubscribe}\n${settings.site_name} · ${settings.mailing_address}\n`,
      html: `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">
<p style="color:#666;font-size:12px;line-height:1.5">${h(why)}<br>
<a href="${h(l.settings)}">Change what you get</a> · <a href="${h(l.unsubscribe)}">Unsubscribe</a><br>
${h(settings.site_name)} · ${h(settings.mailing_address)}</p>`,
    };
  }

  function dealBlocks(list) {
    const items = list.map(describeDeal);
    return {
      text: items
        .map((d) => [d.headline, d.note, d.dates, d.details, d.url ? `See it: ${d.url}` : null].filter(Boolean).join("\n"))
        .join("\n\n"),
      html: items
        .map(
          (d) => `<div style="border:1px solid #e3e3e3;border-radius:8px;padding:12px 14px;margin:0 0 12px">
<div style="font-size:18px;font-weight:bold">${h(d.place)} · ${h(d.price)} <span style="font-weight:normal;font-size:14px">round trip</span></div>
${d.note ? `<div style="color:#1a7f37">${h(d.note)}</div>` : ""}
<div>${h(d.dates)}</div>
${d.details ? `<div style="color:#555">${h(d.details)}</div>` : ""}
${d.url ? `<div style="margin-top:8px"><a href="${h(d.url)}" style="background:#0b5cad;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none">See flights</a></div>` : ""}
</div>`,
        )
        .join("\n"),
    };
  }

  function wrap(bodyHtml) {
    return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;max-width:600px;margin:0 auto;padding:16px">${bodyHtml}</body></html>`;
  }

  async function sendDealsEmail(settings, sub, kind, list) {
    const blocks = dealBlocks(list);
    const foot = footer(settings, sub);
    const first = describeDeal(list[0]);
    const subject =
      kind === "weekly"
        ? `This week's best flight deals from ${sub.origin}`
        : list.length === 1
          ? `Deal: ${first.headline}`
          : `${list.length} flight deals from ${sub.origin}, from ${first.price}`;
    const intro =
      kind === "weekly"
        ? `The best prices we found from ${sub.origin} this week:`
        : `We just found ${list.length === 1 ? "a great price" : "great prices"} from ${sub.origin}:`;
    const caution = "Prices change fast. Check the price before you book.";
    await sendEmail({
      to: sub.email,
      subject,
      text: `${intro}\n\n${blocks.text}\n\n${caution}\n${foot.text}`,
      html: wrap(`<p>${h(intro)}</p>${blocks.html}<p style="color:#555">${h(caution)}</p>${foot.html}`),
      headers: {
        "List-Unsubscribe": `<${links(sub).unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    await store.recordAlerts(sub.id, kind, list);
  }

  return {
    async sendConfirmation(sub) {
      const settings = await store.settings();
      const url = `${siteUrl}/confirm/${sub.token}`;
      const text =
        `Please confirm you'd like ${settings.site_name} alerts for flights from ${sub.origin}:\n${url}\n\n` +
        `If you didn't sign up, ignore this email and you won't hear from us.\n\n${settings.site_name} · ${settings.mailing_address}\n`;
      await sendEmail({
        to: sub.email,
        subject: `Confirm your flight deal alerts from ${sub.origin}`,
        text,
        html: wrap(`<p>Please confirm you'd like ${h(settings.site_name)} alerts for flights from <strong>${h(sub.origin)}</strong>.</p>
<p><a href="${h(url)}" style="background:#0b5cad;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Yes, send me deals</a></p>
<p style="color:#666">If you didn't sign up, ignore this email and you won't hear from us.</p>
<p style="color:#666;font-size:12px">${h(settings.site_name)} · ${h(settings.mailing_address)}</p>`),
      });
    },

    /** Emails new deals to the people who want them right away. */
    async sendInstant(newDeals) {
      const settings = await store.settings();
      const byOrigin = new Map();
      for (const d of newDeals) byOrigin.set(d.origin, [...(byOrigin.get(d.origin) || []), d]);
      let sent = 0;
      for (const [origin, list] of byOrigin) {
        const names = new Map((await store.destinations()).map((d) => [d.code, d.name]));
        const withNames = list.map((d) => ({ ...d, destination_name: names.get(d.destination) }));
        for (const sub of await store.activeSubscribers(origin, "instant")) {
          if ((await store.instantAlertsSince(sub.id, 7)) >= settings.max_alerts_per_week) continue;
          const fresh = [];
          for (const d of withNames) {
            // Same route again only if it's at least 5% cheaper than last time.
            const last = await store.lastAlertPrice(sub.id, d.origin, d.destination);
            if (!last || dealPrice(d) < last * 0.95) fresh.push(d);
          }
          if (!fresh.length) continue;
          fresh.sort((a, b) => dealPrice(a) - dealPrice(b));
          try {
            await sendDealsEmail(settings, sub, "instant", fresh);
            sent += 1;
          } catch (err) {
            log.error(`deal alert to subscriber ${sub.id} failed: ${err.message}`);
          }
          await pause();
        }
      }
      return sent;
    },

    /** The weekly roundup: the week's best deals for each airport. */
    async sendWeekly() {
      const settings = await store.settings();
      let sent = 0;
      for (const origin of await store.origins({ activeOnly: true })) {
        const list = (await store.publicDeals(origin.code, { days: 7, includeUnchecked: !settings.require_check }))
          // The best (furthest below normal) first; one per destination.
          .sort((a, b) => (percentBelow(dealPrice(b), b.normal_price) || 0) - (percentBelow(dealPrice(a), a.normal_price) || 0))
          .filter((d, i, all) => all.findIndex((x) => x.destination === d.destination) === i)
          .slice(0, 10);
        if (!list.length) continue;
        for (const sub of await store.activeSubscribers(origin.code, "weekly")) {
          try {
            await sendDealsEmail(settings, sub, "weekly", list);
            sent += 1;
          } catch (err) {
            log.error(`weekly roundup to subscriber ${sub.id} failed: ${err.message}`);
          }
          await pause();
        }
      }
      return sent;
    },
  };
}

module.exports = { createAlerts, describeDeal, niceDate };
