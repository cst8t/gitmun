export function getBranchNameError(branchName: string): string | null {
  const trimmed = branchName.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed === "HEAD") {
    return "Branch name cannot be HEAD";
  }

  if (trimmed.startsWith("-") || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return "Invalid branch name format";
  }

  if (
    /\s/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    trimmed.includes("//") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(".lock") ||
    /[~^:?*\[\\]/.test(trimmed)
  ) {
    return "Invalid branch name format";
  }

  return null;
}
