// A board that listens only on this computer refuses requests that came
// through a tunnel or a proxy (T188, finding 6).
//
// On a loopback address there is no token (access.ts): whatever reaches the
// server is taken to come from this computer. A tunnel or reverse proxy
// running here (ngrok, cloudflared, `tailscale serve`, a dev proxy) breaks
// that: it passes on requests from anywhere, from 127.0.0.1. One that also
// rewrites the Host header (ngrok's --host-header=rewrite, cloudflared's
// httpHostHeader) gets past the DNS-rebinding check too, so the internet
// would reach the board with no token, as if it were you.
//
// Those programs say so: each adds a header naming where the request came
// from (FORWARDING_HEADERS). A request that carries one is refused here,
// before every route and the UI, with a word on network mode, the way to
// reach Tricot from elsewhere: there it wants its token on everything,
// however a request came. Tricot's own clients (its page, the tricot
// command, the hooks) never send these headers.
//
// What it can't tell: a forwarder that adds no header, such as an SSH tunnel
// (`ssh -L`, which needs your own login to open, and is the way the docs
// give) or a plain TCP relay. Network mode (--host) is left as it is.
import type { RequestHandler } from 'express';

// What tunnels and proxies add, as Node names headers (lower case).
export const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'tailscale-user-login',
  'tailscale-user-name',
] as const;

export const THROUGH_A_TUNNEL =
  'Refused: this request came through a tunnel or a proxy, and Tricot here listens only on this computer. To reach it from elsewhere, start it in network mode (tricot --host 0.0.0.0, or a LAN address) and use the token it prints.';

// For a board on a loopback address: refuse any request with a forwarding header.
export function tunnelCheck(): RequestHandler {
  return (req, res, next) => {
    if (FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)) {
      res.status(403).json({ error: THROUGH_A_TUNNEL });
      return;
    }
    next();
  };
}
