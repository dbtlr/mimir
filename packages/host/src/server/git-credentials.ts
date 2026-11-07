import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

/** The setting that names the git credential-store file (ADR 0041). */
export const GIT_CREDENTIALS_SETTING = 'MIMIR_GIT_CREDENTIALS_FILE';

/**
 * `MIMIR_GIT_CREDENTIALS_FILE`, an optional setting that degrades like ADR
 * 0040's: unset, the host clones public repositories only; set but unreadable,
 * the host warns and clones without credentials, so only a private
 * repository's sync fails.
 */
export type GitCredentialsSetting =
  | { configured: false }
  | { configured: true; file: string; problem: 'unreadable' | undefined };

/** Whether `file` names a regular file (a directory passes `access`) this process can read now. */
async function readable(file: string): Promise<boolean> {
  if (file.trim() === '' || file.includes('\0')) {
    return false;
  }
  try {
    await access(file, constants.R_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Read `MIMIR_GIT_CREDENTIALS_FILE`; a problem with it never refuses startup. */
export async function readGitCredentials(env: NodeJS.ProcessEnv): Promise<GitCredentialsSetting> {
  const file = env[GIT_CREDENTIALS_SETTING];
  if (file === undefined) {
    return { configured: false };
  }
  return { configured: true, file, problem: (await readable(file)) ? undefined : 'unreadable' };
}

/**
 * Check the setting again where it is used: the file is mounted, so it can
 * appear, vanish, or be replaced after boot. A configured file that is
 * unreadable now reads as `unreadable`.
 */
export async function currentGitCredentials(
  setting: GitCredentialsSetting,
): Promise<GitCredentialsSetting> {
  return setting.configured
    ? readGitCredentials({ [GIT_CREDENTIALS_SETTING]: setting.file })
    : setting;
}

/** The warnings for the setting: its name and problem, never its value. */
export function gitCredentialsWarnings(setting: GitCredentialsSetting): string[] {
  if (!setting.configured || setting.problem === undefined) {
    return [];
  }
  return [
    `⚠ host: ${GIT_CREDENTIALS_SETTING} is ${setting.problem}; the host clones without credentials, so only public repositories sync`,
  ];
}
