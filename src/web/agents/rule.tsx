import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_AT_ONCE, MAX_AT_ONCE, modelProblem, roleRuleKey, RULE_ROLE_WORDS, RULE_ROLES, ruleWords, type AgentRule, type AgentRules, type RuleRole } from '../../core/agentRules';
import type { AgentKind } from '../../core/agents/agent';
import { agentKindOf } from '../../core/agents/registry';
import { samePerson } from '../../core/format';
import { Icon } from '../shared/components';
import { menuStep, useDismiss } from '../shared/hooks';

// An agent's rule in its panel's head (T22, core/agentRules.ts): the chip
// beside its name says what it starts on, in the assignee chip's shape
// (dashed for its own settings, as "Any agent" is), and opens a small
// popover, the assignee menu's look, to change it: the model and the
// thinking level side by side, Default first, the chosen one ticked, and a
// model of one's own to type. The line under the name, what it runs on now,
// is the panel's (agents.tsx, runningWords). Drawn by agents.css; nothing
// here imports a style, so tests can draw it.
//
// Given every rule (`roles`), a row over the columns picks whose model it
// sets: the agent's own, or one of its roles' (core/roles.ts, core/agentRules.ts
// RULE_ROLES). A coordinator or an orchestrator Tricot starts on it takes its
// role's rule over the agent's, so Default there is the agent's; the scouts
// and workers an orchestrator runs are told theirs, so Default there leaves
// it to the orchestrator.

// What a role of this agent's rule is set through: every rule, and setting one by its key.
export interface RoleRules {
  rules: AgentRules;
  set: (key: string, rule: AgentRule) => Promise<void>;
}

// Which agent this is: as its session said (its MCP client), else the one
// whose name on the board it has. None for a client Tricot doesn't know.
export const kindOf = agentKindOf;

// Whether its panel offers the rule: an agent Tricot starts, which takes a model.
export const offersRule = (kind: AgentKind | undefined): kind is AgentKind => Boolean(kind?.startsOn && !kind.cantStart);

// Who the popover says starts on it: the agent as the panel names it, or the
// tool when the panel is for one named otherwise ("Claude Code" for Reviewer),
// as the rule is the tool's on every board.
export const ruleOwner = (kind: AgentKind, name: string): string => (samePerson(kind.boardName, name) ? name : kind.name);

const POPOVER_WIDTH = { one: 264, two: 336 };

