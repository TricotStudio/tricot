import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseDocs, type PickerApi, type PickerEnv } from '../src/web/connectors/google/picker';

// Google's Picker, faked at its JS API: it records how the page built it and
// lets the test play the person's part (choose docs, or close it).
function fakePicker() {
  const built: { views: { mimeTypes?: string; mode?: string; fileIds?: string; folders?: boolean }[]; calls: Record<string, unknown>; features: string[] } = {
    views: [],
    calls: {},
    features: [],
  };
  let callback: ((data: { action: string; docs?: { id?: string; name?: string; url?: string }[] }) => void) | undefined;
  let visible = false;
  class DocsView {
    state: (typeof built.views)[number] = {};
    constructor(readonly id: string) {
      built.views.push(this.state);
      built.calls.view = id;
    }
    setMimeTypes(types: string) {
      this.state.mimeTypes = types;
      return this;
    }
    setMode(mode: string) {
      this.state.mode = mode;
      return this;
    }
    setFileIds(ids: string) {
      this.state.fileIds = ids;
      return this;
    }
    setIncludeFolders(include: boolean) {
      this.state.folders = include;
      return this;
    }
  }
  class PickerBuilder {
    addView() {
      return this;
    }
    setOAuthToken(token: string) {
      built.calls.token = token;
      return this;
    }
    setAppId(id: string) {
      built.calls.appId = id;
      return this;
    }
    setDeveloperKey(key: string) {
      built.calls.apiKey = key;
      return this;
    }
    setOrigin(origin: string) {
      built.calls.origin = origin;
      return this;
    }
    setTitle(title: string) {
      built.calls.title = title;
      return this;
    }
    enableFeature(feature: string) {
      built.features.push(feature);
      return this;
    }
    setCallback(next: typeof callback) {
      callback = next;
      return this;
    }
    build() {
      return {
        setVisible: (value: boolean) => {
          visible = value;
        },
      };
    }
  }
  const api: PickerApi = {
    ViewId: { DOCUMENTS: 'DOCS' },
    DocsViewMode: { LIST: 'list' },
    Feature: { MULTISELECT_ENABLED: 'multiselect' },
    Action: { PICKED: 'picked', CANCEL: 'cancel' },
    DocsView: DocsView as unknown as PickerApi['DocsView'],
    PickerBuilder: PickerBuilder as unknown as PickerApi['PickerBuilder'],
  };
  const env: PickerEnv = { loadApi: async () => api, origin: 'http://127.0.0.1:4545' };
  return { env, built, user: (data: Parameters<NonNullable<typeof callback>>[0]) => callback!(data), shown: () => visible };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Google's Picker in the browser", () => {
  it("shows Google Docs as the signed-in person, from this page's origin, and returns what they chose", async () => {
    const fake = fakePicker();
    const chosen = chooseDocs({ accessToken: 'tok', appId: '123', apiKey: 'key' }, {}, fake.env);
    await tick();
    assert.equal(fake.shown(), true);
    assert.deepEqual(fake.built.views, [{ mimeTypes: 'application/vnd.google-apps.document', mode: 'list', folders: false }]);
    assert.deepEqual(fake.built.calls, {
      view: 'DOCS',
      token: 'tok',
      origin: 'http://127.0.0.1:4545',
      title: 'Choose the Google Docs Tricot may use',
      appId: '123',
      apiKey: 'key',
    });
    assert.deepEqual(fake.built.features, []);
    fake.user({ action: 'loaded' });
    fake.user({ action: 'picked', docs: [{ id: '1AbCdEfGhIjKlMnOp', name: 'Launch plan', url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit' }, { name: 'no id' }] });
    assert.deepEqual(await chosen, [{ id: '1AbCdEfGhIjKlMnOp', name: 'Launch plan', url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit' }]);
  });

  it('shows just one doc to choose when asked for it, lets several be chosen when asked, and leaves out a missing key', async () => {
    const fake = fakePicker();
    const chosen = chooseDocs({ accessToken: 'tok' }, { fileIds: ['1AbCdEfGhIjKlMnOp'], multiple: true, title: 'Choose "Launch plan"' }, fake.env);
    await tick();
    assert.equal(fake.built.views[0].fileIds, '1AbCdEfGhIjKlMnOp');
    assert.deepEqual(fake.built.features, ['multiselect']);
    assert.equal(fake.built.calls.title, 'Choose "Launch plan"');
    assert.ok(!('apiKey' in fake.built.calls) && !('appId' in fake.built.calls));
    fake.user({ action: 'cancel' });
    assert.deepEqual(await chosen, [], 'closing it chooses nothing');
  });
});
