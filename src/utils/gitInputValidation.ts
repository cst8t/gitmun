function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function hasInvalidRefPattern(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    /[~^:?*\[\\]/.test(value)
  );
}

export function getRemoteNameError(name: string): string | null {
  const trimmed = name.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("-")) {
    return "validation.remoteStartsWithDash";
  }

  if (/\s/.test(trimmed)) {
    return "validation.remoteSpaces";
  }

  if (hasControlCharacters(trimmed) || hasInvalidRefPattern(trimmed)) {
    return "validation.remoteInvalid";
  }

  return null;
}

export function getTagNameError(tagName: string): string | null {
  const trimmed = tagName.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("-")) {
    return "validation.tagStartsWithDash";
  }

  if (/\s/.test(trimmed)) {
    return "validation.tagSpaces";
  }

  if (hasControlCharacters(trimmed) || hasInvalidRefPattern(trimmed)) {
    return "validation.tagInvalid";
  }

  return null;
}

export function getCloneRepoUrlError(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("-")) {
    return "validation.repoUrlStartsWithDash";
  }

  if (hasControlCharacters(trimmed)) {
    return "validation.repoUrlInvalidCharacters";
  }

  return null;
}
