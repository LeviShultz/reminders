const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// ── Test notification endpoint ────────────────────────────────────────────────
exports.testNotification = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
  let token;
  try { token = (req.body.data || req.body).token; } catch(e) { res.status(400).json({ error: 'Missing token' }); return; }
  if (!token) { res.status(400).json({ error: 'Missing token' }); return; }
  try {
    const msgId = await messaging.send({
      notification: { title: 'Test notification', body: 'FCM is working correctly on this device!' },
      token
    });
    console.log('Test sent:', msgId);
    res.json({ result: { success: true, messageId: msgId } });
  } catch(e) {
    console.error('Test error:', e.message);
    res.status(500).json({ result: { success: false, error: e.message } });
  }
});

// ── Scheduled reminder sender ─────────────────────────────────────────────────
exports.sendReminders = onSchedule('every 1 minutes', async () => {
  const nowMs = Date.now();
  const now = new Date(nowMs);
  console.log(`[sendReminders] Running at ${now.toISOString()}`);

  const [tokensSnap, tasksSnap] = await Promise.all([
    db.collection('tokens').get(),
    db.collection('tasks').get()
  ]);

  console.log(`[sendReminders] tokens: ${tokensSnap.size}, tasks: ${tasksSnap.size}`);
  if (tokensSnap.empty) { console.log('[sendReminders] No tokens'); return; }
  if (tasksSnap.empty) { console.log('[sendReminders] No tasks'); return; }

  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) { console.log('[sendReminders] Empty tokens'); return; }
  const tasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Auto-detect CDT/CST for Oklahoma
  const month = now.getUTCMonth();
  const isCDT = month >= 2 && month <= 10;
  const LOCAL_OFFSET_MS = (isCDT ? -5 : -6) * 60 * 60 * 1000;
  const localNow = new Date(nowMs + LOCAL_OFFSET_MS);
  const localHH = localNow.getUTCHours().toString().padStart(2, '0');
  const localMM = localNow.getUTCMinutes().toString().padStart(2, '0');
  const localTime = `${localHH}:${localMM}`;
  const localToday = localNow.toISOString().split('T')[0];
  const localDay = localNow.getUTCDay();
  const isWeekend = localDay === 0 || localDay === 6;
  console.log(`[sendReminders] Local: ${localTime} ${localToday} weekend=${isWeekend} tokens=${tokens.length}`);

  const dueTasks = tasks.filter(t => {
    if (t.done) return false;
    const activeDays = t.activeDays || 'all';
    if (activeDays === 'weekdays' && isWeekend) return false;
    if (activeDays === 'weekends' && !isWeekend) return false;
    const tf = t.timeFrom || '00:00';
    const tt = t.timeTo || '23:59';
    const inWindow = tf <= tt ? (localTime >= tf && localTime <= tt) : (localTime >= tf || localTime <= tt);
    if (!inWindow) { console.log(`[sendReminders] "${t.name}" outside window ${tf}–${tt}`); return false; }
    if (t.startDate && t.startDate > localToday) return false;
    if (t.snoozedUntil && t.snoozedUntil > localToday) return false;
    const freq = t.freq;
    if (freq === 'hourly-random' || freq === 'subhour-random') {
      const due = !t.nextNotifyAt || nowMs >= Number(t.nextNotifyAt);
      console.log(`[sendReminders] intraday "${t.name}" due=${due}`);
      return due;
    }
    const startDate = t.startDate || localToday;
    const daysDiff = Math.round((new Date(localToday) - new Date(startDate)) / 86400000);
    if (daysDiff < 0) return false;
    if (t.lastNotifiedDate === localToday) { console.log(`[sendReminders] "${t.name}" already sent today`); return false; }
    const due = daysDiff % Number(freq) === 0;
    console.log(`[sendReminders] "${t.name}" daysDiff=${daysDiff} freq=${freq} due=${due}`);
    return due;
  });

  console.log(`[sendReminders] ${dueTasks.length} due`);
  if (!dueTasks.length) return;

  const batch = db.batch();
  for (const task of dueTasks) {
    const freq = task.freq;
    const isIntraDay = freq === 'hourly-random' || freq === 'subhour-random';
    const taskRef = db.collection('tasks').doc(task.id);
    if (isIntraDay) {
      const intervalMs = freq === 'subhour-random'
        ? (20 + Math.random() * 10) * 60 * 1000
        : (60 + Math.random() * 60) * 60 * 1000;
      batch.update(taskRef, { nextNotifyAt: nowMs + intervalMs });
    } else {
      batch.update(taskRef, { lastNotifiedDate: localToday });
    }
    try {
      const result = await messaging.sendEachForMulticast({
        notification: {
          title: task.name,
          body: task.note || (task.priority === 'high' ? 'High priority task due.' : 'This task needs your attention.')
        },
        data: { taskId: String(task.id) },
        tokens
      });
      console.log(`[sendReminders] "${task.name}" ok=${result.successCount} fail=${result.failureCount}`);
      result.responses.forEach((resp, i) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          console.log(`[sendReminders] token[${i}] failed: ${code}`);
          if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
            const stale = tokens[i];
            tokensSnap.docs.forEach(d => { if (d.data().token === stale) batch.delete(d.ref); });
          }
        }
      });
    } catch(err) {
      console.error(`[sendReminders] error for "${task.name}":`, err.message);
    }
  }
  await batch.commit();
  console.log('[sendReminders] Done');
});
