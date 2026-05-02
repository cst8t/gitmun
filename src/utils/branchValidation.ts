export function getBranchNameError(branchName: string): string | null {
  const trimmed = branchName.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed === "HEAD") {
    return "validation.branchHead";
  }

  if (trimmed.startsWith("-") || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return "validation.branchInvalid";
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
    return "validation.branchInvalid";
  }

  return null;
}
