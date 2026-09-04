export const RECENT_REPOSITORIES_STORAGE_KEY = "gitmun.recentRepos";
export const RECENT_REPOSITORIES_LIMIT = 10;

export function normaliseRecentRepositories(paths: readonly unknown[]): string[] {
  const uniquePaths: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || uniquePaths.includes(path)) continue;
    uniquePaths.push(path);
    if (uniquePaths.length === RECENT_REPOSITORIES_LIMIT) break;
  }
  return uniquePaths;
}

export function loadRecentRepositories(storage: Pick<Storage, "getItem">): string[] {
  try {
    const stored = JSON.parse(storage.getItem(RECENT_REPOSITORIES_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? normaliseRecentRepositories(stored) : [];
  } catch {
    return [];
  }
}

export function saveRecentRepositories(
  storage: Pick<Storage, "setItem">,
  paths: readonly string[],
): string[] {
  const next = normaliseRecentRepositories(paths);
  storage.setItem(RECENT_REPOSITORIES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function addRecentRepository(paths: readonly string[], path: string): string[] {
  return normaliseRecentRepositories([path, ...paths.filter(recentPath => recentPath !== path)]);
}

export function removeRecentRepository(paths: readonly string[], path: string): string[] {
  return paths.filter(recentPath => recentPath !== path);
}
