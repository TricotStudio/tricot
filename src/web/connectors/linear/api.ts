import type { ConnectorStatus } from '../../../core/connectors';
import type { CardAnswer } from '../../../core/connectors/linear/issue';
import { routes } from '../../../core/routes';
import { get, post } from '../../shared/api';

// Linear's calls to the server (server/connectors/linear/routes.ts).

export type { CardAnswer };

export const linearApi = {
  // A personal API key, checked once with Linear and kept, or why not.
  useKey: (key: string) => post(routes.linearKey)<{ connector: ConnectorStatus }>({ key }),

  // An issue's live card, by its identifier (ENG-123).
  card: (identifier: string, fresh = false) => get(routes.linearIssue)<CardAnswer>({ identifier }, fresh ? { fresh: '1' } : undefined),
};
