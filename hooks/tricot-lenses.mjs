// Tricot's lenses: what people look at the project through in a thread
// (Legal, Design…), each with a brief that says how agents answer, and how a
// message asks for one with a leading ^Name ("^Design please review this").
// The one list: Tricot takes it from here (src/core/threads.ts), and so do
// the prompt hook (tricot-prompt.mjs) and Pi's and OMP's extension
// (tricot-steps-extension.ts), which an agent runs from its own folder with
// this file copied beside it. Plain JavaScript, no dependencies.

// General is the default: no brief, so agents answer as they would anyway.
export const LENSES = [
  { name: 'General' },
  { name: 'Legal', brief: 'Review licences, terms of service and privacy. Flag each risk, say how serious it is, and cite your source.' },
  { name: 'Design', brief: 'Look at it as a product designer: flows, clarity and visuals. Show mocks or screenshots rather than describe them.' },
  { name: 'Performance', brief: 'Measure before you claim. Give numbers and profiles, and what each fix would cost.' },
  { name: 'Security', brief: 'Look for ways it could be misused or leak data. Be concrete: where it happens, and how to fix it.' },
  { name: 'Architect', brief: "Look at it as a software architect: how it is structured, where the boundaries are, and how it will grow. Prefer designs that stay extensible and fit the codebase's own conventions. Name the trade-offs and what a later change would cost, and draw a diagram when it helps." },
  { name: 'Marketing', brief: "Look at it as a marketer: who it is for, what to say and where to say it. Give concrete copy, channels and ways to measure each, and say what you are unsure of rather than inventing numbers." },
];

// A ^ at the very start (after any spaces), then a name: letters and digits,
// with - or _ inside it. What follows it, if anything, is the message.
const ASKED = /^\s*\^([\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?)(?![\p{L}\p{N}_-])/u;

// The lens a message asks for with a leading ^Name, matched whatever the
// case: { lens } for one of LENSES, { unknown } (the name as typed) for a name
// that isn't one, and undefined for a message that doesn't open with ^Name.
export function lensAsked(text) {
  if (typeof text !== 'string') return undefined;
  const match = ASKED.exec(text);
  if (!match) return undefined;
  const name = match[1];
  const lens = LENSES.find((l) => l.name.toLowerCase() === name.toLowerCase());
  return lens ? { lens } : { unknown: name };
}

// What the agent is told for one message asked through a lens: "Answer this
// message through the Design lens: Look at it as…". None for General, which
// has no brief.
export function lensContext(lens) {
  return lens?.brief ? `Answer this message through the ${lens.name} lens: ${lens.brief}` : undefined;
}

// The line an agent shows the person when ^Name isn't a lens, naming the ones
// ^ takes as a person types them: "^Legal, ^Design … or ^Marketing".
export function unknownLensLine(name) {
  const named = LENSES.filter((l) => l.brief).map((l) => `^${l.name}`);
  const names = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : named.join('');
  return `^${name} isn't one of Tricot's lenses, so your message goes as you typed it. In the terminal, ^ takes ${names}.`;
}
