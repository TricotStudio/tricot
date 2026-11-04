// A seat's key pair in Node (core/seats.ts, T187): a Tricot terminal's,
// made as it starts and held in this process's memory alone, never in a
// file, an environment variable or an argument, so no agent this terminal
// starts is given it. It signs a request as the browser's does
// (web/seat.ts): the method, the path, a hash of the body, the time and a
// counter that only goes up.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { SEAT_HEADER, SEAT_SIGNATURE_HEADER, SEAT_TIME_HEADER, signatureHeader, signedText, type SeatPublicKey } from '../core/seats';

export class SeatKey {
  readonly publicKey: SeatPublicKey;
  private readonly privateKey: KeyObject;
  private counter = 0;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  }

  // The headers that sign this request as `seat`: `path` with its query, as
  // the server reads it; `body` exactly as sent ('' for none).
  sign(seat: string, method: string, path: string, body: string | Buffer = '', time = Date.now(), counter = ++this.counter): Record<string, string> {
    const bodyHash = createHash('sha256').update(body).digest('base64url');
    const text = signedText({ method, path, bodyHash, time, counter, seat });
    const signature = sign('sha256', Buffer.from(text), { key: this.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { [SEAT_HEADER]: seat, [SEAT_TIME_HEADER]: String(time), [SEAT_SIGNATURE_HEADER]: signatureHeader(counter, signature) };
  }
}
