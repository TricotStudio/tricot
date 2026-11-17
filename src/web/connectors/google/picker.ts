// Google's Picker, in the browser: how a person chooses which Google Docs
// Tricot may use (the drive.file access). The script is Google's own, loaded
// from apis.google.com when a person first chooses; the token, key and project
// it takes come from the server (server/connectors/google/routes.ts) and go
// only to the Picker. The Picker's JS API is the one boundary tests fake
// (PickerApi, below): nothing here talks to Google otherwise.

// What the server gives the Picker.
export interface PickerConfig {
  accessToken: string;
  appId?: string;
  apiKey?: string;
}

export interface PickedDoc {
  id: string;
  name: string;
  url: string;
}

// The parts of google.picker that are used.
interface DocsViewApi {
  setMimeTypes(types: string): DocsViewApi;
  setMode(mode: string): DocsViewApi;
  setFileIds(ids: string): DocsViewApi;
  setIncludeFolders(include: boolean): DocsViewApi;
}
interface PickerBuilderApi {
  addView(view: DocsViewApi): PickerBuilderApi;
  setOAuthToken(token: string): PickerBuilderApi;
  setAppId(appId: string): PickerBuilderApi;
  setDeveloperKey(key: string): PickerBuilderApi;
  setOrigin(origin: string): PickerBuilderApi;
  setTitle(title: string): PickerBuilderApi;
  enableFeature(feature: string): PickerBuilderApi;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilderApi;
  build(): { setVisible(visible: boolean): void };
}
export interface PickerApi {
  ViewId: { DOCUMENTS: string };
  DocsViewMode: { LIST: string };
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
  DocsView: new (viewId: string) => DocsViewApi;
  PickerBuilder: new () => PickerBuilderApi;
}
interface PickerResponse {
  action: string;
  docs?: { id?: string; name?: string; url?: string }[];
}

// Where the Picker comes from: Google's script, and the origin it is shown on.
export interface PickerEnv {
  loadApi(): Promise<PickerApi>;
  origin: string;
}

const SCRIPT = 'https://apis.google.com/js/api.js';
const DOC_MIME = 'application/vnd.google-apps.document';

let loading: Promise<PickerApi> | undefined;

interface PickerWindow {
  gapi?: { load(name: string, options: { callback(): void; onerror(): void }): void };
  google?: { picker?: PickerApi };
}

function loadFromGoogle(): Promise<PickerApi> {
  loading ??= new Promise<PickerApi>((resolve, reject) => {
    const host = window as unknown as PickerWindow;
    const failed = () => {
      loading = undefined;
      reject(new Error("Google's chooser couldn't load. Check your connection and try again."));
    };
    const ready = () => {
      if (!host.gapi) return failed();
      host.gapi.load('picker', {
        callback: () => (host.google?.picker ? resolve(host.google.picker) : failed()),
        onerror: failed,
      });
    };
    if (host.gapi) return ready();
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = ready;
    script.onerror = failed;
    document.head.append(script);
  });
  return loading;
}

export const browserPicker = (): PickerEnv => ({ loadApi: loadFromGoogle, origin: `${location.protocol}//${location.host}` });

// Shows the Picker, as the signed-in person, over Google Docs. `fileIds` shows
// just those (to choose the one doc Tricot couldn't open); `multiple` lets
// several be chosen. Resolves with what they chose: nothing when they close it.
export async function chooseDocs(
  config: PickerConfig,
  options: { fileIds?: string[]; multiple?: boolean; title?: string } = {},
  env: PickerEnv = browserPicker(),
): Promise<PickedDoc[]> {
  const picker = await env.loadApi();
  const view = new picker.DocsView(picker.ViewId.DOCUMENTS).setMimeTypes(DOC_MIME).setMode(picker.DocsViewMode.LIST).setIncludeFolders(false);
  if (options.fileIds?.length) view.setFileIds(options.fileIds.join(','));
  return new Promise<PickedDoc[]>((resolve) => {
    let builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(config.accessToken)
      .setOrigin(env.origin)
      .setTitle(options.title ?? 'Choose the Google Docs Tricot may use')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs ?? []).flatMap((d) => (d.id && d.url ? [{ id: d.id, name: d.name ?? 'Google Doc', url: d.url }] : [])));
        } else if (data.action === picker.Action.CANCEL) resolve([]);
      });
    if (config.appId) builder = builder.setAppId(config.appId);
    if (config.apiKey) builder = builder.setDeveloperKey(config.apiKey);
    if (options.multiple) builder = builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    builder.build().setVisible(true);
  });
}
