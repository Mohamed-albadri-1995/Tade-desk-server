// Scoring disconnected — will be reconnected in Phase 2 using new 48-table model

function scoreRow() { return null; }
function scoreAllRows(rows) { return rows.map(row => ({ ...row, _score: null })); }
function invalidateCache() {}

module.exports = { scoreRow, scoreAllRows, invalidateCache };
