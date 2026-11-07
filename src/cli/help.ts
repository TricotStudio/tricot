// What `tricot --help` and `tricot <command> --help` say, and what an unknown
// command says. The main help is short: the commands, and the options that go
// with starting or reaching the board. Each command's own help says what it
// does and lists only the options it takes (parseArgs accepts every option with
// every command, so these lists are what the help promises, not what is refused).
// All of it is read from the table of commands (commands.ts): this file only
// lays the words out, and finds the closest command to a mistyped one.
import { isAgentCommand } from './agentCommand';
import { COMMANDS, findCommand, type CliCommand } from './commands';
import { BACKGROUND, DATA, HELP, NO_OPEN, NO_UPDATE_CHECK, PORT, VERSION, type Option } from './options';

const WIDTH = 92;
const COMMAND_COLUMN = 26; // the commands' names, then their words
const OPTION_COLUMN = 21; // the options' names, then their words

// The text, wrapped to `width` and indented. A word that is too long stays on a line of its own.
function wrap(text: string, indent: number, width = WIDTH): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent + line.length + 1 + word.length > width) {
      lines.push(pad + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(pad + line);
  return lines;
}

// A name in a column, and its words beside it (and under it, when they take more lines).
function rows(items: [name: string, words: string][], column: number): string[] {
  return items.flatMap(([name, words]) => {
    const [first = '', ...rest] = wrap(words, 0, WIDTH - column);
    return [`  ${name}`.padEnd(column) + first, ...rest.map((line) => ' '.repeat(column) + line)];
  });
}

const optionRows = (options: Option[]) => rows(options.map(({ usage, words }) => [usage, words]), OPTION_COLUMN);

// ---- the main help ------------------------------------------------------------------

// `command`: the one a person named in a line the parser refused, whose own help is the way on.
export function mainHelp(version: string, command?: string): string {
  const commands = COMMANDS.filter((entry) => entry.summary !== undefined).map((entry): [string, string] => [entry.label ?? `tricot ${entry.name}`, entry.summary!]);
  return [
    `tricot ${version}: a shared planning board for you and your agents`,
    '',
    'Usage',
    ...rows(commands, COMMAND_COLUMN),
    '',
    'Options',
    ...optionRows([PORT, DATA, NO_OPEN, NO_UPDATE_CHECK, BACKGROUND, VERSION, HELP]),
    '',
    command ? `Run tricot ${command} --help for what it does and the options it takes.` : 'Run tricot <command> --help for what a command does and the options it takes.',
  ].join('\n');
}

// ---- each command's help ----------------------------------------------------------

function render({ help, options }: CliCommand): string {
  return [
    help.title,
    '',
    'Usage',
    ...help.usage.map((line) => `  ${line}`),
    '',
    ...help.about.flatMap((paragraph) => [...wrap(paragraph, 0), '']),
    'Options',
    ...optionRows(options),
    '',
    'All the commands: tricot --help',
  ].join('\n');
}

// Whether `word` is a command or an agent command.
export const isKnownCommand = (word: string): boolean => findCommand(word) !== undefined;

// The help for a command or an agent command (several agents share the first's); none for any other word.
export function commandHelp(word: string): string | undefined {
  const command = findCommand(word);
  return command && render(command);
}

// ---- an unknown command -------------------------------------------------------------

// Edits between two words: one letter added, removed or changed, or two side by side swapped.
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const commonStart = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

// The command or agent a mistyped word is closest to: at most 2 edits away, or 3
// when either word has 7 letters or more, and never more than half the word typed.
// With two as close, the one that starts the same for longer (`step` is steps, not stop),
// then the one that comes first: the commands, then the agents.
export function closestCommand(word: string): string | undefined {
  const typed = word.toLowerCase();
  let best: { name: string; edits: number; same: number } | undefined;
  const names = COMMANDS.map((command) => command.name);
  for (const name of [...names.filter((n) => !isAgentCommand(n)), ...names.filter(isAgentCommand)]) {
    const edits = distance(typed, name);
    if (edits > Math.min(Math.max(typed.length, name.length) >= 7 ? 3 : 2, Math.ceil(typed.length / 2))) continue;
    const same = commonStart(typed, name);
    if (!best || edits < best.edits || (edits === best.edits && same > best.same)) best = { name, edits, same };
  }
  return best?.name;
}

// What a word that isn't a command says: the new name when it was renamed, else the closest
// command if one is near, else where to see them all.
// `elsewhere`: the sentence about another `tricot` on the PATH, when it is another version than this one
// (otherInstalls.ts), for a command this one lacks and that one may have.
export function unknownCommand(word: string, elsewhere?: string): string {
  const said = `Unknown command "${word}".`;
  const renamed = COMMANDS.find((command) => command.formerly?.includes(word));
  const near = closestCommand(word);
  const advice = renamed ? `Did you mean "${renamed.name}"? (${word} was renamed)` : near ? `Did you mean "${near}"?` : 'Run tricot --help to see the commands.';
  return [said, advice, elsewhere].filter(Boolean).join(' ');
}
