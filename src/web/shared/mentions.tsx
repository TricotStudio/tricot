import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type UIEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentRules } from '../../core/agentRules';
import { tagText } from '../../core/agentTags';
import type { AgentBrowserHalf } from '../../core/agents/agent';
import { agentKindOf } from '../../core/agents/registry';
import { samePerson } from '../../core/format';
import { agentStateWords, asksYou, boardAgents, boardPeople, findMentions, MENTION_TYPING, nameFits, rehypeMentions, SKILL_TYPING, withMention, withSkill } from '../../core/mentions';
import { TASK_STATUS_WORDS } from '../../core/pins';
import { pickableCards, pickCards, readCardQuery, type PickableCard } from '../../core/refPicker';
import { refLabel } from '../../core/refs';
import { readSkillRequest, rehypeSkill, type AgentSkills, type SkillList } from '../../core/skills';
import type { Options } from 'react-markdown';
import type { Comment, TaskStatus } from '../../core/types';
import { api, type AgentPresence, type LiveBoard } from './api';
import { ActorBadge, Icon, Md } from './components';
import { cellChoices, cellLabel, cellListName, cellsOf, cellWords, stepCell, takesTag, writtenTag, type CellChoice, type TagCell } from './mentionTags';
import { useRefs } from './refs';
import './mentions.css';
import './skills.css';

// Who can be @-mentioned or handed a task on the board on screen: its agents
// (connected now, or seen in its activity), each with what it's doing, and
// its people. Pickers and the @ autocomplete read it.

export interface RosterAgent {
  name: string;
  state: string; // "listening", "working on T57", "not checking", "not connected"
  present: boolean;
}

interface Roster {
  boardId: string;
  me: string;
  agents: RosterAgent[];
  people: string[]; // others than me
}

const RosterContext = createContext<Roster>({ boardId: '', me: '', agents: [], people: [] });

export function useRoster(): Roster {
  return useContext(RosterContext);
}

const STATE_ORDER: Record<AgentPresence['state'], number> = { listening: 0, working: 1, away: 2 };

export function RosterProvider({ board, me, children }: { board: LiveBoard; me: string; children: ReactNode }) {
  const value = useMemo((): Roster => {
    const presence = board.presence ?? [];
    const agents = boardAgents(board, presence.map((a) => a.name)).map((name): RosterAgent & { rank: number } => {
      const here = presence.find((a) => samePerson(a.name, name));
      return { name, state: agentStateWords(board, name, here), present: Boolean(here), rank: here ? STATE_ORDER[here.state] : 3 };
    });
    agents.sort((a, b) => a.rank - b.rank);
    const people = boardPeople(board).filter((p) => !samePerson(p, me));
    return { boardId: board.id, me, agents: agents.map(({ rank: _rank, ...agent }) => agent), people };
  }, [board, me]);
  return <RosterContext.Provider value={value}>{children}</RosterContext.Provider>;
}

// ---- comments that mention someone ---------------------------------------------

// A comment's text, its mentions drawn as chips (an agent's with the tag
// written on it, "@Claude:opus:high"), and the skill it asks an agent to run.
export function CommentText({ comment }: { comment: Pick<Comment, 'body' | 'mentions' | 'skill'> }) {
  const { people, me } = useRoster();
  const names = comment.mentions ?? [];
  const agents = names.filter((name) => !samePerson(name, me) && !people.some((p) => samePerson(p, name)));
  const plugins: NonNullable<Options['rehypePlugins']> = [];
  if (names.length) plugins.push([rehypeMentions, { names, agents }]);
  if (comment.skill) plugins.push([rehypeSkill, { name: comment.skill.name }]);
  return <Md rehypePlugins={plugins.length ? plugins : undefined}>{comment.body}</Md>;
}

// "via /review": a reply an agent made running a skill a person asked it to.
export function ViaSkill({ via }: { via?: string }) {
  return via ? (
    <span className="tag tag-via" title={`Made by running /${via}, as a person asked`}>
      via /{via}
    </span>
  ) : null;
}

// "asks you": a comment by someone else that mentions the viewer, until the
// viewer comments after it in the same thread or answers it with a 👍 or 👎.
export function AsksYou({ comment, thread }: { comment: Comment; thread: Comment[] }) {
  const { me } = useRoster();
  return asksYou(comment, thread, me) ? <span className="tag tag-asked">asks you</span> : null;
}

