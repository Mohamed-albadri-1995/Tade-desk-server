/*
 * THE TWO FILES THAT MUST NOT BE SERVED STALE.
 *
 * desk.js and desk.css are not assets in the sense the caching rule meant.
 * They are the NAVIGATION of the whole desk — every link from any program to
 * any other is a string that desk.js computes — and one copy is shared by four
 * separate servers on four origins. So a stale copy is not an old colour, it
 * is a bar full of addresses that no longer exist.
 *
 * THE FAILURE, AS REPORTED: "If I click 1 time it took me to the landing page
 * if I press again it took me to correct page." The Screeners link had been
 * fixed and pushed; the page in the browser was still running the previous
 * desk.js, so its first press used the old address. The second press was made
 * from the landing page — served by a process whose copy had been revalidated
 * — and went to the right place. Nothing was wrong with the server; the page
 * simply had not asked.
 *
 * Starlette's StaticFiles, which is what serves qp's copy, sends no
 * Cache-Control at all — a browser is then free to guess a freshness lifetime
 * from the file's age, and for a file last touched a week ago that guess is
 * hours. Express sends `public, max-age=0`, which does revalidate, but Android
 * Chrome will still hand back a page from its own memory or back-forward cache
 * without asking. Neither is a bug; both mean a deploy is not a deploy.
 *
 * `no-cache` is not `no-store`. The browser keeps the file and asks before
 * using it, the answer is a 304 nearly every time, and the whole cost is one
 * round trip on about eighteen kilobytes. Every OTHER asset keeps normal
 * caching — that is what caching is for.
 *
 * Named here rather than written out in each server because there are four of
 * them, and four copies of one idea drift. The one that drifts is always the
 * server you look at least.
 */
const SHARED_ASSETS = ['/desk.js', '/desk.css'];

/** True for a request whose response must carry no-cache. */
function isSharedAsset(pathname) {
  return SHARED_ASSETS.includes(String(pathname || ''));
}

/** Express middleware form, for the servers that mount one. */
function noCacheShared(req, res, next) {
  if (req.method === 'GET' && isSharedAsset(req.path)) {
    res.set('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
}

module.exports = { SHARED_ASSETS, isSharedAsset, noCacheShared };
