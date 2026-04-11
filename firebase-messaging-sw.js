importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCPtsMx81ouDrPWQl2ZMlZ39bfYrmEqCyw",
  authDomain: "reminders-88be0.firebaseapp.com",
  projectId: "reminders-88be0",
  storageBucket: "reminders-88be0.firebasestorage.app",
  messagingSenderId: "640069736715",
  appId: "1:640069736715:web:3e64afeeb0bff97e6b2a0e"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Reminder', {
    body: body || 'You have a task due.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.data && payload.data.taskId ? payload.data.taskId : 'reminder',
    renotify: true,
    data: payload.data || {}
  });
});

// Open app when notification is clicked
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
