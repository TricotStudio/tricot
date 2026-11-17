// Files' preview of a file it can show as more than its text, drawn
// as the board draws that kind, with the board's own renderers: Markdown as a
// note reads (its pictures and links to the project's files resolved, as its
// repository shows them), Mermaid as a diagram, CSV and TSV as a table, and a
// picture as itself. Its text is a switch away (FilesView: Source).

import { useMemo, useState } from 'react';
import { delimitedRows, imageTypeOf, type FilePreview } from '../../core/projectFiles';
import { routes, routeUrl } from '../../core/routes';
import type { Board } from '../../core/types';
import { Mermaid } from '../canvas';
import { Md, type Beside } from '../shared/components';
import { linkTo } from '../shared/pages';
import { besideFile } from './tree';

const MOST_ROWS = 2000; // rows the table draws; the file holds them all

export function FilePreviewBody({ board, file, kind, text }: { board: Board; file: string; kind: Exclude<FilePreview, 'image'>; text: string }) {
  if (kind === 'markdown') return <MarkdownFile board={board} file={file} text={text} />;
  if (kind === 'mermaid')
    return (
      <div className="files-diagram">
        <Mermaid source={text} />
      </div>
    );
  return <TableFile file={file} text={text} />;
}

function MarkdownFile({ board, file, text }: { board: Board; file: string; text: string }) {
  const beside = useMemo<Beside>(
    () => ({
      picture: (src) => {
        const found = besideFile(file, src);
        return found && imageTypeOf(found) ? routeUrl(routes.projectImage, { boardId: board.id }, { path: found }) : undefined;
      },
      link: (href) => {
        const found = besideFile(file, href);
        return found ? linkTo.files(board.id, found) : undefined;
      },
    }),
    [board.id, file],
  );
  return (
    <article className="files-doc">
      <Md beside={beside}>{text}</Md>
    </article>
  );
}

const NUMBER = /^[-+]?[\d.,]+%?$|^[-+]?[$£€]\s?[\d.,]+$/;

function TableFile({ file, text }: { file: string; text: string }) {
  const rows = useMemo(() => delimitedRows(text, file.toLowerCase().endsWith('.tsv') ? '\t' : ','), [text, file]);
  if (!rows.length) return <p className="files-note">{file} is empty.</p>;
  const [head, ...body] = rows;
  const width = Math.max(...rows.map((row) => row.length));
  const cells = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');
  // A column of numbers reads right-aligned, as a table of figures does.
  const numeric = cells(head).map((_, c) => body.length > 0 && body.every((row) => !row[c] || NUMBER.test(row[c].trim())) && body.some((row) => row[c]));
  return (
    <div className="files-table">
      <table className="block-table">
        <thead>
          <tr>
            {cells(head).map((cell, c) => (
              <th key={c} className={numeric[c] ? 'is-number' : undefined}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MOST_ROWS).map((row, r) => (
            <tr key={r}>
              {cells(row).map((cell, c) => (
                <td key={c} className={numeric[c] ? 'is-number' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="files-table-count">
        {body.length.toLocaleString('en-US')} {body.length === 1 ? 'row' : 'rows'} · {width} {width === 1 ? 'column' : 'columns'}
        {body.length > MOST_ROWS && `, the first ${MOST_ROWS.toLocaleString('en-US')} shown`}
      </p>
    </div>
  );
}

// A picture, fitted to the space; a click shows it at its actual size, and
// another fits it again. `stamp` changes as the file does, to fetch it anew.
export function PictureFile({ board, file, stamp }: { board: Board; file: string; stamp: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const src = routeUrl(routes.projectImage, { boardId: board.id }, { path: file, v: stamp });
  const name = file.slice(file.lastIndexOf('/') + 1);
  const why = () =>
    fetch(src)
      .then((answer) => answer.json() as Promise<{ error?: string }>)
      .then((answer) => setFailed(answer.error ?? `${name} couldn't be shown.`))
      .catch(() => setFailed(`${name} couldn't be shown.`));
  if (failed) return <p className="files-note is-error">{failed}</p>;
  return (
    <figure className={`files-picture${actual ? ' is-actual' : ''}`}>
      <button type="button" className="files-picture-frame" onClick={() => setActual(!actual)} title={actual ? 'Fit it to the space' : 'Show it at its actual size'} aria-label={actual ? `Fit ${name}` : `${name} at actual size`}>
        <img
          src={src}
          alt={name}
          draggable={false}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => void why()}
          style={actual && size ? { width: file.toLowerCase().endsWith('.svg') ? size.width : size.width / (window.devicePixelRatio || 1) } : undefined} // a pixel of it on a pixel of the screen; an SVG's own size
        />
      </button>
      {size && (
        <figcaption>
          {size.width} × {size.height}
          {actual ? ' · actual size' : ''}
        </figcaption>
      )}
    </figure>
  );
}
