import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// One topic of the guide, as an agent reads it with read_guide: the how-to the
// tools' descriptions leave out.
export async function readGuide(client: Client, topic: string): Promise<string> {
  const result = (await client.callTool({ name: 'read_guide', arguments: { topic } })) as { content: { type: string; text?: string }[] };
  return result.content.map((part) => part.text ?? '').join('\n');
}
