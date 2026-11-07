// The options of the `tricot` command: what each one is called, whether it takes
// a value, and the words the help says it with. Each command lists the options it
// takes in its own entry in the table (commands.ts); the ones several commands
// take are defined once here. Where one option means something a little
// different with each command (--board, --name, --yes), the command says it
// that way from the same option (`said`).

export interface Option {
  name: string; // the long name, without the dashes
  type: 'string' | 'boolean';
  short?: string;
  usage: string; // as the help shows it: `--port <n>`, `-d, --background`
  words: string;
}

const option = (name: string, type: Option['type'], usage: string, words: string, short?: string): Option => ({ name, type, usage, words, ...(short && { short }) });

// The same option, said another way.
export const said = (base: Option, words: string): Option => ({ ...base, words });

export const PORT = option('port', 'string', '--port <n>', 'Port (default $PORT or 4545)');
export const DATA = option('data', 'string', '--data <dir>', 'Where boards are kept (default $TRICOT_DATA_DIR or ~/.tricot)');
export const BOARD = option('board', 'string', '--board <id>', 'Open this board');
export const NAME = option('name', 'string', '--name <name>', "The agent's name on the board");
export const YES = option('yes', 'boolean', '--yes', "Don't ask (it still shows what it changes)", 'y');
export const NO_ASK = option('no-ask', 'boolean', '--no-ask', "Don't ask about live steps on the first start");
export const VERBOSE = option('verbose', 'boolean', '--verbose', 'With that question: show every file and line first');
export const NO_OPEN = option('no-open', 'boolean', '--no-open', "Don't open the browser");
export const NO_UPDATE_CHECK = option('no-update-check', 'boolean', '--no-update-check', "Don't ask GitHub once a day whether a newer Tricot is out (or set TRICOT_NO_UPDATE_CHECK=1)");
export const BACKGROUND = option('background', 'boolean', '-d, --background', 'Keep running after this terminal closes (logs to <data>/server.log)', 'd');
// An agent's model and thinking level for this run (core/agentRules.ts): each
// is the agent's named before it, and stands in for the rule set in its panel.
export const MODEL = option('model', 'string', '--model <name>', 'The model the agent starts on, this run (over the one set in its panel)');
export const EFFORT = option('effort', 'string', '--effort <level>', 'Its thinking level, this run');
// The options that belong to the agent named before them (main.ts Words.placed).
export const PER_AGENT = [MODEL.name, EFFORT.name];

// Every command takes these, and `tricot --help` lists them.
export const VERSION = option('version', 'boolean', '-v, --version', 'Print the version', 'v');
export const HELP = option('help', 'boolean', '-h, --help', "Show this help, or a command's: tricot <command> --help", 'h');

// Taken by every command and listed by none: the address the board listens on, and how an
// agent command starts the board.
export const HIDDEN: Option[] = [option('host', 'string', '--host <host>', ''), option('stop-with-agents', 'boolean', '--stop-with-agents', '')];
