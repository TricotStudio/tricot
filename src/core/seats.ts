// Seats (T187): the browsers and terminals a person has let in. Only a seat
// does what is consequential as the person (server/access.ts says which
// actions those are); anything else that reaches Tricot, a page or a
// terminal, does the rest.
//
// A seat holds a P-256 key pair whose private half never leaves it: a
// browser makes it with WebCrypto as non-extractable and keeps it in
// IndexedDB (web/seat.ts); a Tricot terminal keeps it in memory for as long
// as it runs (cli/terminalSeat.ts). The server keeps each seat's public
// half in the data folder (server/seats.ts). A seat signs each request that
// needs it, and the server checks the signature, its time and its counter.
//
// Types, words and the text a seat signs: the browser imports this.

import { clip } from './format';

export type SeatKind = 'browser' | 'terminal';

// The headers a signed request carries: which seat, when (ms since the
// epoch), and `<counter>.<signature>`, the signature in base64url.
export const SEAT_HEADER = 'Tricot-Seat';
export const SEAT_TIME_HEADER = 'Tricot-Time';
export const SEAT_SIGNATURE_HEADER = 'Tricot-Signature';

// The query parameter a stream's ticket comes in (an EventSource sends no headers).
export const TICKET_PARAM = 'ticket';

// What a refusal says in `code`, so the page or the terminal knows what to do:
// it needs a seat (and asks to be let in), or the seat it signed with is gone
// (removed, or another data folder), so it asks again.
export const SEAT_NEEDED = 'seat_needed';
export const SEAT_GONE = 'seat_gone';

// How long a request's time may be from the server's, either way.
export const SEAT_CLOCK_MS = 2 * 60_000;
// How long an admission waits for the person's answer.
export const ADMISSION_MS = 3 * 60_000;

// A P-256 public key, as JWK.
export interface SeatPublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

// A seat as the person's list shows it.
export interface SeatView {
  id: string;
  kind: SeatKind;
  label: string; // "Chrome on macOS", "Tricot's terminal"
  admittedAt: string;
  admittedBy: string; // in words: "by a keypress in Tricot's terminal (the first)", "from Safari on macOS"
  lastUsedAt?: string;
  you?: boolean; // the one asking
}

// An admission waiting for the person, as seats see it.
export interface AdmissionView {
  id: string;
  code: string; // four digits, shown by the one asking too
  kind: SeatKind;
  label: string;
  at: string;
  expiresAt: string;
  first?: boolean; // no seat exists yet: the first browser, let in from any Tricot terminal
}

export type AdmissionStatus = 'waiting' | 'admitted' | 'denied' | 'expired';

// What the one asking reads of its admission.
export interface AdmissionState {
  id: string;
  code: string;
  state: AdmissionStatus;
  expiresAt: string;
  seat?: string; // once admitted: the seat's id, which its requests name
  by?: string; // who answered, in words
  first?: boolean; // the first browser: any Tricot terminal lets it in
  terminalSeat?: string; // answering the first browser: the terminal that let it in, let in with it
}

// The text a seat signs: what the request is (its method, its path with its
// query, a SHA-256 of its body in base64url), when, its counter, and which
// seat. One line each, so no part can run into the next.
export function signedText(parts: { method: string; path: string; bodyHash: string; time: number; counter: number; seat: string }): string {
  return ['tricot-seat-1', parts.method.toUpperCase(), parts.path, parts.bodyHash, String(parts.time), String(parts.counter), parts.seat].join('\n');
}

export function signatureHeader(counter: number, signature: string): string {
  return `${counter}.${signature}`;
}

export function readSignatureHeader(value: string | undefined): { counter: number; signature: string } | undefined {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{40,200})$/.exec(value ?? '');
  if (!match) return undefined;
  const counter = Number(match[1]);
  return Number.isSafeInteger(counter) && counter > 0 ? { counter, signature: match[2] } : undefined;
}

// ---- words ---------------------------------------------------------------------

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bBrave\b/, 'Brave'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\b(?:Headless)?Chrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\biPhone\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

// A browser as the person knows it, from what it says it is: "Chrome on
// macOS". Anything can say it is anything: the code is what tells the one
// asking from another, never this.
export function browserLabel(userAgent: string | undefined): { label: string; where: string } {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'A browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  return { label: system ? `${browser} on ${system}` : browser, where: browser === 'A browser' ? 'a browser' : browser };
}

export const TERMINAL_LABEL = "Tricot's terminal";

// A terminal says what it is in a few words ("tricot claude codex in tricot"):
// one line, short, and shown as text alone.
export function terminalLabel(said: unknown): string {
  const words = typeof said === 'string' ? clip(said.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' '), 60) : '';
  return words ? `${TERMINAL_LABEL} (${words})` : TERMINAL_LABEL;
}

// "A browser wants to act for you (Chrome on macOS, code 4271)".
export function admissionWords(admission: Pick<AdmissionView, 'kind' | 'label' | 'code'>): string {
  const who = admission.kind === 'terminal' ? 'A terminal' : 'A browser';
  return `${who} wants to act for you (${admission.label}, code ${admission.code})`;
}
