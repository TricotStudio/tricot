import { useId, useState } from 'react';
import { notificationsOn, notificationsSupported, rememberNotifications, turnOnNotifications } from '../shared/notifications';

// The switch for the chime and the desktop notifications (shared/notifications.ts),
// off until the viewer turns it on, and kept on this browser. Turning it on
// is the click the browser needs to let sound play and to ask for permission;
// when it is refused, it says so.
export function NotifySwitch() {
  const id = useId();
  const [on, setOn] = useState(notificationsOn);
  const [refused, setRefused] = useState<string | null>(null);

  const change = async (want: boolean) => {
    setRefused(null);
    if (!want) {
      rememberNotifications(false);
      setOn(false);
      return;
    }
    const granted = await turnOnNotifications();
    setOn(granted);
    if (!granted) {
      setRefused(
        Notification.permission === 'denied'
          ? 'This browser is blocking notifications from Tricot. Allow them in its site settings, then switch this on again.'
          : 'The browser did not allow notifications, so they stay off.',
      );
    }
  };

  return (
    <div className="bell-notify">
      <label className="bell-switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={on} disabled={!notificationsSupported} onChange={(e) => void change(e.target.checked)} />
        <span>Sound and desktop notifications</span>
      </label>
      <p className="bell-note">{notificationsSupported ? 'When something here needs you and this tab is in the background.' : 'This browser cannot show desktop notifications.'}</p>
      {refused && (
        <p className="bell-note bell-refused" role="alert">
          {refused}
        </p>
      )}
    </div>
  );
}
