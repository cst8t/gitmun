export function repoNameFromPath(path: string): string {
  const normalised = path.replace(/[\\/]+$/, "");
  const match = normalised.match(/^(.*[\\/])([^\\/]+)$/);

  if (!match) {
    return normalised;
  }

  return match[2];
}

export function buildMainWindowTitle(repoPath: string, repoDisplayName: string | null): string {
  return `${displayNameForRepoPath(repoPath, repoDisplayName)} - ${repoPath}`;
}

export function displayNameForRepoPath(repoPath: string, repoDisplayName: string | null | undefined): string {
  return repoDisplayName ?? repoNameFromPath(repoPath);
}
