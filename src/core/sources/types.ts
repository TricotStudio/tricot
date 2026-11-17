// What a link's address says it is. See ./index.ts.

// The mark a card draws for its source: a key into the web's marks
// (web/canvas/sources), which each source's web half adds to.
export type SourceMark = string;

export interface Embed {
  url: string; // what the frame loads, built from the parts read off the address
  sandbox: string; // as tight as the source allows; no source may navigate the board itself
  allow?: string; // permissions the frame may use, e.g. fullscreen for a video
  referrer: 'no-referrer' | 'strict-origin'; // strict-origin sends the board's origin, never its path
  size: { w: number; h: number }; // the block's size when it first opens in place
  blocked: string; // said when the view doesn't load in this browser
}

export interface LinkSource {
  kind: string; // the service, as cards and agents name it: "Google Docs", "GitHub"
  what?: string; // what it is there, when the service has several: "pull request"
  ref?: string; // how the service names it: "microsoft/TypeScript #142"
  name: string; // a readable title for an untitled link: "Google Doc"
  site: string; // whose page it opens, for "Open in Google"
  mark: SourceMark;
  embed?: Embed;
  fileId?: string; // a file's id with its connector, for its real name once that is connected; not a published copy's
  editable?: true; // its connector can edit it in Tricot: its card says so, and starts wider
  card?: { w: number; h: number }; // its card's size, when its connector gives it a preview to show
  connector?: string; // the connector the source belongs to, when it comes from one (set by the registry)
}

// A source of links: the hosts it answers for, and how it reads an address
// there. One is a small file (core/sources/<name>.ts) and a line in the
// registry; a connector brings its own (core/connectors/<id>/sources.ts).
export interface LinkSourceKind {
  readonly id: string;
  readonly hosts: readonly string[]; // without www.; "*.example.com" for any subdomain of it
  read(url: URL, parts: string[]): LinkSource | null;
  // How it is named among the links that open in place: "Figma", "Google Docs, Sheets and Slides".
  readonly embeds?: string;
}
