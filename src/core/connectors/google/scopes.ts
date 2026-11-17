// What Google's sign-in can ask for. No imports: everything else in the
// connector may read these.

// What a sign-in asks for now: only the files a person chooses with Google's
// picker (the Docs API works on those too).
export const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
// What earlier sign-ins asked for: every Drive file's name, and every Google
// Doc. They keep working until a person signs in again.
export const DRIVE_METADATA = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
