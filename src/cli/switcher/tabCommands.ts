// Navigation inside the Tricot tab, distinct from skills sent to an agent.
export const TAB_COMMANDS = [
  { name: 'status', description: 'Agents, approvals and board activity' },
  { name: 'threads', description: 'Browse conversations' },
  { name: 'new', description: 'Start a new thread' },
] as const;

export type TabCommand = (typeof TAB_COMMANDS)[number]['name'];

export function tabCommand(text: string): TabCommand | undefined {
  return TAB_COMMANDS.find((command) => text.trim() === `/${command.name}`)?.name;
}
