// The Tricot skill `tricot connect` adds to an agent that has skills: "show me … on Tricot" works with Tricot stopped, or with the agent's
// Tricot tools missing, because the skill lives in the agent's own folder and
// is still there when its MCP server has failed. It teaches the whole
// `tricot show` flow (docs/cli.md, "Showing something from an agent's
// terminal"): make the page, hand back the link, and listen for what the
// person asks on it and answer. The prompt hook (hooks/tricot-show.mjs) stays
// for live steps; its "show" line is retired only after a trial of this skill.
//
// What makes the agent use it, and when it stays out of the way, is its
// description, which carries the phrasings and the false-alarm rules of the
// hook's showAsked (hooks/tricot-show.mjs's header says them in full): a
// request to see something on Tricot, the board or the canvas, and not a
// question about Tricot's own code, nor the board's tasks, decisions and cards.
//
// The text is the same for every agent but for what each says of itself: its
// name and id (`--agent claude`; an agent that reads another agent's skills
// folder, as Cursor reads Claude Code's, is told to give its own), whether a command it runs in the background wakes it
// when it ends (its mcpClient.listens), and how it brings its Tricot tools
// back (its skill form's reconnect). It never changes the agent's permissions
// (no allowed-tools): that is the person's.
//
// The file ends with a line that says who wrote it and a checksum of the text
// above it. A file whose checksum holds is Tricot's, as it wrote it, and a newer
// Tricot may replace it (keeping a copy); one whose checksum doesn't hold was
// edited by its owner, and one with no such line is theirs: both are left as
// they are (writtenByTricot).

import { createHash } from 'node:crypto';
import type { AgentKind } from '../core/agents/agent';

export const SKILL_NAME = 'tricot-show';
export const SKILL_FILE = 'SKILL.md';

// The description is what the agent reads to decide. Under the 1,024 characters
// the Agent Skills format allows, with the phrasings first, and no colon
// followed by a space (a plain YAML value stops there).
export const SKILL_DESCRIPTION =
  'Use when the person asks to see something on or in Tricot, the board or the canvas, for example "show me the last dev log in tricot", "put the auth flow on the board" or "draw the architecture on the canvas". It makes a Sketchbook page with `tricot show` and hands back its link, even while Tricot is stopped or your Tricot tools are missing. Not for questions or edits about Tricot\'s own code ("show me the tests in tricot", "how does the tricot listener work"), and not for the board\'s tasks, decisions or cards, which Tricot\'s own tools handle.';

// What follows `--agent`: an agent's id, which `tricot show` takes as its name on the board.
const idWord = (kind: AgentKind) => kind.id;

// The step that listens for what the person asks on the page. An agent whose
// background command starts its next turn when it ends runs the listener there;
// any other is told to run it when the person says they have asked.
function listenSteps(kind: AgentKind): string[] {
  const agent = idWord(kind);
  const answer = [
    `   Answer with \`tricot show --page <id> --reply "your words" [files] --agent ${agent}\`, adding \`--to <id>\` as the listener printed it, and the files become blocks under your reply.`,
    '   A request for something only your own Tricot tools make is answered with them; without them, say so.',
  ];
  const background = kind.mcpClient.listens?.background;
  if (background) {
    return [
      `5. To hear what the person asks on the page, in its chat bar or about blocks they select, run \`tricot show --listen --page <id> --agent ${agent}\` in the background (${background}), with the page id the command printed. It ends when the person asks you something, printing what they said, who said it and how to answer, and its ending starts your next turn. Run it again after each answer.`,
      ...answer,
    ];
  }
  return [
    `5. The person can ask you something on the page, in its chat bar or about blocks they select. You can't be woken by a command that runs in the background, so tell them to say here when they have asked. Then run \`tricot show --listen --page <id> --agent ${agent}\`: it prints what they asked, who asked and how to answer, and ends.`,
    ...answer,
  ];
}

