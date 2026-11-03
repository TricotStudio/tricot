// The order kinds and their fields have always been listed in where agents and
// people read them. It is kept here, so each listing reads the same as it did
// before kinds had their own folders; a kind or a field not named here is
// listed after those that are, in the order they were registered, so a new
// kind needs nothing from this file.

// Kinds as add_block's type and the fields of each kind are listed (a
// checklist is a type agents may still name: it makes a note).
export const AGENT_KINDS = ['note', 'table', 'checklist', 'diagram', 'image', 'comparison', 'link', 'diff', 'code', 'chart'];

// Kinds in add_block's "Fields by type" (link before comparison) and in the
// advice about them.
export const DOC_KINDS = ['note', 'table', 'diagram', 'image', 'link', 'comparison', 'diff', 'code', 'chart'];

// The clauses of their own update_block's description gives a kind.
export const UPDATE_SPECIALS = ['code', 'chart', 'image'];

// add_block's fields, update_block's, and the pin tool's.
export const ADD_FIELDS = [
  'board_id',
  'decision_id',
  'task_id',
  'type',
  'title',
  'text',
  'columns',
  'rows',
  'items',
  'source',
  'image_path',
  'image_base64',
  'caption',
  'url',
  'patch',
  'focus',
  'path',
  'language',
  'start',
  'total',
  'commit',
  'kind',
  'unit',
  'subtitle',
  'highlight',
  'width',
  'height',
  'group_id',
  'option',
  'thread_id',
];
export const UPDATE_FIELDS = [
  'block_id',
  'rev',
  'title',
  'text',
  'columns',
  'rows',
  'items',
  'source',
  'caption',
  'image_path',
  'image_base64',
  'url',
  'patch',
  'focus',
  'path',
  'language',
  'start',
  'total',
  'commit',
  'kind',
  'unit',
  'subtitle',
  'highlight',
  'option',
  'group_id',
  'restore_rev',
  'thread_id',
];
export const PIN_FIELDS = [
  'block_id',
  'pin_id',
  'task_id',
  'decision_id',
  'text',
  'occurrence',
  'item',
  'row',
  'to_row',
  'column',
  'to_column',
  'box',
  'node',
  'to_node',
  'file',
  'line',
  'side',
  'category',
  'series',
];

// The patch fields a change is checked against, and so the one a refusal names first.
export const PATCH_FIELDS = [
  'image',
  'patch',
  'focus',
  'path',
  'language',
  'start',
  'total',
  'highlight',
  'commit',
  'kind',
  'unit',
  'subtitle',
  'open',
  'text',
  'columns',
  'rows',
  'items',
  'source',
  'caption',
  'url',
];

// `items` in the order of `list`, those it doesn't name after, as they came.
export function ordered<T>(items: readonly T[], list: readonly string[], name: (item: T) => string): T[] {
  const rank = (item: T) => {
    const at = list.indexOf(name(item));
    return at === -1 ? list.length : at;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}
