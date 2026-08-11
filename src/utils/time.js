function toETDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function toETTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toETHour(ts) {
  return parseInt(
    new Date(ts).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }),
    10
  );
}

// Returns America/New_York UTC offset for `dateStr` (YYYY-MM-DD) as '-04:00' during EDT
// and '-05:00' during EST. Needed because Alpaca bar requests take RFC3339 with an
// offset — hardcoding one drops bars for half the year.
function etOffsetForDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(d);
  const tzn = parts.find(p => p.type === 'timeZoneName')?.value || '';
  const m = tzn.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return '-05:00';
  const sign = m[1];
  const hh = String(m[2]).padStart(2, '0');
  const mm = String(m[3] || '00').padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// Build an RFC3339 timestamp in America/New_York for the given date + HH:MM.
// e.g. toETIso('2026-07-03', '09:30') → '2026-07-03T09:30:00-04:00'
function toETIso(dateStr, hhmm) {
  return `${dateStr}T${hhmm}:00${etOffsetForDate(dateStr)}`;
}

module.exports = { toETDate, toETTime, toETHour, etOffsetForDate, toETIso };
