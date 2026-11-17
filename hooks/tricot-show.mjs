// "Show me … on Tricot" in an agent's own terminal: a message that asks to
// see something on Tricot, its board or its canvas ("show me the last dev log
// in tricot", "put the auth flow on the board", "draw the architecture on the
// canvas") gets a line for the agent beside it (SHOW_CONTEXT): make a
// Sketchbook page showing it and give the person its link, or, without its
// Tricot tools, run `tricot show`. The prompt hook (tricot-prompt.mjs) and
// Pi's and OMP's extension (tricot-steps-extension.ts) read it from here,
// copied beside them, as they read the lenses from tricot-lenses.mjs. Plain
// JavaScript, no dependencies but Node's own.
//
// What counts, so that a message that only mentions Tricot stays as it is:
// - a request to show, in so many words: show, draw, sketch, diagram, chart,
//   map out, lay out, visualise, illustrate, display or put, at the start of
//   what is said or after "please", "can you", "I want you to"…; "let me
//   see", "can I see", "I'd like to see"; or "make a diagram" (a chart, a
//   sketch, a map…). Not "does Tricot show…", "the chart in tricot", "don't
//   put it on the board", nor "show me how to…" and "how can I see…", which
//   ask for steps;
// - then, later in the same sentence, Tricot as a place: on, onto, in or
//   into Tricot, the Tricot board, Tricot's board, the board, the canvas or
//   the Sketchbook. Tricot in a path or a name (tricot/src, src/tricot,
//   tricot.ts, tricot-steps, tricot's listener), or before a word for code
//   (the tricot repo, tricot cli, the canvas element), isn't one;
// - and nothing that is already the board's: tasks, decisions, cards and
//   tickets have tools of their own.
// "In tricot" is the one place that can just as well be a project named
// tricot ("show me the tests in tricot"). It counts only when what is shown
// names no code (a file, folder, path, test, function, commit, `code`…),
// when it ends what is asked ("…in tricot", "…in tricot, please") or comes
// straight after the verb ("show me in tricot …"), and never after put ("put
// a check in tricot" is an edit). Code blocks and `code` in the message are
// read as code, never as words. A guess can still be wrong, so the line says
// it is one, and to go by the person's words when they meant something else.
//
// When it does count, the line also depends on whether Tricot is running
// (showContextFor). With Tricot stopped the agent has no Tricot tools: its
// MCP server has failed, and it would answer in its own terminal, as it did
// when someone asked for "the last dev log in tricot" and the agent wrote the
// dev log in the shell. So the reader first asks the board, at the address the
// hook was set up with (tricot-steps.mjs's --url, Pi's and OMP's settings),
// whether it answers as Tricot, as the tricot command does (GET /api/info).
// - Up, or it can't be told (no answer in time, an error of its own, an
//   address it can't read): the line above, as before.
// - Not running: a line that says so plainly and gives the person the one
//   step (start Tricot, then run /mcp so the agent's tools reconnect). When
//   the `tricot` this computer runs has the show command (`tricot show
//   --help` answers), the line names it as the agent's own way, which also
//   starts Tricot; when it hasn't (Homebrew's 0.1.6 says "Unknown command"),
//   it doesn't, so the agent isn't sent to a command that isn't there.
// It sends the board one request with none of the person's words in it, only
// for a message that asks to see something on Tricot, and is done within
// WITHIN_MS whatever happens, inside the prompt hook's one second.

import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import os from 'node:os';

export const SHOW_CONTEXT =
  'The person likely wants this shown on Tricot: make a Sketchbook page showing it (add_page, asked: their words, then add_block) and answer with its link. Without your Tricot tools, run `tricot show` (see `tricot show --help`). If they meant something else, ignore this.';

