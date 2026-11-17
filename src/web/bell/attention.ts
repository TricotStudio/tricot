import { useEffect, useRef } from 'react';
import { notificationsOn, ring, unlockAudio } from '../shared/notifications';
import { useTabHidden } from '../shared/hooks';

// What rings for the bell's rows (an agent waiting for the viewer's OK rings
// from access/approvals.tsx): a system notification and a chime for each thing
// that came after the page opened and needs the viewer, while this tab is in
// the background and they turned notifications on. Nothing changes while they
// look at the tab, and what was already waiting never rings. The alerts are
// given latest first, and the latest few ring.

export interface Alert {
  key: string; // the same thing is told once
  at: string; // when it was said
  title: string;
  body: string;
  open: () => void; // where a click on the notification goes
}

const MOST = 3;

export function useAlerts(alerts: Alert[]): void {
  const hidden = useTabHidden();
  const since = useRef(Date.now());
  const heard = useRef(new Set<string>());

  // Sound needs a click on the page since it loaded (shared/notifications.ts), so
  // after a reload the first press re-arms it, while notifications are on.
  useEffect(() => {
    if (!notificationsOn()) return;
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, []);

  useEffect(() => {
    const fresh = alerts.filter((alert) => !heard.current.has(alert.key) && Date.parse(alert.at) >= since.current);
    for (const alert of alerts) heard.current.add(alert.key); // told while the viewer looked: not again when they look away
    if (fresh.length === 0 || !hidden || !notificationsOn()) return;
    for (const alert of fresh.slice(0, MOST)) {
      try {
        const notification = new Notification(alert.title, { body: alert.body, tag: alert.key });
        notification.onclick = () => {
          window.focus();
          alert.open();
          notification.close();
        };
      } catch {
        // A browser that allows no Notification constructor (Android Chrome): the chime still sounds.
      }
    }
    ring();
  }, [alerts, hidden]);
}