// ---- typing @ ---------------------------------------------------------------------

interface Option {
  kind: 'agent' | 'person';
  name: string;
  state?: string;
  agent?: AgentBrowserHalf; // which agent it is, when Tricot knows: what its row offers for one message
}

type Field = HTMLTextAreaElement | HTMLInputElement;

// Where the caret would be at `position` in a field, on screen: a hidden copy
// of the field's text, styled like it, measured up to there.
const COPIED = [
  'box-sizing', 'width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'tab-size',
];

function caretAt(field: Field, position: number): { left: number; top: number; height: number } {
  const style = getComputedStyle(field);
  const copy = document.createElement('div');
  for (const property of COPIED) copy.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(copy.style, {
    position: 'fixed',
    visibility: 'hidden',
    top: '0',
    left: '0',
    whiteSpace: field instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre',
    overflowWrap: 'break-word',
  });
  copy.textContent = field.value.slice(0, position);
  const mark = document.createElement('span');
  mark.textContent = '@';
  copy.append(mark);
  document.body.append(copy);
  const box = field.getBoundingClientRect();
  const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const point = { left: box.left + mark.offsetLeft - field.scrollLeft, top: box.top + mark.offsetTop - field.scrollTop, height };
  copy.remove();
  return point;
}

const MENU_WIDTH = 280;
// With agents listed: room for the model and thinking on each one's row.
const AGENTS_MENU_WIDTH = 380;
const TAG_FOOT_HEIGHT = 36; // its foot, one line (tagFoot)
const SKILL_MENU_WIDTH = 400;
const SKILL_MENU_HEIGHT = 320;

// One skill in the "/" list, under the agent that has it.
interface SkillOption {
  kind: 'skill';
  agent: string;
  name: string;
  description: string;
  present: boolean; // the agent is listening or working: it runs at once
  tricot: boolean; // a Tricot skill, which works with every agent (or the one it is for)
  call: string; // what is typed to call it: its name, or tricot:name when the agent has its own of that name
}

// One card in the "#" list, which picking writes as T6 or #6.
interface CardOption {
  kind: 'card';
  card: PickableCard;
}

const CARD_MENU_WIDTH = 380;
const CARD_MENU_HEIGHT = 320; // about eight rows, then it scrolls

type Choice = Option | SkillOption | CardOption;
type Typing = { trigger: '@' | '/' | '#'; at: number; query: string };

// The model and thinking set for one message on an agent's row (`row`, by its
// name), and where the person is in them: the cell the arrows are in, if any,
// and whether its list is open (the mouse's way in). Only one row has them.
interface RowTag {
  row?: string;
  cell: TagCell | null;
  open?: boolean;
  model?: string;
  effort?: string;
}

// The tag as it stands for `name`'s row: its own, or a fresh one.
const onRow = (tag: RowTag, name: string): RowTag => (tag.row === name ? tag : { row: name, cell: null });

// What an agent in the "/" list is doing, or what happens when it isn't here.
function skillAgentNote(agent: AgentSkills): string {
  return agent.present ? agent.state : `runs next time ${agent.name} connects`;
}

// A card's status, as its chip's title and the board say it.
const cardStatus = (card: PickableCard) => (card.kind === 'task' ? TASK_STATUS_WORDS[card.status as TaskStatus] : card.status);
// Its status marker, drawn by the ref-* classes as on #12 and T5 chips.
const cardMarker = (card: PickableCard) => (card.kind === 'task' ? `ref-task-${card.status}` : `ref-${card.status}`);

