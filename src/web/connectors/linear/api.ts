import type { ConnectorStatus } from '../../../core/connectors';
import type { CardAnswer } from '../../../core/connectors/linear/issue';
import { linearRoutes } from '../../../core/connectors/linear/routes';
import { get, post } from '../../shared/api';

// Linear's calls to the server: its routes (core/connectors/linear/routes.ts), served
// by server/connectors/linear/routes.ts.

export type { CardAnswer };

export const linearApi = {
  // A personal API key, checked once with Linear and kept, or why not.
  useKey: (key: string) => post(linearRoutes.key)<{ connector: ConnectorStatus }>({ key }),

  // An issue's live card, by its identifier (ENG-123).
  card: (identifier: string, fresh = false) => get(linearRoutes.issue)<CardAnswer>({ identifier }, fresh ? { fresh: '1' } : undefined),
};
