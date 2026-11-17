// The Tricot tab's own commands, distinct from skills sent to an agent:
// /status, /threads and /new move around the tab, and /add, /stop, /open
// and /quit do what the status view's a, x, o and q do (tricotTab.ts).
// The "/" list offers them in this order, each with its description.
export const TAB_COMMANDS = [
  { name: 'status', description: 'Agents, approvals and board activity' },
  { name: 'threads', description: 'Browse conversations' },
  { name: 'new', description: 'Start a new thread' },
  { name: 'add', description: "Add an agent that isn't running" },
  { name: 'stop', description: 'Stop a running agent' },
  { name: 'open', description: 'Open the board in your browser' },
  { name: 'quit', description: 'Quit, closing every agent' },
] as const;

export type TabCommand = (typeof TAB_COMMANDS)[number]['name'];

export function tabCommand(text: string): TabCommand | undefined {
  return TAB_COMMANDS.find((command) => text.trim() === `/${command.name}`)?.name;
}

// What a command does, in its few words.
export const tabCommandWords = (command: TabCommand): string => TAB_COMMANDS.find((c) => c.name === command)!.description;

// "/status, /threads, … or /quit": every command, for saying which to choose.
export const TAB_COMMAND_LIST = ((names) => `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`)(TAB_COMMANDS.map((c) => `/${c.name}`));
