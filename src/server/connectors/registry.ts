// The connectors' server halves, one line each: a new connector is a folder
// (server/connectors/<id>/) and an import and an entry here. Internal:
// nothing is loaded from outside this repository.

import type { ServerConnectorKind } from './connector';
import { figmaServer } from './figma';
import { githubServer } from './github';
import { googleServer } from './google';
import { linearServer } from './linear';
import { slackServer } from './slack';

export const serverConnectors: readonly ServerConnectorKind[] = [googleServer, figmaServer, githubServer, slackServer, linearServer];