// The same, with Tricot stopped: the agent has no Tricot tools, and is told so
// plainly, with the one step for the person (start Tricot, then /mcp). With
// `tricot show` on this computer, it is named as the agent's own way, which
// starts Tricot itself; without it, the line doesn't mention it.
export const SHOW_CONTEXT_DOWN =
  "The person likely wants this shown on Tricot, but Tricot isn't running, so your Tricot tools aren't there. Run `tricot show` (see `tricot show --help`) rather than printing it in the terminal: it starts Tricot and makes the page. Then tell the person to run /mcp so your Tricot tools reconnect. If they meant something else, ignore this.";
export const SHOW_CONTEXT_DOWN_NO_SHOW =
  "The person likely wants this shown on Tricot, but Tricot isn't running, so your Tricot tools aren't there. Don't print it in the terminal instead: tell the person to start Tricot, then run /mcp so your Tricot tools reconnect, and to ask again. If they meant something else, ignore this.";

const LONGEST = 1000; // a sentence longer than this is pasted text, not an ask
const REACH = 200; // how far after its verb the place may be: "show me … on the board"
const ENDS = 10_000; // of a longer message, its start and its end, where an ask is

// The requests, each said as one. A verb of showing must be a request where
// it stands (lead below); "let me see" and the like are one already.
const VERB = /\b(show|display|draw|sketch|diagram|chart|map(?:\s+out)?|lay\s+out|visuali[sz]e|illustrate|put)\b/gi;
const MAKE = /\b(?:make|create|draw|do|give\s+(?:me|us))\s+(?:(?:me|us)\s+)?(?:a|an|some)\s+(?:(?:quick|simple|rough|little|small|big)\s+)?(?:diagram|chart|graph|sketch|drawing|map|picture|visual(?:i[sz]ation)?|flow\s*chart|mock-?up|wireframe)s?\b/gi;
const SEE = /\b(?:let\s+(?:me|us)|let's|lets|lemme|(?:i|we)(?:\s+(?:want|need|would\s+like)|'d\s+like)\s+to|(?:i|we)\s+wanna|(?:can|could|may)\s+(?:i|we))\s+(?:please\s+)?see\b/gi;

