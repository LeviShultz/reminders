const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Runs every minute
exports.sendReminders = onSchedule('every 1 minutes', async () => {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const nowMs = Date.now();

  // Load all tokens and tasks
  const [tokensSnap, tasksSnap] = await Promise.all([
    db.collection('tokens').get(),
    db.collection('tasks').get()
  ]);

  if (tokensSnap.empty || tasksSnap.empty) return;

  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
  const tasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const dueTasks = tasks.filter(t => {
    if (t.done) return false;

    // Active day check
    const activeDays = t.activeDays || 'all';
    if (activeDays === 'weekdays' && isWeekend) return false;
    if (activeDays === 'weekends' && !isWeekend) return false;

    // Time window check
    const tf = t.timeFrom || '00:00';
    const tt = t.timeTo || '23:59';
    const inWindow = tf <= tt
      ? (currentTime >= tf && currentTime <= tt)
      : (currentTime >= tf || currentTime <= tt);
    if (!inWindow) return false;

    // Start date check
    if (t.startDate && t.startDate > todayStr) return false;

    // Snooze check
    if (t.snoozedUntil && t.snoozedUntil > todayStr) return false;

    const freq = t.freq;

    // Intra-day (hourly / subhour)
    if (freq === 'hourly-random' || freq === 'subhour-random') {
      if (!t.nextNotifyAt) return true;
      return nowMs >= t.nextNotifyAt;
    }

    // Day-based
    const startDate = t.startDate || todayStr;
    const msPerDay = 86400000;
    const daysDiff = Math.round(
      (new Date(todayStr) - new Date(startDate)) / msPerDay
    );
    if (daysDiff < 0) return false;

    // Only fire once per day — check lastNotifiedDate
    if (t.lastNotifiedDate === todayStr) return false;

    return daysDiff % freq === 0;
  });

  if (dueTasks.length === 0) return;

  // Send notifications
  const batch = db.batch();

  for (const task of dueTasks) {
    const freq = task.freq;
    const isIntraDay = freq === 'hourly-random' || freq === 'subhour-random';

    // Update nextNotifyAt or lastNotifiedDate
    const taskRef = db.collection('tasks').doc(task.id);
    if (isIntraDay) {
      const intervalMs = freq === 'subhour-random'
        ? (20 + Math.random() * 10) * 60 * 1000
        : (60 + Math.random() * 60) * 60 * 1000;
      batch.update(taskRef, { nextNotifyAt: nowMs + intervalMs });
    } else {
      batch.update(taskRef, { lastNotifiedDate: todayStr });
    }

    // Build and send FCM message to all registered devices
    const message = {
      notification: {
        title: task.name,
        body: task.note || (task.priority === 'high' ? 'High priority task due.' : 'This task needs your attention.')
      },
      data: {
        taskId: task.id
      },
      tokens
    };

    try {
      await messaging.sendEachForMulticast(message);
    } catch (err) {
      console.error(`Failed to send for task ${task.id}:`, err);
    }
  }

  await batch.commit();
});
