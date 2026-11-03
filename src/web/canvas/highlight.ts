// A light syntax colouring for diff and code lines: keywords, strings,
// numbers and comments, chosen by the file's extension. Lines are read one at a time,
// carrying only whether a block comment is still open, so it stays quick and
// small. It is only ever a tint: the tokens always add up to the line as it
// was, and React escapes them.

import { languageByPath, type CodeLanguage } from '../../core/blocks/code/code';

export type TokenKind = 'kw' | 'str' | 'num' | 'com';

export interface Token {
  text: string;
  kind?: TokenKind;
}

interface Language {
  keywords: ReadonlySet<string>;
  lineComments: string[];
  blockComment?: [string, string];
  quotes: string; // characters that open a string, closed by the same one
  hashAtWordStart?: boolean; // shell: # starts a comment only where a word would
  charLiterals?: boolean; // rust: 'a' is a char, 'a alone a lifetime
  tags?: boolean; // markup: tag names read as keywords
  units?: boolean; // css: 12px, 50%, #fff and @media
  numbers?: boolean;
}

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));

const C_LIKE = { lineComments: ['//'], blockComment: ['/*', '*/'] as [string, string], numbers: true };

const JS: Language = {
  ...C_LIKE,
  quotes: `'"\``,
  keywords: words(`
    abstract as async await break case catch class const continue debugger declare default delete do else enum export
    extends false finally for from function get if implements import in instanceof interface keyof let namespace new null
    of private protected public readonly return satisfies set static super switch this throw true try type typeof
    undefined var void while yield string number boolean unknown never any bigint symbol object`),
};

const LANGUAGES: Record<string, Language> = {
  js: JS,
  json: { ...C_LIKE, quotes: '"', keywords: words('true false null') },
  css: { blockComment: ['/*', '*/'], lineComments: [], quotes: `'"`, units: true, numbers: true, keywords: words('important inherit initial unset none auto') },
  scss: { blockComment: ['/*', '*/'], lineComments: ['//'], quotes: `'"`, units: true, numbers: true, keywords: words('important inherit initial unset none auto') },
  html: { blockComment: ['<!--', '-->'], lineComments: [], quotes: `'"`, tags: true, keywords: words('') },
  python: {
    lineComments: ['#'],
    quotes: `'"`,
    numbers: true,
    keywords: words(`
      and as assert async await break class continue def del elif else except False finally for from global if import in
      is lambda None nonlocal not or pass raise return self True try while with yield match case`),
  },
  go: {
    ...C_LIKE,
    quotes: `"'\``,
    keywords: words(`
      break case chan const continue default defer else fallthrough false for func go goto if import interface iota map nil
      package range return select struct switch true type var string int int64 int32 uint byte rune bool error float64 any`),
  },
  rust: {
    ...C_LIKE,
    quotes: '"',
    charLiterals: true,
    keywords: words(`
      as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub
      ref return self Self static struct super trait true type unsafe use where while Some None Ok Err Option Result String
      Vec i32 i64 u8 u32 u64 usize isize f32 f64 bool str char`),
  },
  shell: {
    lineComments: ['#'],
    hashAtWordStart: true,
    quotes: `'"`,
    numbers: true,
    keywords: words(`
      if then else elif fi for while until do done case esac in function return export local readonly set unset shift exit
      source alias echo cd`),
  },
};

// The language a file is coloured as, by its name (core/blocks/code/code.ts); null leaves it plain.
export function languageOf(path: string): Language | null {
  return coloursOf(languageByPath(path));
}

// The colours for a language, if it has any.
export function coloursOf(language: CodeLanguage | undefined): Language | null {
  return (language?.colour && LANGUAGES[language.colour]) || null;
}

const NUMBER = /0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?/y;
const CSS_NUMBER = /#[\da-fA-F]{3,8}\b|\d*\.?\d+(?:%|[a-zA-Z]+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const AT_RULE = /@[\w-]+/y;
const TAG = /<\/?[A-Za-z][\w:-]*/y;
const CHAR = /'(?:\\.|[^\\'])'/y;

function stickyMatch(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

// Whether a word may start at `at`: not in the middle of one.
const wordStart = (text: string, at: number) => at === 0 || !/[\w$]/.test(text[at - 1]);

// One line's tokens. `state` carries a block comment left open into the next line.
export function highlightLine(text: string, lang: Language | null, state: { inComment: boolean } = { inComment: false }): Token[] {
  if (!lang) return [{ text }];
  const tokens: Token[] = [];
  let plain = '';
  const push = (value: string, kind: TokenKind) => {
    if (plain) tokens.push({ text: plain });
    plain = '';
    if (value) tokens.push({ text: value, kind });
  };
  let i = 0;
  const closeComment = (from: number) => {
    const [, end] = lang.blockComment!;
    const close = text.indexOf(end, from);
    state.inComment = close === -1;
    const stop = close === -1 ? text.length : close + end.length;
    push(text.slice(i, stop), 'com');
    i = stop;
  };
  if (state.inComment && lang.blockComment) closeComment(0);
  else if (lang.blockComment?.[0] === '/*' && /^\s*\*(\s|\/|$)/.test(text)) {
    // A doc comment's middle line, read without its start.
    push(text, 'com');
    return tokens;
  }

  while (i < text.length) {
    const ch = text[i];
    if (lang.blockComment && text.startsWith(lang.blockComment[0], i)) {
      closeComment(i + lang.blockComment[0].length);
      continue;
    }
    if (lang.lineComments.some((start) => text.startsWith(start, i)) && (!lang.hashAtWordStart || i === 0 || /\s/.test(text[i - 1]))) {
      push(text.slice(i), 'com');
      i = text.length;
      break;
    }
    if (lang.charLiterals && ch === "'") {
      const char = stickyMatch(CHAR, text, i);
      if (char) {
        push(char, 'str');
        i += char.length;
      } else {
        plain += ch; // a lifetime
        i++;
      }
      continue;
    }
    if (lang.quotes.includes(ch)) {
      let end = i + 1;
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
      end = Math.min(end + 1, text.length);
      push(text.slice(i, end), 'str');
      i = end;
      continue;
    }
    if (lang.tags && ch === '<') {
      const tag = stickyMatch(TAG, text, i);
      if (tag) {
        const name = tag.replace(/^<\/?/, '');
        plain += tag.slice(0, tag.length - name.length);
        push(name, 'kw');
        i += tag.length;
        continue;
      }
    }
    if (lang.units && (ch === '@' || ch === '#' || /[\d.]/.test(ch)) && wordStart(text, i)) {
      const found = ch === '@' ? stickyMatch(AT_RULE, text, i) : stickyMatch(CSS_NUMBER, text, i);
      if (found) {
        push(found, ch === '@' ? 'kw' : 'num');
        i += found.length;
        continue;
      }
    }
    if (lang.numbers && !lang.units && /\d/.test(ch) && wordStart(text, i)) {
      const number = stickyMatch(NUMBER, text, i)!;
      push(number, 'num');
      i += number.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch) && wordStart(text, i)) {
      const word = stickyMatch(WORD, text, i)!;
      if (lang.keywords.has(word)) push(word, 'kw');
      else plain += word;
      i += word.length;
      continue;
    }
    plain += ch;
    i++;
  }
  if (plain) tokens.push({ text: plain });
  return tokens;
}
