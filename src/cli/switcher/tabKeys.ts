// What is typed in the Tricot tab (T192), as keys: the router (keys.ts) has
// kept the switch key and its second key, and hands the tab the rest, byte
// for byte, as it would hand an agent, with a key split between two reads
// waited for and handed on whole (an arrow whose Esc came alone included, so
// an Esc alone here is Esc pressed alone). This reads those bytes as the tab's
// keys: letters and other text (UTF-8, a character cut between two reads
// waited for), Enter, Esc, Tab and Shift+Tab, Backspace, the four arrows, Home and End, Page Up and
// Page Down, Ctrl+U, Ctrl+L and Ctrl+C, and a paste whole. Anything else is a key the
// tab has no use for.
//
// The tab asks for no keyboard protocol, but a key may still come in one's
// form (keyboard.ts), typed as the terminal was being set back from an
// agent's: CSI 121u is y, CSI 27u Esc, CSI 99;5u Ctrl+C, CSI 1;1:2A an arrow
// held down. Each is read as the key it is; a release, or a modifier pressed
// alone, is no key at all.
import { StringDecoder } from 'node:string_decoder';
import { legacyOf, readKey } from './keyboard';

export type TabKey =
  | { kind: 'text'; text: string } // printable: what is typed
  | { kind: 'paste'; text: string }
  | { kind: 'enter' | 'escape' | 'tab' | 'backtab' | 'backspace' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'clear' | 'lens' | 'interrupt' | 'other' };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const SEQUENCES: [string, TabKey][] = [
  ['\x1b[A', { kind: 'up' }],
  ['\x1bOA', { kind: 'up' }],
  ['\x1b[B', { kind: 'down' }],
  ['\x1bOB', { kind: 'down' }],
  ['\x1b[C', { kind: 'right' }],
  ['\x1bOC', { kind: 'right' }],
  ['\x1b[D', { kind: 'left' }],
  ['\x1bOD', { kind: 'left' }],
  ['\x1b[H', { kind: 'home' }],
  ['\x1bOH', { kind: 'home' }],
  ['\x1b[1~', { kind: 'home' }],
  ['\x1b[7~', { kind: 'home' }],
  ['\x1b[F', { kind: 'end' }],
  ['\x1bOF', { kind: 'end' }],
  ['\x1b[4~', { kind: 'end' }],
  ['\x1b[8~', { kind: 'end' }],
  ['\x1b[5~', { kind: 'pageup' }],
  ['\x1b[6~', { kind: 'pagedown' }],
  ['\x1b[Z', { kind: 'backtab' }], // Shift+Tab
];

const CONTROLS: Record<number, TabKey> = {
  0x0d: { kind: 'enter' },
  0x0a: { kind: 'enter' },
  0x09: { kind: 'tab' },
  0x7f: { kind: 'backspace' },
  0x08: { kind: 'backspace' },
  0x15: { kind: 'clear' }, // Ctrl+U
  0x0c: { kind: 'lens' }, // Ctrl+L
  0x03: { kind: 'interrupt' }, // Ctrl+C
};

// A key as the bytes it would be without the protocols (legacyOf).
function keyOf(typed: string): TabKey {
  if (typed === '\x1b') return { kind: 'escape' };
  const known = SEQUENCES.find(([seq]) => seq === typed);
  if (known) return known[1];
  const code = typed.charCodeAt(0);
  if (typed.length === 1 && (code < 0x20 || code === 0x7f)) return CONTROLS[code] ?? { kind: 'other' };
  if (code === 0x1b) return { kind: 'other' }; // with Alt, or a key the tab has no use for
  return { kind: 'text', text: typed };
}

export class TabKeyReader {
  private decoder = new StringDecoder('utf8');
  private paste: string | undefined; // a paste begun, until its end mark

  // `bytes` as the router sends them on: each character one byte (latin1).
  read(bytes: Buffer): TabKey[] {
    const keys: TabKey[] = [];
    let s = bytes.toString('latin1');
    let text = '';
    const flushText = () => {
      const decoded = this.decoder.write(Buffer.from(text, 'latin1'));
      if (decoded) keys.push({ kind: 'text', text: decoded });
      text = '';
    };
    while (s.length) {
      if (this.paste !== undefined) {
        const end = s.indexOf(PASTE_END);
        this.paste += end < 0 ? s : s.slice(0, end);
        if (end < 0) break;
        keys.push({ kind: 'paste', text: Buffer.from(this.paste, 'latin1').toString('utf8') });
        this.paste = undefined;
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        flushText();
        this.paste = '';
        s = s.slice(PASTE_START.length);
        continue;
      }
      const code = s.charCodeAt(0);
      if (code === 0x1b) {
        const event = readKey(s);
        if (event) {
          s = s.slice(event.raw.length);
          const typed = legacyOf(event);
          if (typed === undefined) continue;
          const key = keyOf(typed);
          if (key.kind === 'text') text += Buffer.from(key.text, 'utf8').toString('latin1');
          else {
            flushText();
            keys.push(key);
          }
          continue;
        }
        flushText();
        const known = SEQUENCES.find(([seq]) => s.startsWith(seq));
        const other = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O.|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/.exec(s);
        if (known) {
          keys.push(known[1]);
          s = s.slice(known[0].length);
        } else if (s.length === 1) {
          keys.push({ kind: 'escape' }); // alone: the router waited, and nothing came after it
          s = '';
        } else if (s.charCodeAt(1) < 0x20 || s.charCodeAt(1) === 0x7f) {
          keys.push({ kind: 'escape' }); // Esc, then a control key read with it
          s = s.slice(1);
        } else {
          // Esc and then a key at once (Alt+key), or a sequence the tab has no use for.
          keys.push({ kind: 'other' });
          s = s.slice(other ? other[0].length : 1);
        }
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        flushText();
        keys.push(CONTROLS[code] ?? { kind: 'other' });
        s = s.slice(1);
        continue;
      }
      text += s[0];
      s = s.slice(1);
    }
    flushText();
    return keys;
  }
}