// The skill as one agent reads it, before the line that says who wrote it.
function body(kind: AgentKind): string {
  const agent = idWord(kind);
  const reconnect = kind.skill?.reconnect;
  if (!reconnect) throw new Error(`${kind.name} has no skill form, so there is no skill to write for it.`);
  return [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    '---',
    '',
    '# Show something on Tricot',
    '',
    'The person wants to see something on Tricot: its board, its canvas or its Sketchbook. Put it on a Sketchbook page and give them the link. `tricot show` starts Tricot if it is stopped and makes the page itself, so this works with Tricot stopped and with no Tricot tools in your session. If your Tricot tools are there (add_page, then add_block), you can use them instead.',
    '',
    "Never write the answer in the terminal instead. If you can't make the page, say why in one line.",
    '',
    '## When this applies',
    '',
    'Go by what the person said. It applies when they ask to see, show, draw, sketch, diagram, chart, map out, lay out or put something on Tricot, the Tricot board, the board, the canvas or the Sketchbook, or ask for a diagram there.',
    '',
    'It does not apply to a message that only mentions Tricot, to a question about how something works or what a command does ("show me how to ..."), to Tricot as a name or a path (tricot/src, tricot.ts, the tricot repo), to the board\'s own tasks, decisions and cards, or to a change to Tricot\'s code. "In tricot" can mean the project: "show me the last dev log in tricot" means the board, and "show me the tests in tricot" means the code. If you can\'t tell, ask in one line.',
    '',
    '## Steps',
    '',
    '1. Make what to show. Each file becomes a block on the page, in the order you name them: .md or .txt a note, .mmd a Mermaid diagram, .csv a table (its first row the columns), .png, .jpg, .gif or .webp an image, and any other file code. Write the files in the system\'s temporary folder, not in the person\'s project. For one block, pipe it in with `-` instead (`--as diagram`, `table` or `code`; a note unless said), and `--text "words"` adds a short note first.',
    '',
    '2. Make the page:',
    '',
    '   ```sh',
    `   tricot show - --as diagram --title "Sign-in flow" --agent ${agent} --asked "show me the sign-in flow" <<'EOF'`,
    '   flowchart TD',
    '     A[Sign in] --> B[Check the password]',
    '   EOF',
    '   ```',
    '',
    `   Or with files: \`tricot show flow.mmd timing.csv --title "Sign-in flow" --agent ${agent} --asked "show me the sign-in flow"\`. \`--title\` names the page for what it shows, \`--agent ${agent}\` is you (the page is made as you, never as the person, and what the person asks on it comes to you; if you are not ${kind.name}, give your own name or id instead), and \`--asked\` is what the person asked, in their own words. In PowerShell, pipe a here-string into it in place of the heredoc.`,
    '',
    '3. If it lists boards and exits with code 2, it needs to know which one. Ask the person, then run it again with `--board <id>`, or with `--new-board "<name>"` when they ask for a new board. Never choose a board for them.',
    '',
    '4. Give the person the link it printed, on a line of its own, with one line on what the page shows.',
    '',
    ...listenSteps(kind),
    '',
    `6. To add to the page later: \`tricot show --page <id> <files> --agent ${agent}\`.`,
    '',
    '## If `tricot show` does not work',
    '',
    '- It says "Unknown command", or that Tricot or the board is too old: run `tricot update`. It may ask the person to allow it in their browser, or print a command for them to run. Show them that command and ask before you run it. If it can\'t update, ask the person to start Tricot (run `tricot` in a terminal), then to ' + reconnect + ', and to ask again. Do not print the answer in the terminal in its place.',
    "- It says `tricot` is not found: Tricot isn't installed on this computer. Tell the person.",
    '',
    '## Last, bring your Tricot tools back',
    '',
    `Once the page is up, tell the person that to have Tricot's own tools in this session as well, they can ${reconnect}. The page doesn't need that.`,
    '',
    '',
  ].join('\n');
}

const STAMP_START = '<!-- Added by tricot connect. Tricot updates this file only while it is as Tricot wrote it: edit it and Tricot leaves it alone. Checksum ';
const STAMP = new RegExp(`^${STAMP_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]{16})\\. -->\\n$`);

const checksum = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// A text with the line that says whose it is after it.
export const withStamp = (text: string): string => `${text}${STAMP_START}${checksum(text)}. -->\n`;

// The whole file for an agent: the skill, then the line that says whose it is.
export const skillText = (kind: AgentKind): string => withStamp(body(kind));

// Whether a file is Tricot's as Tricot wrote it (some version of it): it ends
// with Tricot's line and the checksum holds. A file edited since, one with no
// such line, and one Tricot's line was cut from or added to are their owner's.
export function writtenByTricot(text: string): boolean {
  const at = text.lastIndexOf('\n<!--') + 1;
  const found = at > 0 ? STAMP.exec(text.slice(at)) : null;
  return Boolean(found) && checksum(text.slice(0, at)) === found![1];
}
