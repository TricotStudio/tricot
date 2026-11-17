// The events in a board's log that are not news to anyone: reordering a lane,
// and a reaction to an agent's comment (logged for that agent). What others
// changed after a person last looked leaves them out, in the page (changes.ts)
// and in the store's queries (store/eventTables.ts), so the list is the core's:
// the page without a part asks it too (a part's attention module re-exports it).
export const NOT_NEWS = ['task_reordered', 'comment_reacted'];