function useMentionMenu(value: string, onValue: (value: string) => void, skills: boolean) {
  const roster = useRoster();
  const refs = useRefs(); // the board's cards, for "#"; none off a board
  const field = useRef<Field | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [agents, setAgents] = useState<AgentSkills[]>([]);
  const [rules, setRules] = useState<AgentRules>({});
  const [tag, setTag] = useState<RowTag>({ cell: null });
  const [active, setActive] = useState(0);
  const dismissed = useRef<number | null>(null); // the @ or / Escape closed the menu on
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  // What's typed after an @, a # (on a board) or, where skills are offered, a /
  // just before the caret, if anything.
  const onBoard = Boolean(refs);
  const read = useCallback(() => {
    const el = field.current;
    if (!el || el.selectionStart !== el.selectionEnd || document.activeElement !== el) return setTyping(null);
    const caret = el.selectionStart ?? 0;
    const before = el.value.slice(0, caret);
    const mention = before.match(MENTION_TYPING);
    const hash = !mention && onBoard ? readCardQuery(before) : null;
    const slash = !mention && !hash && skills ? before.match(SKILL_TYPING) : null;
    const found: Typing | null = mention
      ? { trigger: '@', at: caret - mention[1].length - 1, query: mention[1] }
      : hash
        ? { trigger: '#', ...hash }
        : slash
          ? { trigger: '/', at: caret - slash[1].length - 1, query: slash[1] }
          : null;
    if (!found || found.at === dismissed.current) return setTyping(null);
    dismissed.current = null;
    setTyping((current) => (current?.trigger === found.trigger && current.at === found.at && current.query === found.query ? current : found));
  }, [skills, onBoard]);

  // Each time a "/" or an "@" starts: who has which skills, who is here, and
  // which agent each is, as it is now; for an "@", each agent's rule too,
  // which its row shows faintly.
  const slashing = typing?.trigger === '/';
  const mentioning = typing?.trigger === '@';
  useEffect(() => {
    if (!slashing && !mentioning) return;
    let live = true;
    api.agents(roster.boardId || undefined).then(
      (list) => live && setAgents(list),
      () => {},
    );
    if (mentioning) {
      api.agentRules().then(
        (read) => live && setRules(read.rules),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [slashing, mentioning, roster.boardId]);

  const cards = useMemo(() => (refs ? pickableCards(refs.tasks.values(), refs.decisions.values()) : []), [refs]);
  const hashing = typing?.trigger === '#';

  const options = useMemo((): Choice[] => {
    if (!typing) return [];
    if (typing.trigger === '#') return pickCards(cards, typing.query).map((card): CardOption => ({ kind: 'card', card }));
    const query = typing.query.toLowerCase();
    if (typing.trigger === '/') {
      const starts = (name: string) => name.toLowerCase().startsWith(query);
      return agents.flatMap((agent) =>
        agent.skills
          .filter((skill) => (skill.call ?? skill.name).toLowerCase().includes(query))
          .sort((a, b) => Number(starts(b.call ?? b.name)) - Number(starts(a.call ?? a.name)))
          .map((skill): SkillOption => ({
            kind: 'skill',
            agent: agent.name,
            name: skill.name,
            description: skill.description,
            present: agent.present,
            tricot: Boolean(skill.tricot),
            call: skill.call ?? skill.name,
          })),
      );
    }
    const kindOf = (name: string) => agentKindOf({ name, tool: agents.find((a) => samePerson(a.name, name))?.tool });
    return [
      ...roster.agents.filter((a) => nameFits(a.name, query)).map((a): Option => ({ kind: 'agent', name: a.name, state: a.state, agent: kindOf(a.name) })),
      ...roster.people.filter((name) => nameFits(name, query)).map((name): Option => ({ kind: 'person', name })),
    ].slice(0, 8);
  }, [typing, roster, agents, cards]);
  const open = Boolean(typing) && options.length > 0;
  const current = Math.min(active, Math.max(options.length - 1, 0));
  // Each letter typed starts the list over at its best fit (T6 before T60),
  // and a row's model and thinking over.
  useEffect(() => {
    setActive(0);
    setTag({ cell: null });
  }, [typing?.trigger, typing?.at, typing?.query]);
  const activeOption = open ? options[current] : undefined;
  const tagging = activeOption?.kind === 'agent' && takesTag(activeOption.agent) ? activeOption : undefined;
  const ruleOf = (agent: AgentBrowserHalf) => rules[agent.id] ?? {};
  // What is set on an agent's row: its model and thinking, if it is the row that has them.
  const valuesOn = (name: string) => (tag.row === name ? { model: tag.model, effort: tag.effort } : {});
  // The cell the person is in on the active row, and the one whose list is open.
  const inCell = tagging && tag.row === tagging.name ? tag.cell : null;
  const listed = inCell && tag.open ? inCell : null;

  // Another row active, out of the cells and their lists. The arrows let go
  // of the tag as they move, as they always have; the mouse passing over
  // another row leaves it on its own, so a pick isn't lost on the way to a
  // click, and an open list holds the row until it closes.
  const activate = (index: number, letGo: boolean) => {
    if (index === current) return;
    setActive(index);
    setTag((now) => (letGo ? { cell: null } : { ...now, cell: null, open: false }));
  };
  const hover = (index: number) => () => {
    if (!tag.open) activate(index, false);
  };
  const listsAgents = !slashing && !hashing && options.some((o) => o.kind === 'agent');
  const listsTaggable = listsAgents && options.some((o) => o.kind === 'agent' && takesTag(o.agent));
  const menuWidth = slashing ? SKILL_MENU_WIDTH : hashing ? CARD_MENU_WIDTH : listsAgents ? AGENTS_MENU_WIDTH : MENU_WIDTH;

  useLayoutEffect(() => {
    if (!open || !typing || !field.current) return setPlace(null);
    // Under the field, starting at the @ as far as the field leaves room, so
    // it keeps clear of what's beside the field (a Comment button).
    const box = field.current.getBoundingClientRect();
    const caret = caretAt(field.current, typing.at);
    const within = Math.max(box.left, Math.min(caret.left - 6, box.right - menuWidth));
    const left = Math.max(8, Math.min(within, window.innerWidth - menuWidth - 8));
    const below = box.bottom + 4;
    const height = slashing ? SKILL_MENU_HEIGHT : hashing ? Math.min(CARD_MENU_HEIGHT, 64 + options.length * 32) : 40 + options.length * 34 + (listsTaggable ? TAG_FOOT_HEIGHT : 0);
    // Above the field when there's no room under it, as on the chat bar.
    setPlace(below + height < window.innerHeight ? { left, top: below } : { left, bottom: window.innerHeight - box.top + 4 });
  }, [open, typing, options.length, slashing, hashing, listsTaggable, menuWidth]);

  // The arrows move through a long list: keep the row they stop on in view.
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [open, current, place]);

  // Everyone a mention can name here, for the leading ones a skill replaces;
  // and the agents among them, whose mentions take a tag (core/agentTags.ts).
  const agentNames = useMemo(() => [...roster.agents.map((a) => a.name), ...agents.map((a) => a.name)], [roster, agents]);
  const names = useMemo(() => [...agentNames, ...roster.people, ...(roster.me ? [roster.me] : [])], [agentNames, roster]);

  const choose = (option: Choice) => {
    const el = field.current;
    if (!el || !typing) return;
    let next: string;
    let caret: number;
    if (option.kind === 'skill') {
      ({ text: next, caret } = withSkill(value, typing, option.agent, option.call, names));
    } else if (option.kind === 'card') {
      // A card is written as the board names it (T6, #6).
      const after = value.slice(typing.at + 1 + typing.query.length);
      const inserted = `${refLabel(option.card)}${after.startsWith(' ') ? '' : ' '}`;
      next = value.slice(0, typing.at) + inserted + after;
      caret = typing.at + inserted.length + (after.startsWith(' ') ? 1 : 0);
    } else {
      // An agent's row writes its tag, when its model or thinking is set: "@Claude:opus:high".
      const tagged = option.kind === 'agent' && takesTag(option.agent) ? tagText(valuesOn(option.name)) : '';
      ({ text: next, caret } = withMention(value, typing, option.name, tagged));
    }
    onValue(next);
    setTyping(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const keyOf = (cell: TagCell) => (cell === 'model' ? 'model' : 'effort');

  // A step in a cell of the active agent's row: up (-1) or down (1).
  const step = (cell: TagCell, by: 1 | -1) => {
    if (!tagging?.agent) return;
    const { name, agent } = tagging;
    setTag((now) => {
      const mine = onRow(now, name);
      return { ...mine, cell, [keyOf(cell)]: stepCell(agent, cell, ruleOf(agent), mine[keyOf(cell)], by) };
    });
  };

  // A click on a cell opens its list, or closes it when it is open; a click
  // on a line of the list sets that value on the row and closes it. Neither
  // closes the @ list or takes the caret from the field.
  const toggleList = (option: Option, index: number, cell: TagCell) => {
    if (index !== current) setActive(index);
    setTag((now) => (now.open && now.cell === cell && now.row === option.name ? { ...now, cell: null, open: false } : { ...onRow(now, option.name), cell, open: true }));
  };
  const pick = (name: string, cell: TagCell, chosen: string | undefined) => setTag((now) => ({ ...onRow(now, name), cell: null, open: false, [keyOf(cell)]: chosen }));
  const closeList = () => setTag((now) => ({ ...now, cell: null, open: false }));

  // Arrows pick, Enter or Tab takes, Escape closes the menu (not what it's in).
  // On an agent that can do one message on another model, → goes into its
  // model and thinking, where ↑ and ↓ change them and ← comes back out; with
  // a cell's list open, they do the same, and Escape closes the list first.
  const onKey = (e: KeyboardEvent<Field>): boolean => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return false;
    const cells = tagging?.agent ? cellsOf(tagging.agent) : [];
    const at = inCell ? cells.indexOf(inCell) : -1;
    if (e.key === 'ArrowRight' && tagging && cells.length) {
      setTag((now) => ({ ...onRow(now, tagging.name), cell: cells[Math.min(at + 1, cells.length - 1)], open: false }));
    } else if (e.key === 'ArrowLeft' && inCell) {
      setTag((now) => ({ ...now, cell: at > 0 ? cells[at - 1] : null, open: false }));
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && inCell) {
      step(inCell, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      activate((current + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length, true);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      choose(options[current]);
    } else if (e.key === 'Escape' && listed) {
      closeList(); // the list, its pick kept
    } else if (e.key === 'Escape' && inCell) {
      setTag({ cell: null }); // out of the cells, the tag let go
    } else if (e.key === 'Escape') {
      dismissed.current = typing!.at;
      setTyping(null);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  // An agent's model and thinking for one message: chips, in ink once set on
  // its row, else at its rule, faint. A click opens the cell's list.
  const tagCells = (option: Option, index: number) => {
    const agent = option.agent!;
    const rule = ruleOf(agent);
    const values = valuesOn(option.name);
    const here = index === current;
    return (
      <span className="mention-tag-cells">
        {cellsOf(agent).map((cell) => {
          const value = values[keyOf(cell)];
          const { words, set } = cellWords(agent, cell, rule, value);
          const expanded = here && listed === cell;
          return (
            <button
              key={cell}
              type="button"
              tabIndex={-1} // the caret stays in the field: the keys reach the cells from there
              id={`mention-${index}-${cell}`}
              className={`mention-tag-cell${set ? ' is-set' : ''}${here && inCell === cell && !expanded ? ' is-focus' : ''}`}
              aria-label={cellLabel(agent, cell, rule, value)}
              aria-haspopup="listbox"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation(); // its list, not a pick of the row
                toggleList(option, index, cell);
              }}
            >
              <span className="mention-tag-words">{words}</span>
              <svg className="assignee-caret" viewBox="0 0 16 16" aria-hidden>
                <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
          );
        })}
      </span>
    );
  };

  // The open cell's list, beside the @ list (TagList).
  const tagList = () => {
    if (!listed || !tagging?.agent) return null;
    const { name, agent } = tagging;
    return (
      <TagList
        anchor={`mention-${current}-${listed}`}
        name={cellListName(listed)}
        choices={cellChoices(agent, listed, ruleOf(agent))}
        value={valuesOn(name)[keyOf(listed)]}
        onPick={(chosen) => pick(name, listed, chosen)}
      />
    );
  };

  const row = (option: Option, index: number) => (
    <div
      key={`${option.kind}:${option.name}`}
      id={`mention-${index}`}
      role="option"
      aria-selected={index === current}
      className={`mention-option${index === current ? ' is-active' : ''}${option.kind === 'agent' && listsAgents ? ' has-tag' : ''}`}
      onMouseEnter={hover(index)}
      onClick={() => choose(option)}
    >
      <ActorBadge actor={{ kind: option.kind === 'agent' ? 'agent' : 'human', name: option.name }} title={option.name} />
      {option.state && <span className="mention-state">{option.state}</span>}
      {option.kind === 'agent' && (takesTag(option.agent) ? tagCells(option, index) : <span className="mention-tag-note">its own model</span>)}
    </div>
  );

  // Under the list, while it has an agent that takes a tag: what Enter does
  // on the active row (once its model or thinking is set, the tag it writes)
  // and what the keys do. One line whatever it says, so the rows don't move
  // under the mouse when it changes. Read out as it changes.
  const tagFoot = () => {
    if (!listsTaggable) return null;
    if (!tagging?.agent) {
      return (
        <div className="mention-tag-foot" aria-live="polite">
          <span>
            <kbd>↵</kbd>mention
          </span>
        </div>
      );
    }
    const ruled = Boolean(ruleOf(tagging.agent).model || ruleOf(tagging.agent).effort);
    const values = valuesOn(tagging.name);
    const set = Boolean(values.model || values.effort);
    const keys = Boolean(inCell && !listed); // the arrows are in a cell
    return (
      <div className="mention-tag-foot" aria-live="polite">
        {keys && (
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>change
          </span>
        )}
        {keys || set ? (
          <span>
            <kbd>↵</kbd>writes <code>{writtenTag(tagging.name, values)}</code>
          </span>
        ) : (
          <>
            <span>
              <kbd>↵</kbd>mention{ruled ? ', on its rule' : ''}
            </span>
            <span>
              <kbd>→</kbd>model and thinking
            </span>
          </>
        )}
      </div>
    );
  };
  const skillRow = (option: SkillOption, index: number) => {
    const agent = agents.find((a) => a.name === option.agent)!;
    const first = index === 0 || (options[index - 1] as SkillOption).agent !== option.agent;
    return (
      <div key={`${option.agent}:${option.tricot ? 'tricot' : 'own'}:${option.name}`}>
        {first && (
          <div className={`mention-menu-head skill-head${agent.present ? '' : ' is-away'}`}>
            <span className="skill-agent">{option.agent}</span>
            <span className="skill-agent-note">{skillAgentNote(agent)}</span>
          </div>
        )}
        <div
          id={`mention-${index}`}
          role="option"
          aria-selected={index === current}
          className={`mention-option skill-option${index === current ? ' is-active' : ''}${option.present ? '' : ' is-away'}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(option)}
        >
          <span className="skill-name" title={option.call === option.name ? undefined : `Called as /${option.call}, as ${option.agent} has its own /${option.name}`}>
            /{option.name}
            {option.call !== option.name && ' (Tricot)'}
          </span>
          <span className="skill-desc">{option.description}</span>
          {option.tricot && <span className="skill-tricot">Tricot skill</span>}
        </div>
      </div>
    );
  };

  // A card in the "#" list: its number with its status marker, its title, its status.
  const cardRow = (option: CardOption, index: number) => {
    const { card } = option;
    const label = refLabel(card);
    return (
      <div
        key={label}
        id={`mention-${index}`}
        role="option"
        aria-selected={index === current}
        className={`mention-option hash-option${index === current ? ' is-active' : ''}`}
        onMouseEnter={() => setActive(index)}
        onClick={() => choose(option)}
        title={`${label} · ${card.title} · ${cardStatus(card)}`}
      >
        <span className={`hash-option-ref ${cardMarker(card)}`}>{label}</span>
        <span className="hash-option-title">{card.title}</span>
        <span className="mention-state">{cardStatus(card)}</span>
      </div>
    );
  };

  const mentionable = options.filter((o): o is Option => o.kind === 'agent' || o.kind === 'person');
  const cardOptions = options.filter((o): o is CardOption => o.kind === 'card');
  const taskOptions = cardOptions.filter((o) => o.card.kind === 'task');
  const decisionOptions = cardOptions.filter((o) => o.card.kind === 'decision');
  const agentOptions = mentionable.filter((o) => o.kind === 'agent');
  const personOptions = mentionable.filter((o) => o.kind === 'person');
  const list =
    open && place ? (
      <div
        ref={menu}
        className={`mention-menu${slashing ? ' skill-menu' : hashing ? ' hash-menu' : ''}`}
        role="listbox"
        aria-label={slashing ? 'Call a skill' : hashing ? 'Link a task or decision' : 'Mention someone'}
        style={{
          left: place.left,
          top: place.top,
          bottom: place.bottom,
          width: menuWidth,
        }}
        onMouseDown={(e) => {
          e.preventDefault(); // keeps the caret in the field
          e.stopPropagation();
        }}
        onClickCapture={(e) => {
          // With a cell's list open, a click elsewhere in the @ list only
          // closes it; one on a cell of its row opens that cell's instead.
          if (!tag.open) return;
          const cell = (e.target as Element).closest('.mention-tag-cell');
          if (cell && cell.id.startsWith(`mention-${current}-`)) return;
          e.stopPropagation();
          closeList();
        }}
      >
        {slashing ? (
          <>
            {options.map((o, i) => skillRow(o as SkillOption, i))}
            <div className="skill-foot">A message that starts with a skill asks that agent to run it.</div>
          </>
        ) : hashing ? (
          <>
            {taskOptions.length > 0 && <div className="mention-menu-head">Tasks</div>}
            {taskOptions.map((o, i) => cardRow(o, i))}
            {decisionOptions.length > 0 && <div className="mention-menu-head">Decisions</div>}
            {decisionOptions.map((o, i) => cardRow(o, taskOptions.length + i))}
          </>
        ) : (
          <>
            {agentOptions.length > 0 && <div className="mention-menu-head">Agents on this board</div>}
            {agentOptions.map((o, i) => row(o, i))}
            {personOptions.length > 0 && <div className="mention-menu-head">People</div>}
            {personOptions.map((o, i) => row(o, agentOptions.length + i))}
            {tagFoot()}
          </>
        )}
      </div>
    ) : null;
  // The @ list, and beside it the open cell's list.
  const popup = list
    ? createPortal(
        <>
          {list}
          {tagList()}
        </>,
        document.body,
      )
    : null;

  // What to mark in the field: the names it mentions, the skill it starts
  // with, and the @word or #word being typed.
  const marks = useMemo(() => {
    const found: [number, number][] = findMentions(value, names, agentNames).map((m) => [m.start, m.end]);
    if (skills && agents.length) {
      const lists = agents.map((a): SkillList => ({ agent: a.name, skills: a.skills, reportedAt: a.reportedAt ?? '' }));
      const request = readSkillRequest(value, lists, names);
      if (request) found.push([request.start, request.end]);
    }
    if (open && typing && typing.trigger !== '/' && !found.some(([start]) => start === typing.at)) found.push([typing.at, typing.at + 1 + typing.query.length]);
    return found.sort((a, b) => a[0] - b[0]);
  }, [value, names, agentNames, agents, skills, open, typing]);

  // The row the keys are on, or with a cell's list open, its line that is set.
  const chosenLine = listed && tagging?.agent ? cellChoices(tagging.agent, listed, ruleOf(tagging.agent)).findIndex((c) => c.value === valuesOn(tagging.name)[keyOf(listed)]) : -1;
  const activeId = chosenLine >= 0 ? `mention-${current}-${listed}-${chosenLine}` : `mention-${current}`;
  const aria = { 'aria-autocomplete': 'list' as const, 'aria-expanded': open, 'aria-activedescendant': open ? activeId : undefined };
  return { field, read, onKey, menu: popup, marks, close: () => setTyping(null), aria };
}

// A cell's list (T29): a small menu in the assignee menu's look, under the
// cell (over it when there's no room), its right edge at the cell's. Each
// line is a value, the one set ticked, the rule's marked default. It is
// drawn beside the @ list rather than in it, and is part of it all the
// same: a press on it keeps the caret in the field, and a panel that closes
// on a click outside it leaves the .mention-menu be (useDismiss).
function TagList({ anchor, name, choices, value, onPick }: { anchor: string; name: string; choices: CellChoice[]; value: string | undefined; onPick: (value: string | undefined) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useLayoutEffect(() => {
    const cell = document.getElementById(anchor)?.getBoundingClientRect();
    const list = root.current;
    if (!cell || !list) return;
    const left = Math.max(8, Math.min(cell.right - list.offsetWidth, window.innerWidth - list.offsetWidth - 8));
    const below = cell.bottom + 4;
    setPlace(below + list.offsetHeight < window.innerHeight - 8 ? { left, top: below } : { left, bottom: window.innerHeight - cell.top + 4 });
  }, [anchor]);
  return (
    <div
      ref={root}
      className="mention-menu mention-tag-list"
      role="listbox"
      aria-label={name}
      style={{ left: place?.left ?? -9999, top: place?.top, bottom: place?.bottom, visibility: place ? undefined : 'hidden' }}
      onMouseDown={(e) => {
        e.preventDefault(); // keeps the caret in the field
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mention-menu-head" aria-hidden>
        {name}
      </div>
      {choices.map((choice, i) => {
        const chosen = choice.value === value;
        return (
          <div
            key={choice.value ?? ''}
            id={`${anchor}-${i}`}
            role="option"
            aria-selected={chosen}
            className={`mention-tag-choice${chosen ? ' is-chosen' : ''}`}
            onClick={() => onPick(choice.value)}
          >
            <span className="mention-tag-choice-words">{choice.words}</span>
            {choice.note && <span className="mention-tag-choice-note">{choice.note}</span>}
            <span className="mention-tag-check">{chosen && <Icon name="check" />}</span>
          </div>
        );
      })}
    </div>
  );
}

// Behind a field, the same text, invisible but for its mentions, which show
// as chips through it. It mirrors the field's box and scroll.
const MIRRORED = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'border-radius', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'tab-size',
];

function Backdrop({ value, marks, field }: { value: string; marks: [number, number][]; field: { current: Field | null } }) {
  const root = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    const backdrop = root.current;
    if (!el || !backdrop) return;
    const style = getComputedStyle(el);
    for (const property of MIRRORED) backdrop.style.setProperty(property, style.getPropertyValue(property));
    backdrop.scrollTop = el.scrollTop;
    backdrop.scrollLeft = el.scrollLeft;
  });
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start < at) continue;
    pieces.push(value.slice(at, start), <mark key={start}>{value.slice(start, end)}</mark>);
    at = end;
  }
  pieces.push(value.slice(at), '​'); // a last empty line still takes room
  return (
    <span ref={root} className="mention-backdrop" aria-hidden>
      <span>{pieces}</span>
    </span>
  );
}

// The field's scroll, followed by the copy behind it.
const followScroll = (e: UIEvent<Field>) => {
  const behind = e.currentTarget.previousElementSibling;
  if (!behind) return;
  behind.scrollTop = e.currentTarget.scrollTop;
  behind.scrollLeft = e.currentTarget.scrollLeft;
};

interface FieldProps<E extends Field> {
  value: string;
  onValue: (value: string) => void;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onKeyDown?: (e: KeyboardEvent<E>) => void;
  ref?: Ref<E>;
}

function useFieldRef<E extends Field>(own: { current: Field | null }, ref: Ref<E> | undefined) {
  return useCallback(
    (el: E | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as { current: E | null }).current = el;
    },
    [own, ref],
  );
}

// A textarea where typing @ offers the board's agents, then its people, and
// inserts @Name. The server resolves the mentions from the text. With
// `skills`, typing / at the start of a word offers the agents' skills.
export function MentionTextarea({ value, onValue, onKeyDown, ref, rows, skills = false, ...rest }: FieldProps<HTMLTextAreaElement> & { rows?: number; skills?: boolean }) {
  const mentions = useMentionMenu(value, onValue, skills);
  const setRef = useFieldRef(mentions.field, ref);
  const backdrop = mentions.marks.length > 0;
  return (
    <span className={`mention-field${backdrop ? ' has-marks' : ''}`}>
      {backdrop && <Backdrop value={value} marks={mentions.marks} field={mentions.field} />}
      <textarea
        {...rest}
        {...mentions.aria}
        ref={setRef}
        rows={rows}
        value={value}
        onChange={(e) => {
          onValue(e.target.value);
          mentions.read();
        }}
        onSelect={mentions.read}
        onBlur={mentions.close}
        onScroll={followScroll}
        onKeyDown={(e) => mentions.onKey(e) || onKeyDown?.(e)}
      />
      {mentions.menu}
    </span>
  );
}

// The same for a one-line input, e.g. the chat bar (chatBar.tsx), which
// takes the room its row leaves it; with `skills`, / offers them too.
export function MentionInput({ value, onValue, onKeyDown, ref, skills = false, ...rest }: FieldProps<HTMLInputElement> & { skills?: boolean }) {
  const mentions = useMentionMenu(value, onValue, skills);
  const setRef = useFieldRef(mentions.field, ref);
  const backdrop = mentions.marks.length > 0;
  return (
    <span className={`mention-field mention-line${backdrop ? ' has-marks' : ''}`}>
      {backdrop && <Backdrop value={value} marks={mentions.marks} field={mentions.field} />}
      <input
        {...rest}
        {...mentions.aria}
        ref={setRef}
        value={value}
        onChange={(e) => {
          onValue(e.target.value);
          mentions.read();
        }}
        onSelect={mentions.read}
        onBlur={mentions.close}
        onScroll={followScroll}
        onKeyDown={(e) => mentions.onKey(e) || onKeyDown?.(e)}
      />
      {mentions.menu}
    </span>
  );
}
