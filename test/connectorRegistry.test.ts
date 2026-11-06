import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectorKinds, connectorPinning, connectorsLine, describeAccess, findConnector } from '../src/core/connectors';
import { DOCS_SCOPE } from '../src/core/connectors/google/scopes';
import { embeddable, linkSource } from '../src/core/sources';
import { callbackPath, isCallbackPath } from '../src/server/connectors/connector';
import { serverConnectors } from '../src/server/connectors/registry';

// The registries are what the rest of the app asks: these are the contracts between them.

describe('The connector registries', () => {
  it('lists each connector once on the core and server sides, by the same ids', () => {
    assert.deepEqual(connectorKinds().map((k) => k.id), ['google', 'figma', 'github', 'slack', 'linear']);
    assert.deepEqual(serverConnectors.map((k) => k.id), connectorKinds().map((k) => k.id));
    assert.equal(findConnector('google')?.name, 'Google');
    assert.equal(findConnector('github')?.name, 'GitHub');
    assert.equal(findConnector('slack')?.name, 'Slack');
    assert.equal(findConnector('linear')?.name, 'Linear');
    assert.equal(findConnector('nope'), undefined);
  });

  it('tags the links a connector recognises with it, and leaves the others untagged', () => {
    assert.equal(linkSource('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit')?.connector, 'google');
    assert.equal(linkSource('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit')?.editable, true);
    assert.equal(linkSource('https://docs.google.com/document/d/e/2PACX-1AbCdEfGhIjKlMnOp/pub')?.editable, undefined);
    assert.equal(linkSource('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit')?.editable, undefined);
    assert.equal(linkSource('https://www.figma.com/file/aBcD1234/Old-file')?.connector, 'figma');
    assert.equal(linkSource('https://www.figma.com/community/file/836596421863073964/mobile-ui-kit')?.connector, undefined);
    assert.equal(linkSource('https://linear.app/acme/issue/ENG-123/fix-the-login')?.connector, 'linear');
    assert.equal(linkSource('https://linear.app/acme/team/ENG/active')?.connector, undefined);
    assert.equal(linkSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.connector, undefined);
  });

  it('names the links that open in place from the sources, in the order they are listed', () => {
    assert.equal(embeddable(), 'Google Docs, Sheets and Slides, Figma, YouTube and Loom');
  });

  it('says in plain words what a sign-in asks for, from the connectors that know the scopes', () => {
    assert.deepEqual(describeAccess(['openid', 'email', DOCS_SCOPE], ['email']), [
      { scope: 'email', label: 'See your email address, to show which account is connected', granted: true },
      { scope: DOCS_SCOPE, label: 'See and edit your Google Docs', granted: false },
    ]);
    assert.match(connectorsLine([]), /^Connectors: none connected\. People connect services such as Google, Figma, GitHub, Slack and Linear on the Connectors page/);
  });

  it('finds the connector that owns a kind of pin', () => {
    assert.equal(connectorPinning('doc')?.id, 'google');
    assert.equal(connectorPinning('text'), undefined);
  });

  it('knows a sign-in callback from the contract, for any connector and nothing else', () => {
    assert.equal(callbackPath('google'), '/api/connectors/google/callback');
    assert.ok(isCallbackPath(callbackPath('google')));
    assert.ok(isCallbackPath(callbackPath('anything-new')));
    for (const path of ['/api/connectors/google/start', '/api/connectors//callback', '/api/connectors/a/b/callback', '/api/connectors/google/callback/x', '/api/callback', '/mcp']) {
      assert.equal(isCallbackPath(path), false, path);
    }
  });
});
