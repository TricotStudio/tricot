export class BoardError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'conflict' = 'invalid',
  ) {
    super(message);
  }
}
