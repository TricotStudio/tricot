// Which operating system this is. Code that branches on it asks here, with
// the name a caller may pass in to stand in for another system (tests do),
// rather than reading process.platform where it stands.
export const currentOs = (): NodeJS.Platform => process.platform;

export const isWindows = (os: NodeJS.Platform = currentOs()): boolean => os === 'win32';
