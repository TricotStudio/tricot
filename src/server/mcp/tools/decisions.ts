import { askAdvice, decisionAdvice, emptyCanvasAdvice, findingAdvice, withAdvice } from '../../../core/advice';
import { decisionDiscussion } from '../../../core/answering';
import { tools } from '../../../core/schemas';
import { peopleOn } from '../../../core/format';
import { decisionDetail } from '../../../core/digest';
import { BoardError, inBlock, inBlockAsync } from '../../../core/store';
import { inThread } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';
import { agentBoard } from '../backlog';

export function decisionTools({ store, getActor, session: { told }, blocks: { fill, readContent } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'get_decision',
      title: 'Get decision',
      description:
        "Read one decision in full: context, options, recommendation, resolution, findings and comments, and the other decisions it could affect, to weigh when you recommend. Re-read it, and its canvas (get_canvas with decision_id), before you act on the decision: people may have changed it.",
      schema: tools.get_decision,
      readOnly: true,
      handler: async ({ decision_id }) => {
        const { board, decision } = store.getDecision(decision_id);
        told.readAll(decisionDiscussion(decision));
        const view = agentBoard(board, getActor().name);
        return text(decisionDetail(view, view.decisions.find((item) => item.id === decision.id)!, undefined, getActor().name));
      },
    }),

    defineTool({
      name: 'post_decision',
      title: 'Post decision',
      description:
        [
          'Ask people a question as a decision card: one question, 2–4 concrete options (lettered a, b, c… in the order given), your recommendation and why, brief context, and an area (theme). Search first.',
          'blocks puts what people need to see on its canvas in the same call. ask routes it to people, criteria says what to judge the options on, affects names past decisions it could change or rests on. Returns the decision id.',
        ].join(' '),
      guide: {
        topic: 'decisions',
        text: [
          'One question, 2–4 concrete options, your recommendation and why, and brief context: detail only when it changes the decision, and refer to cards as #N and TN, which the board links. Search first, so you don\'t ask again what\'s already decided.',
          'Give it an area (theme) so it joins the right row on the decision map. Set blocking only when you can\'t continue any work without the answer; keep working on whatever it doesn\'t block.',
          'Show, don\'t describe: pass blocks to put what people need to see on its canvas in the same call (options side by side, screenshots, tables, diagrams), the fields of add_block, each optionally pinned to an option letter and named group. Lead with the single visual that most changes the decision.',
          'Route it to the person who has the context with ask (names from the People line of get_board): their next comment or answer clears the wait. When the choice hinges on trade-offs, pass criteria (see propose_criteria).',
          'Name past decisions it could change or rests on with affects, each with why: people see them beside it.',
        ].join(' '),
      },
      schema: tools.post_decision,
      handler: async (args) => {
        const thread = args.thread_id ? store.threadOn(args.thread_id, store.getBoard(args.board_id)) : undefined;
        // Every block is read and checked before any image is saved: first
        // what one names on this computer (a diff, a file), then its fields.
        const blocks: NonNullable<typeof args.blocks> = [];
        for (const [i, block] of (args.blocks ?? []).entries()) blocks.push(await inBlockAsync(i, () => fill(block)));
        const contents = blocks.map((block, i) => inBlock(i, () => readContent(block)));
        const decision = store.postDecision(
          args.board_id,
          {
            question: args.question,
            context: args.context,
            options: args.options,
            recommend: args.recommend,
            recommendationReason: args.recommendation_reason,
            blocking: args.blocking,
            dependsOn: args.depends_on,
            affects: args.affects?.map((a) => ({ decisionId: a.decision_id, why: a.why })),
            area: args.area,
            ask: args.ask,
            askNote: args.ask_note,
            criteria: args.criteria,
            blocks: blocks.map((block, i) => ({
              content: contents[i](),
              title: block.title,
              optionId: block.option,
              group: block.group,
              w: block.width,
              h: block.height,
            })),
          },
          getActor(),
        );
        if (thread) store.addThreadWork(thread.id, { kind: 'decision', id: decision.id }, getActor());
        const people = peopleOn(store.getBoard(args.board_id)).map((p) => p.name);
        const onCanvas = blocks.length ? ` with ${blocks.length} block${blocks.length === 1 ? '' : 's'} on its canvas` : '';
        const shown = thread ? ` It shows in ${inThread(thread)}.` : '';
        const posted = `Posted #${decision.number} [id: ${decision.id}] (status: open)${onCanvas}.${shown} Keep working on anything it doesn't block.`;
        const advice = [
          ...decisionAdvice({ context: args.context, options: args.options, recommend: args.recommend }),
          ...(args.ask?.length ? askAdvice(args.ask, people) : []),
          ...(blocks.length ? [] : emptyCanvasAdvice()),
        ];
        return text(withAdvice(posted, advice));
      },
    }),

    defineTool({
      name: 'update_decision',
      title: 'Update decision',
      description:
        [
          'Refine a decision card: reword it, add context or options, revise options (reword one, or mark it outdated with a reason; nothing is deleted), change the recommendation, blocking flag, dependencies, area, or affects.',
          'What a person decided, deferred, retired, proposed or set is theirs: don\'t reword or answer it.',
          'refreshed: true, with a note, finishes a person\'s refresh request.',
        ].join(' '),
      guide: {
        topic: 'decisions',
        text: [
          'Outdated options can\'t be picked, and can be brought back (restore).',
          'An area can be set on any card, settled ones included, unless a person set it: then it is theirs. Once a person has decided, deferred or retired a question, it is theirs too: comment, attach findings and add canvas blocks, but don\'t reword or answer it.',
          'Options go stale as the app changes. When a person asks for a refresh of a decision (get_board, get_decision and your updates show it), do it next: re-check the card against the app as it is now, then reword the question or context, update or add options, and mark options that no longer apply as outdated with a reason (revise_options), passing refreshed: true with a one-line note, in the same call or on its own.',
          'An option a person proposed or reworded is theirs: leave it and mention it in your note. A card that says it may be out of date can be refreshed the same way unasked. Only people retire a card: if one looks no longer relevant, say so in a comment.',
          'A refresh asked of a decided or provisional card (often because a decision that may change it was just answered) checks its answer still holds: pass refreshed: true with a note saying whether it does, and nothing else. It stays as it is; if it no longer holds, say so in a comment so a person can reopen it.',
          'When a person changes what a decision offers (rewords, outdates or adds options), re-check your recommendation on it.',
        ].join(' '),
      },
      schema: tools.update_decision,
      handler: async (args) => {
        const decision = store.updateDecision(
          args.decision_id,
          {
            question: args.question,
            context: args.context,
            addOptions: args.add_options,
            reviseOptions: args.revise_options?.map((change) => ({
              id: change.option,
              label: change.label,
              description: change.description,
              outdated: change.restore ? false : change.outdated !== undefined ? true : undefined,
              reason: change.outdated,
            })),
            recommend: args.recommend,
            recommendationReason: args.recommendation_reason,
            blocking: args.blocking,
            dependsOn: args.depends_on,
            affects: args.affects?.map((a) => ({ decisionId: a.decision_id, why: a.why })),
            area: args.area,
            refreshed: args.refreshed,
            note: args.note,
          },
          getActor(),
        );
        const { board } = store.getDecision(decision.id);
        const reshaped = args.context !== undefined || args.add_options !== undefined || args.revise_options !== undefined;
        const advice = reshaped
          ? decisionAdvice({
              context: decision.context,
              options: decision.options.filter((o) => !o.outdated),
              recommend: decision.recommendation?.optionId,
            })
          : [];
        const settled = decision.status === 'decided' || decision.status === 'provisional';
        const refreshed = !args.refreshed
          ? ''
          : settled
            ? `Re-checked #${decision.number}, which stays ${decision.status}; people see your note.\n\n`
            : `Refreshed #${decision.number}; people see: ${decision.refreshed!.changes.join(', ') || 'no changes'}.\n\n`;
        const view = agentBoard(board, getActor().name);
        return text(withAdvice(`${refreshed}${decisionDetail(view, view.decisions.find((item) => item.id === decision.id)!)}`, advice));
      },
    }),

    defineTool({
      name: 'log_decision',
      title: 'Log decision',
      description:
        'Record a judgement call you made on your own mid-task, so people can confirm or overturn it. It lands as provisional. Either pass decision_id to answer an existing card (choice may be an option letter), or board_id + question (and an area) to log a new one.',
      schema: tools.log_decision,
      handler: async (args) => {
        const actor = getActor();
        let decisionId = args.decision_id;
        let optionId: string | undefined;
        let answer: string | undefined;

        if (decisionId) {
          if (args.area !== undefined) throw new BoardError("area is for a new card. Set an existing card's area with update_decision.");
          const { decision } = store.getDecision(decisionId);
          if (decision.options.some((o) => o.id === args.choice.trim())) optionId = args.choice.trim();
          else answer = args.choice;
        } else {
          if (!args.board_id || !args.question) {
            throw new BoardError('Pass decision_id, or board_id and question.');
          }
          const options = [args.choice, ...(args.alternatives ?? [])].map((label) => ({ label }));
          decisionId = store.postDecision(args.board_id, { question: args.question, options, area: args.area }, actor).id;
          optionId = 'a';
        }

        const decision = store.resolve(decisionId, { optionId, answer, rationale: args.rationale, provisional: true }, actor);
        return text(`Logged #${decision.number} [id: ${decision.id}] as provisional. People can confirm it or reopen it.`);
      },
    }),

    defineTool({
      name: 'ask_people',
      title: 'Ask people',
      description:
        "Route a decision to named people, e.g. the one who has the context (names from the People line of get_board). It shows as waiting for them, and lands under their Needs you. Their next comment, answer or criteria mark clears the wait; you'll see it in get_updates. This is how to ask a person: an @-mention in a comment only tells them, and clears once they have seen it.",
      schema: tools.ask_people,
      handler: async ({ decision_id, people, note }) => {
        const decision = store.askPeople(decision_id, people, note, getActor());
        const known = peopleOn(store.getDecision(decision.id).board).map((p) => p.name);
        return text(withAdvice(`Asked. #${decision.number} is now waiting for ${people.join(', ')}.`, askAdvice(people, known)));
      },
    }),

    defineTool({
      name: 'propose_criteria',
      title: 'Propose criteria',
      description:
        'When a choice hinges on trade-offs, propose what it should be judged on (or pass criteria on post_decision). People mark each option yes, partly or no against each criterion; you cannot mark them. Read their marks as their reasoning, and don\'t argue with a "no" without new evidence. Good criteria are concrete and checkable ("No silent behaviour change at existing call sites"), not vague ("quality").',
      schema: tools.propose_criteria,
      handler: async ({ decision_id, criteria }) => {
        const decision = store.proposeCriteria(decision_id, criteria, getActor());
        return text(`#${decision.number} now has ${decision.criteria.length} criteria. People will mark the options against them.`);
      },
    }),

    defineTool({
      name: 'attach_finding',
      title: 'Attach finding',
      description:
        'Report evidence on a decision: research results, a prototype outcome, measurements. When people want evidence first (status exploring), investigate (read code, prototype each option, run experiments) and attach each result. Attach to an option when it is about one. Use the same metric names across options so they line up side by side in a comparison.',
      schema: tools.attach_finding,
      handler: async (args) => {
        const decision = store.attachFinding(
          args.decision_id,
          { optionId: args.option, summary: args.summary, metrics: args.metrics, links: args.links },
          getActor(),
        );
        const attached = `Attached finding to #${decision.number} (${decision.findings.length} findings total).`;
        return text(withAdvice(attached, findingAdvice(decision, { optionId: args.option, summary: args.summary, metrics: args.metrics })));
      },
    }),
  ];
}
