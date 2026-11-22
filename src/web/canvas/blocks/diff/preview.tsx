// A diff's totals and its files, each with what it added and took away: the
// file's name, then its folder, which gives way first. As many files as fit
// are drawn, the rest cut off where the frame ends.

import { diffTotals } from '../../../../core/blocks/diff/diff';
import type { Block } from '../../../../core/types';
import type { PreviewProps } from '../kind';
import '../../diff.css';

type DiffBlock = Extract<Block, { type: 'diff' }>;

const FILES = 10;
const count = (n: number) => n.toLocaleString('en-US');

export function DiffPreview({ block }: PreviewProps<DiffBlock>) {
  const totals = diffTotals(block.files);
  return (
    <div className="preview-diff">
      <p className="preview-diff-totals">
        <span className="diff-plus">+{count(totals.additions)}</span> <span className="diff-minus">−{count(totals.deletions)}</span>
        <span> · {totals.files === 1 ? '1 file' : `${count(totals.files)} files`}</span>
      </p>
      <ul>
        {block.files.slice(0, FILES).map((file) => {
          const at = file.path.lastIndexOf('/');
          return (
            <li key={file.path}>
              <span className="preview-diff-name">{file.path.slice(at + 1)}</span>
              <span className="preview-diff-folder">{at > 0 ? file.path.slice(0, at) : ''}</span>
              <span className="diff-plus">+{count(file.additions)}</span>
              <span className="diff-minus">−{count(file.deletions)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
