// The connectors (registry.ts) and their page. What the other features use of
// it; the canvas, which draws their pieces, reaches its files (test/webImports.test.ts).
export { useConnected } from './chooser';
export { ConnectorsLine, ConnectorsPage } from './page';
export type { ConnectorShare } from './connector';
export { connectorShares, useConnectorShares, webConnectors } from './registry';
