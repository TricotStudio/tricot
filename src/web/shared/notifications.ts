// Opt-in desktop notifications and a soft chime for things that need the
// viewer's input, only while they're looking somewhere else: the switch,
// kept on this browser, and the sound. What a board notifies of is
// inbox/notify.ts; an agent waiting for your OK rings from access/approvals.tsx.

const KEY = 'tricot:notify';
const SUPPORTED = typeof window !== 'undefined' && 'Notification' in window;

let audio: AudioContext | null = null;

// Browsers only let audio start after a click on the page, so the context is
// created (or resumed) from one.
export function unlockAudio(): void {
  audio ??= new AudioContext();
  void audio.resume();
}

function chime(): void {
  if (!audio) return;
  const start = audio.currentTime;
  [659.25, 880].forEach((frequency, i) => {
    const oscillator = audio!.createOscillator();
    const gain = audio!.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + i * 0.14;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.08, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    oscillator.connect(gain).connect(audio!.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.4);
  });
}

export function notificationsWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberNotifications(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
}

// Whether this browser shows Tricot's notifications: the person turned them
// on here, and the browser allows them. Read by what needs a person now, as
// an agent waiting for their OK (approvals.tsx).
export const notificationsOn = (): boolean => SUPPORTED && notificationsWanted() && Notification.permission === 'granted';

// Turns them on, asking the browser first: only ever from a person's click.
// Whether they are on now.
export async function turnOnNotifications(): Promise<boolean> {
  if (!SUPPORTED) return false;
  unlockAudio();
  const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  const on = result === 'granted';
  rememberNotifications(on);
  if (on) chime(); // so the viewer knows what it sounds like
  return on;
}

// What a notification for an agent waiting on the person sounds like, when they turned the sound on.
export const ring = (): void => chime();

export const notificationsSupported = SUPPORTED;
