// Markdown as it reads: no markers for headings, lists, emphasis, code or links.
export function plainMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[\s(])[*_](\S(?:[^*_\n]*\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s*\|\s*/g, ' · ');
}
