// The calls of one MCP session whose HTTP connection closed before they were
// answered: the agent quit, its computer slept, or its client gave up on the
// call without saying so. The SDK ends a call early only when the client
// cancels it or the session closes; a wait whose agent hung up would
// otherwise hold its timer and its place on the board for up to 15 minutes,
// with the agent shown listening all the while. Stopping the server closes
// every connection, so its waits end the same way.
//
// app.ts watches each POST before the SDK reads it; the session ends a call
// when its connection closes (session.ts).
import type { ServerResponse } from 'node:http';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';

export class Hangups {
  private readonly open = new Map<RequestId, AbortController>();

  // The requests in a POST's body (one message, or a batch), each until its
  // response has ended: aborted if the connection closes first.
  watch(body: unknown, res: ServerResponse): void {
    const watched = requestIds(body).map((id) => {
      const controller = new AbortController();
      this.open.set(id, controller);
      return { id, controller };
    });
    if (watched.length === 0) return;
    res.once('close', () => {
      const hungUp = !res.writableFinished;
      for (const { id, controller } of watched) {
        if (this.open.get(id) === controller) this.open.delete(id);
        if (hungUp) controller.abort(new Error('The agent hung up before the call was answered.'));
      }
    });
  }

  // Aborts when the connection carrying this call closes before its answer.
  signal(id: RequestId): AbortSignal | undefined {
    return this.open.get(id)?.signal;
  }
}

function requestIds(body: unknown): RequestId[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object' || !('method' in message) || !('id' in message)) return [];
    const { id } = message as { id: unknown };
    return typeof id === 'string' || typeof id === 'number' ? [id] : [];
  });
}
