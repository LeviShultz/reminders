const CACHE = 'reminders-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(clientList => {
    for (const client of clientList) {
      if (client.url && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CHECK_TASKS') {
    const tasks = e.data.tasks || [];
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

    tasks.forEach(t => {
      if (t.done) return;
      const startDate = t.startDate || today;
      if (startDate > today) return;
      const msPerDay = 86400000;
      const days = Math.round((new Date(today) - new Date(startDate)) / msPerDay);
      const freq = t.freq || 1;
      const snoozeOk = !t.snoozedUntil || t.snoozedUntil <= today;
      if (days % freq !== 0 || !snoozeOk) return;

      const tf = t.timeFrom || '00:00';
      const tt = t.timeTo || '23:59';
      const inWindow = tf <= tt ? (currentTime >= tf && currentTime <= tt) : (currentTime >= tf || currentTime <= tt);
      if (!inWindow) return;

      self.registration.showNotification(t.name, {
        body: t.note || 'This task is due today.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: t.id,
        renotify: false,
        data: { taskId: t.id }
      });
    });
  }
});
