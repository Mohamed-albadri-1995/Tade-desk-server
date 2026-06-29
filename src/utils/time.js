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

module.exports = { toETDate, toETTime, toETHour };
