/*
 * The CANSLIM member list, served to the landing page.
 *
 * Any tool can answer this. The list is one shared file rather than a table in
 * any tool's database, so the tool that happens to be serving the page reads
 * the same thing T8 wrote — no cross-tool request, and no dependency on T8
 * being up to see who is on it.
 *
 * Read-only by construction. There is no endpoint to add or remove a member,
 * and there should not be: membership is decided by a screener running against
 * published fundamentals, and a hand-edited list would be a set of names nobody
 * could later explain.
 */

const express = require('express');
const canslim = require('../sideA/canslim');

const router = express.Router();

const DAY = 24 * 60 * 60 * 1000;

router.get('/', (req, res) => {
  const now = Date.now();
  const state = canslim.read();
  const members = state.members || {};
  const cutoff = now - canslim.MEMBER_DAYS * DAY;

  const rows = Object.entries(members).map(([ticker, m]) => ({
    ticker,
    // Two different questions, and the difference is what decides anything.
    // `held` is how long this name has been on the list since it first
    // qualified — months means it survived an earnings cycle. `lastSeenDays`
    // is what expiry counts from, so a long-held name can still be about to go.
    held: Math.floor((now - (m.firstSeen || now)) / DAY),
    lastSeenDays: Math.floor((now - (m.lastConfirmed || now)) / DAY),
    confirmations: m.confirmations || 1,
    expiresIn: Math.ceil(((m.lastConfirmed || 0) + canslim.MEMBER_DAYS * DAY - now) / DAY),
    live: (m.lastConfirmed || 0) >= cutoff,
  }));

  res.json({
    ok: true,
    memberDays: canslim.MEMBER_DAYS,
    updatedAt: state.updatedAt || null,
    // Longest-held first: the names that have been there through an earnings
    // cycle are the ones the list exists to surface.
    members: rows.filter(r => r.live).sort((a, b) => b.held - a.held),
    expired: rows.filter(r => !r.live).sort((a, b) => a.lastSeenDays - b.lastSeenDays),
  });
});

module.exports = router;
