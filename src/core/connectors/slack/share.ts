// What a decision becomes as a Slack message when a person shares it: the
// question, the options and a link back to the card. One function, for the
// server, which posts it, and the page, which shows it first. Browser-safe.

import { clip } from '../../format';
import type { Decision } from '../../types';

// Slack reads &, < and > in a message as its own markup: an option that says "<!channel>" must not ping anyone.
export const slackEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const OPTION_WORDS = 140;
const QUESTION_WORDS = 300;

export function decisionMessage(decision: Pick<Decision, 'number' | 'question' | 'options' | 'recommendation'>, link: string): string {
  const options = decision.options.filter((option) => !option.outdated);
  const lines = [`*Decision #${decision.number}: ${slackEscape(clip(decision.question, QUESTION_WORDS))}*`, ''];
  options.forEach((option, at) => {
    const letter = option.id.length === 1 ? option.id.toUpperCase() : String.fromCharCode(65 + at);
    const said = option.description ? `: ${slackEscape(clip(option.description, OPTION_WORDS))}` : '';
    const mark = decision.recommendation?.optionId === option.id ? ' _(recommended)_' : '';
    lines.push(`• *${letter}.* ${slackEscape(clip(option.label, OPTION_WORDS))}${said}${mark}`);
  });
  lines.push('', `<${link}|Open the decision on the Tricot board>`);
  return lines.join('\n');
}
