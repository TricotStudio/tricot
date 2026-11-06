import { shellFor, type Shell } from '../core/connect';
import { isWindows } from '../platform/os';

// The shell the commands this command prints are for: PowerShell on Windows
// (the default in Windows Terminal), else zsh or bash. `platform` is
// CliContext.platform, which tests stand in for.
export const shellOf = (platform?: NodeJS.Platform): Shell => shellFor(isWindows(platform));