// The word before a verb of showing that leaves it a request: "please draw",
// "can you draw", "I want you to draw", "and draw". After "how to", "able
// to" and the like, it is a question or a statement.
const LEADS = new Set(['please', 'pls', 'plz', 'kindly', 'you', 'u', 'to', 'and', 'also', 'just', 'now', 'so', 'then', "let's", 'lets', 'go', 'me', 'us', 'quickly', 'first', 'ok', 'okay', 'hey', 'maybe']);
const NOT_A_REQUEST_TO = /\b(?:how|way|ways|able|unable|used|where|what|when|whether|trying|tried)\s+to$/i;
const NEGATED = /\b(?:don't|dont|do\s+not|doesn't|didn't|won't|never|not|no\s+need\s+to|stop|without)\s+(?:[\w']+\s+){0,2}$/i;
const STEPS_ASKED = /^\s+(?:me|us)\s+how\s+(?:to|do\s+(?:i|we|you)|(?:can|could|would|should)\s+(?:i|we)|(?:i|we)\s+(?:can|could|would|should))\b/i;
// "Let's see if the tests pass", "let's see what happens": waiting, not looking.
const WAIT_AND_SEE = /^\s+(?:if|whether|what\s+happens)\b/i;
// "How can I see the activity on the board?": asking how to, not to be shown.
const ASKS_HOW = /\b(?:how|where|why|when)\s*$/i;

// Tricot as a place, after on, onto, in or into (group 1): Tricot's board
// (first, as the longer match), the Tricot board, Tricot alone (group 2), or
// the board, the canvas or the Sketchbook.
const PLACE = /\b(on|onto|in|into)\s+(?:tricot's\s+(?:board|canvas|sketchbook)|(?:the\s+)?tricot\s+(?:board|canvas|sketchbook)|(tricot)|(?:the|my|our|your|this|that)\s+(?:board|canvas|sketchbook)|sketchbook)(?![\w-])/gi;
// What makes it a path or a name instead: tricot/src, tricot.ts, tricot's listener.
const PATH_OR_NAME = /^(?:[\w-]|[./\\:@#]\w|'s\b)/i;
// A word for code after it: the tricot repo, the canvas element.
const CODE_AFTER =
  /^\s+(?:repo|repository|codebase|code|source|src|project|package|module|folder|directory|dir|cli|command|server|app|hooks?|tests?|files?|docs|branch|worktree|build|readme|components?|element|api|context|ref|lib|library|styles?|css|class|function)\b/i;
// What is the board's already, with tools of its own.
const BOARD_ITEMS = /\b(?:tasks?|tickets?|cards?|backlog|decisions?(?!\s+trees?))\b/i;
const AS_BOARD_ITEM = /^\s+as\s+(?:an?\s+)?(?:tasks?|tickets?|cards?|decisions?)\b/i;
// What names code, for "in tricot": a path, a file, `code`, or a word for it.
const NAMES_CODE =
  /[\w-][/\\][\w.-]|\b[\w-]+\.[a-z]{1,4}\b|\b(?:code|files?|folders?|dir|director(?:y|ies)|functions?|class(?:es)?|methods?|tests?|specs?|lines?|imports?|modules?|errors?|bugs?|commits?|branch(?:es)?|diffs?|components?|types?|variables?|config|readme|changelog|source|implementation|where)\b/i;
// What may follow "in tricot" when it ends what is asked: nothing, a comma,
// "please", "so I can…", "with the dates".
const ENDS_ASK =
  /^\s*(?:$|[,:)(\-–—]|(?:please|pls|plz|too|now|again|also|as\s+well|for\s+(?:me|us)|thanks?|thank\s+you|so|and|but|or|to|because|since|while|when|if|with|as|from|like|instead)\b)/i;
// The pronoun a verb may take before "in tricot": "show me in tricot …".
const RIGHT_AFTER = /^\s*(?:(?:me|us|it|this|that|them)\s*)?$/i;

// The person's words, sentence by sentence: code blocks left out, `code`
// read as the word code, a leading ^Lens taken off, curly apostrophes made
// plain, and of a long paste only its start and its end.
function sentences(text) {
  const words = text
    .replace(/^\s*\^[\p{L}\p{N}_-]*[:,]?/u, '')
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' code ')
    .replace(/[\u2018\u2019]/g, "'");
  const read = words.length > 2 * ENDS ? `${words.slice(0, ENDS)}\n${words.slice(-ENDS)}` : words;
  return read.split(/\n|[.!?;]+(?=\s|$)|\bthen\b/i).filter((s) => s.trim() && s.length <= LONGEST);
}

// Whether the verb at `at` in the sentence is said as a request.
function isRequest(sentence, at) {
  const before = sentence.slice(0, at).trimEnd();
  if (NEGATED.test(`${before} `)) return false;
  if (!before || /[,:(\-–—"]$/.test(before) || /@[\w-]+$/.test(before)) return true;
  const lead = before.match(/([\p{L}']+)$/u)?.[1]?.toLowerCase();
  if (!lead || !LEADS.has(lead)) return false;
  return !(lead === 'to' && NOT_A_REQUEST_TO.test(before));
}

// Every request in a sentence: where it ends, and its verb.
function requests(sentence) {
  const found = [];
  for (const m of sentence.matchAll(VERB)) {
    if (isRequest(sentence, m.index) && !STEPS_ASKED.test(sentence.slice(m.index + m[0].length))) found.push({ end: m.index + m[0].length, verb: m[1].toLowerCase() });
  }
  for (const m of sentence.matchAll(MAKE)) if (isRequest(sentence, m.index)) found.push({ end: m.index + m[0].length, verb: 'make' });
  for (const m of sentence.matchAll(SEE)) {
    const end = m.index + m[0].length;
    const before = sentence.slice(0, m.index);
    if (!NEGATED.test(before) && !ASKS_HOW.test(before) && !WAIT_AND_SEE.test(sentence.slice(end))) found.push({ end, verb: 'see' });
  }
  return found;
}

// Whether a request is aimed at Tricot as a place, later in its sentence.
function aimedAtTricot(sentence, request) {
  for (const place of sentence.slice(request.end, request.end + REACH).matchAll(PLACE)) {
    const start = request.end + place.index;
    const shown = sentence.slice(request.end, start);
    const after = sentence.slice(start + place[0].length);
    if (PATH_OR_NAME.test(after) || CODE_AFTER.test(after)) continue;
    if (BOARD_ITEMS.test(shown) || AS_BOARD_ITEM.test(after)) return false;
    const inTricot = place[2] !== undefined && /^in/i.test(place[1]);
    if (inTricot && (request.verb === 'put' || NAMES_CODE.test(shown) || !(ENDS_ASK.test(after) || RIGHT_AFTER.test(shown)))) continue;
    return true;
  }
  return false;
}

// Whether a message asks to see something on Tricot, the board or the canvas.
export function showAsked(text) {
  if (typeof text !== 'string') return false;
  return sentences(text).some((sentence) => requests(sentence).some((request) => aimedAtTricot(sentence, request)));
}

// What the agent is told beside such a message; none for any other.
export const showContext = (text) => (showAsked(text) ? SHOW_CONTEXT : undefined);

// ---- is Tricot running? -------------------------------------------------------------

// How long all of it may take, from the board's first question to the end of
// the look for `tricot show`: the prompt hook gives up at a second, and Node
// takes a few hundredths to start. Pi's and OMP's extension holds a message up
// for no longer, and only for one that asks to see something on Tricot.
export const WITHIN_MS = 750;
const BOARD_MS = 500; // the board's answer: it takes a few milliseconds when it is up
const CONNECT_MS = 300; // a connection to this computer's own address (below)
const PROBE_MS = 350; // `tricot show --help`
const MIN_PROBE_MS = 100; // with less left than this, the look is skipped
const DEFAULT_URL = 'http://127.0.0.1:4545';
const LOOPBACK_IPS = ['127.0.0.1', '::1'];

// The errors that say nothing is there: a refused connection, one that was
// reset, a host or network that can't be reached, a name that isn't known. A
// timeout, or anything not on this list, says nothing about it.
const NOTHING_THERE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']);

const LATE = Symbol('late');

// A limit on a wait: the signal to give the request, and what settles, as
// LATE, when the time is up. `stop` takes the timer away.
function limit(ms) {
  const controller = new AbortController();
  let timer;
  const up = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(LATE);
    }, ms);
  });
  return { signal: controller.signal, up, stop: () => clearTimeout(timer) };
}

const codesOf = (error) => [error?.code, error?.cause?.code, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map((e) => e?.code) : [])];

// Whether something takes a connection at an address of this computer: 'yes',
// 'no' (refused, or not taken within `ms`) or 'unknown'. A program that
// listens takes one at once, even while it is busy, as the system completes
// the connection for it; so on this computer's own address, one not taken in a
// moment means nothing listens. Waiting for the word "refused" isn't the same:
// Windows can take two seconds to say it, which is more than the hook has.
function listening(host, port, ms, open) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    const done = (answer) => {
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // gone already
      }
      resolve(answer);
    };
    timer = setTimeout(() => done('no'), ms);
    try {
      socket = open({ host, port });
      socket.once('connect', () => done('yes'));
      // Kept on, not once: an error after the answer must still have a listener, or it would end the process.
      socket.on('error', (error) => done(codesOf(error).some((code) => NOTHING_THERE.has(code)) ? 'no' : 'unknown'));
    } catch {
      done('unknown');
    }
  });
}

// Whether the board answers at `url`: 'up' (it answers as Tricot does for
// GET /api/info, which is how the tricot command knows a board; a board that
// wants a token and says so is up too), 'down' (nothing answers, or what does
// isn't Tricot), or 'unknown' (not in time, an error that says nothing about
// it, an address that can't be read). `token` is sent as the bearer token a
// board beyond this computer needs, as the steps hook sends it. The rest is
// for tests: the `fetch` and `connect` to use, and `ms`, the limit.
export async function boardState(url, { token, fetch: ask = globalThis.fetch, connect: open = connect, ms = BOARD_MS } = {}) {
  let address;
  try {
    address = new URL(`${String(url).replace(/\/+$/, '')}/api/info`);
  } catch {
    return 'unknown';
  }
  if (typeof ask !== 'function') return 'unknown';
  const wait = limit(ms);
  try {
    const host = address.hostname.replace(/^\[(.*)\]$/, '$1');
    if (LOOPBACK_IPS.includes(host)) {
      const port = Number(address.port) || (address.protocol === 'https:' ? 443 : 80);
      if ((await listening(host, port, Math.min(CONNECT_MS, ms), open)) === 'no') return 'down';
    }
    const res = await Promise.race([ask(address.href, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: wait.signal }), wait.up]);
    if (res === LATE || !res || typeof res.status !== 'number') return 'unknown';
    if (res.status === 401 && /bearer/i.test(res.headers?.get?.('www-authenticate') ?? '')) return 'up';
    if (res.status >= 500) return 'unknown';
    if (res.status < 200 || res.status >= 300) return 'down';
    let info;
    try {
      info = await Promise.race([res.json(), wait.up]);
    } catch (error) {
      return error instanceof SyntaxError ? 'down' : 'unknown'; // an answer that isn't JSON isn't Tricot's
    }
    if (info === LATE) return 'unknown';
    return info?.app === 'tricot' ? 'up' : 'down';
  } catch (error) {
    return codesOf(error).some((code) => NOTHING_THERE.has(code)) ? 'down' : 'unknown';
  } finally {
    wait.stop();
  }
}

