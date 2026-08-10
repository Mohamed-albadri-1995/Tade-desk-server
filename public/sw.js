/*
 * The service worker: the only part of this that runs when the page is closed.
 *
 * Everything else on the alerts page needs an open tab — the poll, the sound,
 * the banner, new Notification(). This does not. The browser keeps it
 * registered after the tab is gone and starts it when a push arrives, which is
 * what makes a 10:00 alert reach a phone in a pocket.
 *
 * The push carries NO data. It is a wake-up; this then fetches the fires from
 * the server over the same HTTPS the page uses. So no ticker, price or trade
 * ever passes through Google's or Mozilla's push service — what they carry is
 * "something is new". See src/alerts/push.js.
 *
 * IT MUST ALWAYS SHOW SOMETHING. A push handler that finishes without showing a
 * notification makes Chrome show its own "This site has been updated in the
 * background" — so every failure path here ends in a notification saying what
 * went wrong, which is also the honest thing: the alternative is a silent phone
 * that looks identical to a quiet market.
 */

const CACHE_BUST = 'td-alerts-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/** ET, the market's day — the server keys fires by it. */
function etDate() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/*
 * What has already been shown, so a second push does not repeat the first.
 *
 * A worker is stopped and restarted between pushes, so this cannot be a
 * variable — it has to survive in the Cache API, which is the only storage a
 * worker is guaranteed to be able to reach synchronously enough here.
 */
async function alreadyShown() {
  const c = await caches.open(CACHE_BUST);
  const res = await c.match('shown');
  if (!res) return new Set();
  try { return new Set(await res.json()); } catch { return new Set(); }
}

async function remember(keys) {
  const c = await caches.open(CACHE_BUST);
  // Bounded: today's fires only, and the list is a guard against repeats rather
  // than a record of anything.
  const keep = [...keys].slice(-200);
  await c.put('shown', new Response(JSON.stringify(keep)));
}

const keyOf = f => `${f.at}|${f.toolId || ''}|${f.ruleId || ''}|${f.ticker || ''}`;

/*
 * A trade needs its numbers on the lock screen.
 *
 * The whole point of arriving at 10:00:02 is being able to act without opening
 * anything, and the detail line is already written for exactly that — side,
 * shares, entry, stop, target. It is used as-is rather than re-summarised.
 */
function present(f) {
  const trade = f.level === 'trade';
  const title = trade
    ? `${f.ticker || 'Setup'} — ${f.rule || 'setup'}`
    : `${f.ticker ? `${f.ticker} · ` : ''}${f.rule || 'Alert'}`;
  return {
    title: `${trade ? '📈 ' : f.level === 'error' ? '⚠️ ' : ''}${title}`,
    body: f.detail || '',
    // Per fire, so two alerts in the same minute do not replace each other —
    // the second one is usually the one you have not seen.
    tag: keyOf(f),
    // A trade must not be dismissed by a glance at the screen.
    requireInteraction: trade,
    renotify: true,
    timestamp: f.at || Date.now(),
    data: { url: `/alerts.html${f.ticker ? `?ticker=${encodeURIComponent(f.ticker)}` : ''}` },
  };
}

async function handlePush() {
  let fires = [];
  try {
    const res = await fetch(`/api/alerts/fires?date=${etDate()}&limit=20`, {
      cache: 'no-store', credentials: 'same-origin',
    });
    const d = await res.json();
    fires = (d.fires || []).filter(f => f.level !== 'info');
  } catch (err) {
    // The wake-up arrived and the server could not be reached — worth saying,
    // because the alternative is a phone that stays quiet during the one minute
    // it was bought to cover.
    await self.registration.showNotification('⚠️ Trade Desk', {
      body: 'An alert fired but the desk could not be reached. Open the page.',
      tag: 'td-unreachable',
      data: { url: '/alerts.html' },
    });
    return;
  }

  const shown = await alreadyShown();
  const fresh = fires.filter(f => !shown.has(keyOf(f)))
    // Oldest first, so the newest ends up on top of the shade.
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(-4);

  if (!fresh.length) {
    // A push with nothing new behind it. Something has to be shown, so it says
    // so plainly rather than inventing an alert.
    await self.registration.showNotification('Trade Desk', {
      body: 'Something fired — open the alerts page.',
      tag: 'td-generic',
      data: { url: '/alerts.html' },
    });
    return;
  }

  for (const f of fresh) {
    const n = present(f);
    await self.registration.showNotification(n.title, n);
    shown.add(keyOf(f));
  }
  await remember(shown);
}

self.addEventListener('push', e => e.waitUntil(handlePush()));

/*
 * Chrome retires a subscription on its own occasionally. Without this the phone
 * goes quiet and nothing anywhere says why — it would keep showing
 * "Notifications: on" while being unreachable.
 */
self.addEventListener('pushsubscriptionchange', e => e.waitUntil((async () => {
  try {
    const res = await fetch('/api/push/key');
    const { publicKey } = await res.json();
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), label: 'resubscribed' }),
    });
  } catch { /* the page re-subscribes on next open */ }
})()));

/** Tapping it opens the alerts page, reusing an open tab if there is one. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/alerts.html';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/alerts.html')) { await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
