// What counts as a trip we look at, and as a deal. Plain functions (no
// database or network) so they're easy to test.
//
// Dates are "YYYY-MM-DD" text throughout.

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function addDays(date, days) {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}
function nightsBetween(depart, ret) {
  return dayNumber(ret) - dayNumber(depart);
}
/** 0 = Sunday … 6 = Saturday */
function weekday(date) {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

// How far ahead we look.
const MIN_DAYS_AHEAD = 14;
const MAX_DAYS_AHEAD = 180;

/**
 * "weekend" (out Thursday or Friday, back Sunday or Monday), "week" (4–7
 * nights) or null for trips we don't look at.
 */
function tripShape(depart, ret) {
  const nights = nightsBetween(depart, ret);
  if (nights >= 2 && nights <= 4 && [4, 5].includes(weekday(depart)) && [0, 1].includes(weekday(ret))) return "weekend";
  if (nights >= 4 && nights <= 7) return "week";
  return null;
}

/** The months (YYYY-MM) a scan on `today` covers. */
function monthsToScan(today) {
  const months = [];
  const last = addDays(today, MAX_DAYS_AHEAD).slice(0, 7);
  let [y, m] = addDays(today, MIN_DAYS_AHEAD).slice(0, 7).split("-").map(Number);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    months.push(month);
    if (month >= last) return months;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

/** Should the scanner keep this price? (Right dates, at most one stop each way.) */
function wanted(fare, today) {
  const ahead = dayNumber(fare.departDate) - dayNumber(today);
  return (
    ahead >= MIN_DAYS_AHEAD &&
    ahead <= MAX_DAYS_AHEAD &&
    fare.stopsOut <= 1 &&
    fare.stopsBack <= 1 &&
    tripShape(fare.departDate, fare.returnDate) !== null
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The highest price that still counts as a deal on a route: `percent` below
 * normal (once there's enough history), or the admin's price limit for the
 * destination, whichever is higher. null when neither applies yet.
 */
function dealLimit({ normal, historyCount, percent, minHistory, maxPrice }) {
  const byHistory = normal && historyCount >= minHistory ? Math.floor(normal * (1 - percent / 100)) : null;
  const limits = [byHistory, maxPrice || null].filter((v) => v);
  return limits.length ? Math.max(...limits) : null;
}

/** "42% below normal", or null when we can't say. */
function percentBelow(price, normal) {
  if (!normal || price >= normal) return null;
  return Math.round((1 - price / normal) * 100);
}

module.exports = {
  addDays,
  nightsBetween,
  weekday,
  tripShape,
  monthsToScan,
  wanted,
  median,
  dealLimit,
  percentBelow,
  MIN_DAYS_AHEAD,
  MAX_DAYS_AHEAD,
};
