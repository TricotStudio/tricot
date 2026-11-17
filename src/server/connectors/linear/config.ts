// Tricot Studio's Linear app, as shipped, and where Linear's endpoints are.
//
// Linear's sign-in for an app that can't keep a secret is OAuth 2.0 with PKCE
// and a loopback redirect: the code exchange and every refresh send the
// client ID and the PKCE verifier and no client secret, so the one value
// below is public and there is no secret anywhere in this code. Fill it in
// once, after registering the app in Tricot Studio's Linear workspace (steps
// in docs/configuration.md, "Linear sign-in"). Until it is filled in (a value
// starting with FILL_IN counts as empty), Tricot has no app of its own to sign
// in with and the connector offers only a personal API key.

export interface BuiltInLinear {
  // "Client ID" on the OAuth application's page in Linear's API settings.
  clientId: string;
}

const PLACEHOLDER = 'FILL_IN';
export const CLIENT_ID_SHAPE = /^[A-Za-z0-9_-]{16,80}$/;
const filled = (value: string) => value !== '' && !value.startsWith(PLACEHOLDER);

export const BUILT_IN_LINEAR: BuiltInLinear = {
  clientId: PLACEHOLDER,
};

// The app's client ID once it is filled in: otherwise undefined, as if there were none.
export function builtInLinearClientId(values: BuiltInLinear = BUILT_IN_LINEAR): string | undefined {
  const clientId = values.clientId.trim();
  return filled(clientId) && CLIENT_ID_SHAPE.test(clientId) ? clientId : undefined;
}

export interface LinearEndpoints {
  auth: string; // where the person allows access
  token: string; // the code exchange and the refresh
  revoke: string;
  graphql: string; // the API
}

export const LINEAR_ENDPOINTS: LinearEndpoints = {
  auth: 'https://linear.app/oauth/authorize',
  token: 'https://api.linear.app/oauth/token',
  revoke: 'https://api.linear.app/oauth/revoke',
  graphql: 'https://api.linear.app/graphql',
};
