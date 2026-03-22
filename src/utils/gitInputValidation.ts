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
    return "Remote name cannot start with '-'";
  }

  if (/\s/.test(trimmed)) {
    return "Remote name cannot contain spaces";
  }

  if (hasControlCharacters(trimmed) || hasInvalidRefPattern(trimmed)) {
    return "Invalid remote name format";
  }

  return null;
}

export function getTagNameError(tagName: string): string | null {
  const trimmed = tagName.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("-")) {
    return "Tag name cannot start with '-'";
  }

  if (/\s/.test(trimmed)) {
    return "Tag name cannot contain spaces";
  }

  if (hasControlCharacters(trimmed) || hasInvalidRefPattern(trimmed)) {
    return "Invalid tag name format";
  }

  return null;
}

export function getCloneRepoUrlError(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("-")) {
    return "Repository URL cannot start with '-'";
  }

  if (hasControlCharacters(trimmed)) {
    return "Repository URL contains invalid characters";
  }

  return null;
}