// Whether the `tricot` on this computer's PATH has the show command, the one
// an agent would run: `tricot show --help` exits 0 and describes it. An older
// tricot says "Unknown command" and exits 1, and no tricot at all can't run.
// Run from the person's home folder, never the project's, so that nothing
// planted there is the tricot that answers (Windows looks in the folder it is
// in first); never in a shell of theirs (on Windows, where a program installed
// by npm is a .cmd file, the shell only starts it, and the words it is given
// are fixed); with no input, and a limit past which the answer is no, whether
// or not the program can be stopped. `--help` is answered before the command
// does anything. The rest is for tests: the `run` (execFile's) and `env` to
// use, and `ms`.
export function hasShowCommand({ env = process.env, run = execFile, ms = PROBE_MS } = {}) {
  return new Promise((resolve) => {
    let timer;
    const done = (answer) => {
      clearTimeout(timer);
      resolve(answer);
    };
    timer = setTimeout(() => done(false), ms + 25);
    try {
      const child = run(
        'tricot',
        ['show', '--help'],
        { env, cwd: os.homedir(), timeout: ms, killSignal: 'SIGKILL', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => done(!error && /\btricot show\b/.test(String(stdout))),
      );
      child?.stdin?.end();
    } catch {
      done(false);
    }
  });
}

// What the agent is told beside a message, as showContext, with Tricot's
// state taken into account (above): undefined for a message that doesn't ask
// to see something on Tricot, which costs nothing, the line for Tricot up or
// not known to be down, and the line for Tricot stopped. `options` are
// boardState's and hasShowCommand's, and `url`, where the board is.
export async function showContextFor(text, options = {}) {
  if (!showAsked(text)) return undefined;
  const started = Date.now();
  if ((await boardState(options.url ?? DEFAULT_URL, options)) !== 'down') return SHOW_CONTEXT;
  const left = Math.min(PROBE_MS, WITHIN_MS - (Date.now() - started));
  return left >= MIN_PROBE_MS && (await hasShowCommand({ env: options.env, run: options.run, ms: left })) ? SHOW_CONTEXT_DOWN : SHOW_CONTEXT_DOWN_NO_SHOW;
}
