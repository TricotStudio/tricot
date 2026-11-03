import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Mark } from '../src/web/canvas/sources/mark';
import { figma } from '../src/web/canvas/sources/figma';
import { github } from '../src/web/canvas/sources/github';
import { loom } from '../src/web/canvas/sources/loom';
import { LOGOS, SITES, siteMark } from '../src/web/canvas/sources/sites';
import { youtube } from '../src/web/canvas/sources/youtube';
import { googleMarks } from '../src/web/connectors/google/marks';

// The icon a link card shows for its site: Tricot's own drawing for the sites
// people link most, matched by the link's host, and none (a plain link icon)
// for any other, since nothing is ever fetched from the site (#78).

const google = googleMarks;

describe("A link's site icon", () => {
  it('is the icon of a site people link most, reusing the marks the board already draws', () => {
    const expected: [string, Mark][] = [
      ['https://github.com/settings/tokens', github.marks.github],
      ['https://gitlab.com/gitlab-org/gitlab/-/issues/1', LOGOS.gitlab],
      ['https://www.figma.com/files/team/1/recents', figma.marks.figma],
      ['https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit', google['google-docs']],
      ['https://docs.google.com/spreadsheets/u/0/', google['google-sheets']],
      ['https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit', google['google-slides']],
      ['https://docs.google.com/forms/d/e/1FAIpQLSf/viewform', google['google-forms']],
      ['https://docs.google.com/file/d/1AbCdEfGhIjKlMn/view', google['google-drive']],
      ['https://drive.google.com/drive/folders/1AbC', google['google-drive']],
      ['https://forms.gle/AbC123', google['google-forms']],
      ['https://www.youtube.com/@channel', youtube.marks.youtube],
      ['https://youtu.be/', youtube.marks.youtube],
      ['https://www.loom.com/looms/videos', loom.marks.loom],
      ['https://www.notion.so/team/Roadmap-0123456789abcdef', LOGOS.notion],
      ['https://linear.app/acme/issue/ENG-42/ship-it', LOGOS.linear],
      ['https://acme.slack.com/archives/C0123/p1700000000', LOGOS.slack],
      ['https://acme.atlassian.net/browse/ENG-42', LOGOS.jira],
      ['https://acme.atlassian.net/jira/software/projects/ENG/boards/1', LOGOS.jira],
      ['https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Plan', LOGOS.confluence],
      ['https://acme.atlassian.net/wiki', LOGOS.confluence],
      ['https://vercel.com/acme/web/deployments', LOGOS.vercel],
      ['https://www.npmjs.com/package/react', LOGOS.npm],
      ['https://stackoverflow.com/questions/1/how', LOGOS.stackOverflow],
      ['https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP', LOGOS.mdn],
      ['https://en.wikipedia.org/wiki/Tricot', LOGOS.wikipedia],
    ];
    for (const [address, mark] of expected) assert.equal(siteMark(address), mark, address);
  });

  it("matches a site's subdomains, and the longest match first", () => {
    const expected: [string, Mark][] = [
      ['https://gist.github.com/someone/0123abcd', github.marks.github],
      ['https://raw.githubusercontent.com/acme/web/main/README.md', github.marks.github],
      ['https://docs.github.com/en/rest', github.marks.github],
      ['https://about.gitlab.com/', LOGOS.gitlab],
      ['https://mail.google.com/mail/u/0/', google.google],
      ['https://www.google.com/search?q=tricot', google.google],
      ['https://docs.google.com/', google.google],
      ['https://docs.google.com/drawings/d/1AbC/edit', google.google],
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', youtube.marks.youtube],
      ['https://music.youtube.com/', youtube.marks.youtube],
      ['https://acme.notion.site/Public-page-0123', LOGOS.notion],
      ['https://app.slack.com/client/T0/C0', LOGOS.slack],
      ['https://registry.npmjs.org/react', LOGOS.npm],
      ['https://ru.stackoverflow.com/questions/1', LOGOS.stackOverflow],
      ['https://en.m.wikipedia.org/wiki/Tricot', LOGOS.wikipedia],
      ['https://fr.wikipedia.org/wiki/Tricot', LOGOS.wikipedia],
    ];
    for (const [address, mark] of expected) assert.equal(siteMark(address), mark, address);
  });

  it('reads the host as the browser does: any case, a port, http, a trailing dot, credentials', () => {
    for (const address of [
      'HTTPS://WWW.GitHub.COM/acme',
      'https://github.com:443/acme',
      'http://github.com/acme',
      'https://github.com./acme',
      'https://someone@github.com/acme',
      'https://github.com',
      'https://github.com/acme?tab=repositories#readme',
      'https:///github.com/acme', // the browser goes to github.com here, too
    ]) {
      assert.equal(siteMark(address), github.marks.github, address);
    }
    assert.equal(siteMark('https://ACME.Atlassian.NET/WIKI/spaces'), LOGOS.confluence, 'the path, too, in any case');
    assert.equal(siteMark('https://acme.atlassian.net/wikis/x'), LOGOS.jira, 'only /wiki itself is Confluence');
  });

  it('is none for any other site, so its card shows a plain link icon', () => {
    for (const address of [
      'https://example.com/',
      'https://acme.github.io/docs/', // other people's sites, served by GitHub
      'https://acme.gitlab.io/',
      'https://web-git-feature-acme.vercel.app/',
      'https://github.com.evil.example/acme', // a lookalike: only the end of a host counts
      'https://evilgithub.com/',
      'https://notgoogle.com/',
      'https://google.com.evil.example/',
      'https://mozilla.org/',
      'https://atlassian.com/software/jira',
      'http://127.0.0.1:4871/page',
      'http://localhost:3000/',
      'http://[::1]:8080/',
      'http://192.168.1.10/',
    ]) {
      assert.equal(siteMark(address), null, address);
    }
  });

  it("is none for an address that isn't a web page, or isn't an address", () => {
    for (const address of [
      '',
      'github.com/acme', // no scheme: not a URL yet
      'not a url',
      'mailto:someone@github.com',
      'javascript:alert(1)//github.com',
      'ftp://github.com/acme',
      'data:text/html,github.com',
      'file:///Users/someone/github.com',
      'https://',
      'https://__proto__/', // names on every object, never sites
      'https://constructor/',
      'https://toString.example/',
    ]) {
      assert.equal(siteMark(address), null, address);
    }
  });

  it('lists each site by a host as a URL keeps it: lower case, without www, its own domain', () => {
    for (const domain of Object.keys(SITES)) {
      assert.equal(new URL(`https://${domain}/`).hostname, domain, domain);
      assert.ok(!domain.startsWith('www.'), `${domain}: www. is a subdomain, matched anyway`);
      assert.ok(domain.includes('.'), `${domain}: a domain, not a top-level one`);
    }
  });

  it('draws every icon in Tricot, as vector shapes: nothing in one asks for a picture', () => {
    const marks = new Set<Mark>(Object.values(LOGOS));
    for (const [domain, icon] of Object.entries(SITES)) {
      if (typeof icon !== 'function') marks.add(icon);
      else for (const path of ['/', '/document/d/x', '/spreadsheets/d/x', '/presentation/d/x', '/forms/d/x', '/file/d/x', '/wiki']) marks.add(icon(new URL(`https://${domain}${path}`)));
    }
    for (const mark of marks) {
      assert.ok(mark.tile && mark.glyph, 'a tile and a glyph');
      const svg = renderToStaticMarkup(createElement('svg', { viewBox: '0 0 32 32' }, mark.glyph));
      assert.match(svg, /<(path|circle|rect|g)\b/, svg.slice(0, 80));
      assert.doesNotMatch(svg, /<(img|image|use|foreignObject)\b|href=|url\(/i, svg.slice(0, 80));
    }
  });
});