// `under`: what the popover drops below, when not the chip itself (the
// panel's head, so it leaves the line under the name in view).
export function RuleChip(props: { kind: AgentKind; name: string; rule: AgentRule; runsOn?: AgentRule; onSet: (rule: AgentRule) => Promise<void>; under?: RefObject<HTMLElement | null>; roles?: RoleRules }) {
  const { kind, name, rule, runsOn, onSet, under, roles } = props;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const words = ruleWords(kind, rule);
  const owner = ruleOwner(kind, name);
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) anchor.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`assignee-chip agent-rule-chip${words ? '' : ' is-any'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words ? `${owner} starts on ${words}. Change it.` : `${owner} starts on its own settings. Choose a model${kind.startsOn?.levels?.length ? ' and thinking level' : ''}.`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !open) return;
          e.preventDefault(); // the popover's, not the panel's
          e.stopPropagation();
          close();
        }}
      >
        <span className="agent-rule-chip-label">{words ?? 'Its own settings'}</span>
        <svg className="assignee-caret" viewBox="0 0 16 16" aria-hidden>
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
      {open && <RulePopover kind={kind} owner={owner} rule={rule} runsOn={runsOn} anchor={anchor} under={under} onSet={onSet} onClose={close} roles={roles} />}
    </>
  );
}

export function RulePopover(props: {
  kind: AgentKind;
  owner: string;
  rule: AgentRule;
  runsOn?: AgentRule;
  anchor: RefObject<HTMLElement | null>;
  under?: RefObject<HTMLElement | null>;
  onSet: (rule: AgentRule) => Promise<void>;
  onClose: (refocus?: boolean) => void;
  roles?: RoleRules;
}) {
  const { kind, owner, runsOn, anchor, under, onClose, roles } = props;
  // Whose rule the columns set: the agent's own (none), or one of its roles'.
  const [role, setRole] = useState<RuleRole | null>(null);
  const rule = role && roles ? (roles.rules[roleRuleKey(kind.id, role)] ?? {}) : props.rule;
  const onSet = (next: AgentRule) => (role && roles ? roles.set(roleRuleKey(kind.id, role), next) : props.onSet(next));
  const subagents = role === 'scout' || role === 'worker';
  const plain = role === null ? 'Default' : subagents ? 'Its choice' : `As ${owner}`;
  const models = kind.startsOn?.models ?? [];
  const levels = kind.startsOn?.levels ?? [];
  const width = levels.length ? POPOVER_WIDTH.two : POPOVER_WIDTH.one;
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A model of one's own, set already: listed with the suggestions, ticked.
  const own = rule.model && !models.some((model) => model.id === rule.model) ? rule.model : undefined;

  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    // Its right edge under the chip's, dropped below the chip, or below what `under` is.
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    const below = Math.max(box.bottom, under?.current?.getBoundingClientRect().bottom ?? 0) + 6;
    const height = root.current?.offsetHeight ?? 320;
    setPlace(below + height < window.innerHeight ? { left, top: below } : { left, bottom: window.innerHeight - box.top + 6 });
    (root.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? root.current)?.focus({ preventScroll: true });
  }, [anchor, under, width]);

  // Clicking away closes it, as the page moving under it does.
  const dismiss = useCallback(() => onClose(), [onClose]);
  useDismiss(true, dismiss, root, anchor);
  useEffect(() => {
    const moved = (e: Event) => !root.current?.contains(e.target as Node) && onClose();
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose, dismiss]);

  const set = async (next: AgentRule) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSet(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ownModel = (event: FormEvent) => {
    event.preventDefault();
    const model = typed.trim();
    if (!model) return;
    const problem = modelProblem(model);
    if (problem) return setError(problem);
    setTyped('');
    void set({ ...rule, model });
  };

  // Escape closes it, not the panel; the arrows move within a column, and
  // across to the other one.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return onClose(true);
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const column = target.closest('[role="group"]');
    const items = [...(column?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const columns = [...(root.current?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])];
      const other = columns[(columns.indexOf(column as HTMLElement) + (e.key === 'ArrowRight' ? 1 : columns.length - 1)) % columns.length];
      if (!other || other === column) return;
      e.preventDefault();
      (other.querySelector<HTMLElement>('[aria-checked="true"]') ?? other.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
      return;
    }
    const to = menuStep(e.key, items.indexOf(target), items.length);
    if (to === undefined) return;
    e.preventDefault();
    items[to].focus();
  };

  const option = (label: string, chosen: boolean, pick: () => void, key: string) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={chosen} className={`assignee-option agent-rule-option${chosen ? ' is-chosen' : ''}`} disabled={busy} onClick={pick}>
      <span className="agent-rule-option-label">{label}</span>
      {chosen && <Icon name="check" className="agent-rule-check" />}
    </button>
  );
  const now = role === null && runsOn && (ruleWords(kind, runsOn) ?? 'its own settings');
  const title = role === null ? `${owner} starts on` : subagents ? `${owner}'s ${RULE_ROLE_WORDS[role].toLowerCase()} run on` : role === 'coordinator' ? `${owner} as coordinator starts on` : `${owner}'s orchestrators start on`;
  const foot =
    role === null
      ? `A change takes effect the next time ${owner} starts; Default passes nothing.`
      : subagents
        ? `An orchestrator is told this as it starts, and runs its ${RULE_ROLE_WORDS[role].toLowerCase()} on it; its choice is the orchestrator's own.`
        : role === 'coordinator'
          ? `At once: how many agents each coordinator runs at work on threads at a time (${DEFAULT_AT_ONCE} unless set), from its next one. A change of model takes effect the next time Tricot starts one; As ${owner} is ${owner}'s own.`
          : `A change takes effect the next time Tricot starts one; As ${owner} is ${owner}'s own.`;

  return createPortal(
    <div
      ref={root}
      className="assignee-menu agent-rule-menu"
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={{ left: place?.left ?? -9999, top: place?.top, bottom: place?.bottom, width, visibility: place ? undefined : 'hidden' }}
      onKeyDown={keys}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {roles && (
        <div className="agent-rule-roles" role="radiogroup" aria-label="Whose model">
          {[null, ...RULE_ROLES].map((each) => (
            <button
              key={each ?? 'own'}
              type="button"
              role="radio"
              aria-checked={role === each}
              className={`agent-rule-role${role === each ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => {
                setRole(each);
                setError(null);
              }}
            >
              {each ? RULE_ROLE_WORDS[each] : owner}
            </button>
          ))}
        </div>
      )}
      <div className="agent-rule-title">{title}</div>
      <div className={`agent-rule-columns${levels.length ? ' is-two' : ''}`}>
        <div className="agent-rule-column" role="group" aria-label="Model">
          <div className="assignee-menu-head">Model</div>
          {option(plain, !rule.model, () => void set({ ...rule, model: undefined }), 'default')}
          {models.map((model) => option(model.label, rule.model === model.id, () => void set({ ...rule, model: model.id }), model.id))}
          {own && option(own, true, () => {}, `own:${own}`)}
          <form className="agent-rule-own" onSubmit={ownModel}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={models.length ? 'Another model…' : 'A model, as it names one…'}
              aria-label={`A model for ${owner}, by name`}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </form>
        </div>
        {levels.length > 0 && (
          <div className="agent-rule-column" role="group" aria-label="Thinking">
            <div className="assignee-menu-head">Thinking</div>
            {option(plain, !rule.effort, () => void set({ ...rule, effort: undefined }), 'default')}
            {levels.map((level) => option(level.label, rule.effort === level.id, () => void set({ ...rule, effort: level.id }), level.id))}
          </div>
        )}
      </div>
      {role === 'coordinator' && (
        <div className="agent-rule-at-once" role="radiogroup" aria-label="Agents it runs at once">
          <span className="agent-rule-at-once-name">At once</span>
          {Array.from({ length: MAX_AT_ONCE }, (_, at) => at + 1).map((count) => (
            <button
              key={count}
              type="button"
              role="radio"
              aria-checked={(rule.orchestrators ?? DEFAULT_AT_ONCE) === count}
              className={`agent-rule-count${(rule.orchestrators ?? DEFAULT_AT_ONCE) === count ? ' is-on' : ''}`}
              title={`${count} agent${count === 1 ? '' : 's'} at work at once${count === DEFAULT_AT_ONCE ? ' (the default)' : ''}`}
              disabled={busy}
              onClick={() => void set({ ...rule, orchestrators: count === DEFAULT_AT_ONCE ? undefined : count })}
            >
              {count}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="agent-rule-error" role="alert">
          {error}
        </p>
      )}
      <p className="agent-rule-foot">
        {now && (
          <>
            Running now on <strong>{now}</strong>.{' '}
          </>
        )}
        {foot}
      </p>
    </div>,
    document.body,
  );
}
