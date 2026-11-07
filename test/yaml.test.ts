import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gooseConfig, hermesConfig } from '../src/core/connect';
import { yamlText } from '../src/core/yaml';

// The YAML Tricot shows for an agent whose settings are a YAML file (Goose's,
// Hermes's) and writes into one. There is no YAML library to read it back, so
// each case is the text it must be, checked against YAML's own rules by hand.
describe('YAML text for a settings file', () => {
  it('writes maps and lists in block style, two spaces deep', () => {
    assert.equal(
      yamlText({ extensions: { tricot: { name: 'tricot', enabled: true, timeout: 300, env_keys: ['TRICOT_TOKEN'], headers: { Authorization: 'Bearer ${TRICOT_TOKEN}' } } } }),
      ['extensions:', '  tricot:', '    name: tricot', '    enabled: true', '    timeout: 300', '    env_keys:', '      - TRICOT_TOKEN', '    headers:', '      Authorization: "Bearer ${TRICOT_TOKEN}"'].join('\n'),
    );
  });

  it('writes a list of maps with the first key after the dash, and a list in a list', () => {
    assert.equal(yamlText({ hooks: [{ matcher: 'a|b', command: 'x y', timeout: 5 }, { command: 'z' }] }), ['hooks:', '  - matcher: "a|b"', '    command: "x y"', '    timeout: 5', '  - command: z'].join('\n'));
    assert.equal(yamlText({ grid: [[1, 2], [3]] }), ['grid:', '  - - 1', '    - 2', '  - - 3'].join('\n'));
  });

  it("quotes every string that isn't a plain word, as JSON, and words YAML would read as something else", () => {
    assert.equal(yamlText({ a: 'plain-word_1', b: 'http://127.0.0.1:4545/mcp?agent=Goose', c: 'yes', d: 'null', e: '', f: '12', g: '#note', h: 'say "hi"\nthen go', i: '- x', j: 'a: b' }), [
      'a: plain-word_1',
      'b: "http://127.0.0.1:4545/mcp?agent=Goose"',
      'c: "yes"',
      'd: "null"',
      'e: ""',
      'f: "12"',
      'g: "#note"',
      'h: "say \\"hi\\"\\nthen go"',
      'i: "- x"',
      'j: "a: b"',
    ].join('\n'));
  });

  it('quotes a key that is not a plain word, writes empty lists and maps on one line, and leaves out undefined', () => {
    assert.equal(yamlText({ 'a b': 1, 'on': 2, list: [], map: {}, gone: undefined, nothing: null, no: false }), ['"a b": 1', '"on": 2', 'list: []', 'map: {}', 'nothing: null', '"no": false'].join('\n'));
  });

  it('writes a lone value, and refuses a number YAML has no text for', () => {
    assert.equal(yamlText('x y'), '"x y"');
    assert.equal(yamlText([]), '[]');
    assert.equal(yamlText({}), '{}');
    assert.throws(() => yamlText({ n: Number.NaN }), /not finite/);
  });

  it("is Goose's entry, then Hermes's, as each reads its own file", () => {
    const url = 'http://127.0.0.1:4545/mcp?agent=Goose';
    assert.equal(yamlText(gooseConfig(url)), ['extensions:', '  tricot:', '    name: tricot', '    type: streamable_http', `    uri: "${url}"`, '    enabled: true', '    timeout: 300'].join('\n'));
    assert.equal(
      yamlText(gooseConfig(url, 'secret')),
      ['extensions:', '  tricot:', '    name: tricot', '    type: streamable_http', `    uri: "${url}"`, '    enabled: true', '    timeout: 300', '    env_keys:', '      - TRICOT_TOKEN', '    headers:', '      Authorization: "Bearer ${TRICOT_TOKEN}"'].join('\n'),
    );
    const hermesUrl = 'http://127.0.0.1:4545/mcp?agent=Hermes';
    assert.equal(yamlText(hermesConfig(hermesUrl)), ['mcp_servers:', '  tricot:', `    url: "${hermesUrl}"`, '    timeout: 300'].join('\n'));
    assert.equal(yamlText(hermesConfig(hermesUrl, 'secret')), ['mcp_servers:', '  tricot:', `    url: "${hermesUrl}"`, '    timeout: 300', '    headers:', '      Authorization: "Bearer ${TRICOT_TOKEN}"'].join('\n'));
    assert.doesNotMatch(yamlText(gooseConfig(url, 'secret')) + yamlText(hermesConfig(hermesUrl, 'secret')), /secret/, 'the token itself never goes in: only the variable that holds it');
  });
});
