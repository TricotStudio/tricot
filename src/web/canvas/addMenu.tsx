import { useRef, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { Icon, type IconName } from '../shared/components';
import type { AddContext } from './blocks/kind';
import { menuKinds } from './blocks/registry';
import { ToolbarMenu, type ToolbarMenuApi } from './toolbarMenu';

// The Add form that is open on the canvas, and what it opened with (a pasted address).
export type AddForm = { type: string; initial?: string };

interface Props {
  owner?: string; // the kind of card whose canvas this is: the kinds that only its canvas takes can be added too
  context: AddContext;
  toggleOf(type: string): RefObject<HTMLButtonElement | null>; // the menu item that opens a kind's form
  setForm: Dispatch<SetStateAction<AddForm | null>>;
  addGroup(): Promise<void>;
}

// The canvas's Add: one button, which drops a menu of what can be added
// (toolbarMenu.tsx), every kind's entry in the order the registry gives
// (menuKinds) and Group last, each by its icon. An entry does what it always
// did: adds a block at once, opens its form under the toolbar (the form's own
// `toggle` is that item, so a press on it doesn't count as a click away, and
// an entry that `toggles` closes the form it opened), or opens the file
// picker, whose input stays here, hidden, once the menu has closed. Picking
// closes the menu with the focus back on Add, unless a form opens, which
// takes it. An open form is kept when the menu opens over it, a draft in it
// too: Escape closes the menu alone.
export function AddMenu({ owner, context, toggleOf, setForm, addGroup }: Props) {
  const pickers = useRef(new Map<string, HTMLInputElement | null>()); // the file picker of each kind that adds by file
  const kinds = menuKinds().filter((kind) => !kind.menu!.only || kind.menu!.only === owner);

  // The rows in order, the rule before Group among them, each with its place
  // in the menu's entrance.
  const rows = ({ open, close, enter }: ToolbarMenuApi) => {
    const pick = (run: () => void) => () => {
      close(true);
      run();
    };
    const entry = (row: number, key: string, icon: IconName, label: string, onClick: () => void, ref?: RefObject<HTMLButtonElement | null>): ReactNode => (
      <button
        key={key}
        ref={open ? ref : undefined}
        type="button"
        role={open ? 'menuitem' : undefined}
        tabIndex={-1}
        className="menu-item is-line add-menu-item"
        style={enter(row)}
        onClick={onClick}
      >
        <span className="add-menu-row">
          <Icon name={icon} className="add-menu-icon" />
          {label}
        </span>
      </button>
    );
    return (
      <>
        {kinds.map((kind, row) => {
          const item = kind.menu!;
          if ('add' in item) {
            return entry(row, kind.type, item.icon, item.label, pick(() => {
              const { content, title } = item.add();
              void context.add(content, { title });
            }));
          }
          if ('Form' in item) {
            const toggle = () => setForm((shown) => (shown?.type !== kind.type ? { type: kind.type } : item.toggles ? null : shown));
            return entry(row, kind.type, item.icon, item.label, pick(toggle), toggleOf(kind.type));
          }
          return entry(row, kind.type, item.icon, item.label, pick(() => pickers.current.get(kind.type)?.click()));
        })}
        <div role="separator" className="menu-rule add-menu-rule" style={enter(kinds.length)} />
        {entry(kinds.length + 1, 'group', 'group', 'Group', pick(() => void addGroup()))}
      </>
    );
  };

  return (
    <ToolbarMenu
      icon="plus"
      label="Add"
      title="Add to the canvas"
      menuLabel="Add to the canvas"
      rows={kinds.length + 2}
      after={menuKinds().flatMap((kind) =>
        kind.menu && 'pick' in kind.menu
          ? [
              <input
                key={kind.type}
                ref={(el) => void pickers.current.set(kind.type, el)}
                type="file"
                accept={kind.menu.pick.accept}
                multiple
                hidden
                onChange={(e) => {
                  void kind.files!.add([...(e.target.files ?? [])], context);
                  e.target.value = '';
                }}
              />,
            ]
          : [],
      )}
    >
      {rows}
    </ToolbarMenu>
  );
}
