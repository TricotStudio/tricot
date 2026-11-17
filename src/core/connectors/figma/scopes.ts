// What Tricot uses of a Figma token, by Figma's own names for the scopes. It
// only reads: the token may allow more, and Tricot never uses it.

export const FILE_CONTENT = 'file_content:read';
export const FILE_COMMENTS = 'file_comments:read';
// Needed once, to read the name shown as "Connected as…".
export const CURRENT_USER = 'current_user:read';

export const WANTED = [FILE_CONTENT, FILE_COMMENTS];
