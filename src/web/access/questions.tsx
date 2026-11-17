import { useState } from 'react';
import { joinAnswer, MAX_OTHER_ANSWER, type AskedQuestion, type QuestionAnswers } from '../../core/approvals';

// An agent's question (Claude Code's AskUserQuestion, core/approvals.ts
// questionsOf), drawn as the questions it is: each with its options as radio
// buttons, or checkboxes when several may be picked, and an "Other" choice
// with a field for the person's own words. What the agent sent is plain text,
// never Markdown or a link. "Send answer" gives back, for each question's
// text, the label picked (several joined by ", ") or the person's words.

interface Chosen {
  labels: string[]; // the options picked, by their labels
  other: boolean; // "Other" is chosen
  words: string; // what the person wrote for it
}

const NOTHING: Chosen = { labels: [], other: false, words: '' };

// What a pick says, or undefined while it says nothing yet.
function said(question: AskedQuestion, pick: Chosen): string | undefined {
  const parts = question.options.map((o) => o.label).filter((label) => pick.labels.includes(label));
  if (pick.other && pick.words.trim()) parts.push(pick.words.trim());
  return parts.length ? joinAnswer(parts) : undefined;
}

export function QuestionForm({ id, questions, busy, onSend, onTerminal, onDecline }: { id: string; questions: AskedQuestion[]; busy: boolean; onSend: (answers: QuestionAnswers) => void; onTerminal: () => void; onDecline: () => void }) {
  const [picks, setPicks] = useState<Chosen[]>(() => questions.map(() => NOTHING));
  const change = (at: number, next: (pick: Chosen) => Chosen) => setPicks((all) => all.map((pick, i) => (i === at ? next(pick) : pick)));
  const answers = questions.map((question, i) => said(question, picks[i]));
  const ready = answers.every((answer) => answer !== undefined);

  const send = () => {
    if (!ready) return;
    onSend(Object.fromEntries(questions.map((question, i) => [question.question, answers[i]!])));
  };

  return (
    <form
      className="approval-questions"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {questions.map((question, at) => {
        const pick = picks[at];
        const name = `question-${id}-${at}`;
        const kind = question.multiSelect ? 'checkbox' : 'radio';
        return (
          <fieldset key={question.question} className="approval-question" disabled={busy}>
            <legend className="approval-question-text">
              {question.header && <span className="approval-question-header">{question.header}</span>}
              {question.question}
              {question.multiSelect && <span className="faint"> (pick any)</span>}
            </legend>
            {question.options.map((option) => {
              const on = pick.labels.includes(option.label);
              return (
                <label key={option.label} className={`approval-option${on ? ' is-picked' : ''}`}>
                  <input
                    type={kind}
                    name={name}
                    checked={on}
                    onChange={() =>
                      change(at, (p) =>
                        question.multiSelect
                          ? { ...p, labels: on ? p.labels.filter((l) => l !== option.label) : [...p.labels, option.label] }
                          : { labels: [option.label], other: false, words: p.words },
                      )
                    }
                  />
                  <span className="approval-option-text">
                    <span className="approval-option-label">{option.label}</span>
                    {option.description && <span className="approval-option-description">{option.description}</span>}
                  </span>
                </label>
              );
            })}
            <label className={`approval-option${pick.other ? ' is-picked' : ''}`}>
              <input
                type={kind}
                name={name}
                checked={pick.other}
                onChange={() => change(at, (p) => (question.multiSelect ? { ...p, other: !p.other } : { labels: [], other: true, words: p.words }))}
              />
              <span className="approval-option-text">
                <span className="approval-option-label">Other</span>
                <input
                  type="text"
                  className="input approval-other"
                  aria-label={`Your own answer to “${question.question}”`}
                  placeholder="Your own answer"
                  value={pick.words}
                  maxLength={MAX_OTHER_ANSWER}
                  onChange={(e) => change(at, (p) => ({ ...p, words: e.target.value, other: true, labels: question.multiSelect ? p.labels : [] }))}
                />
              </span>
            </label>
          </fieldset>
        );
      })}
      <div className="approval-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy || !ready}>
          Send answer
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onTerminal} disabled={busy} title="Leave it to the agent's terminal, which asks there">
          Answer in the terminal
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onDecline} disabled={busy} title="Say no to the agent, and why if you like">
          Decline…
        </button>
      </div>
    </form>
  );
}
