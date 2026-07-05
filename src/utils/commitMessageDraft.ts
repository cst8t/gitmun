export type CommitMessageDraft = {
  subject: string;
  body: string;
  updatedAt: number;
};

const DRAFT_KEY_PREFIX = "gitmun.commitMessageDraft.v1:";

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function keyForRepo(repoPath: string) {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(repoPath)}`;
}

function isDraft(value: unknown): value is CommitMessageDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as CommitMessageDraft;
  return typeof draft.subject === "string" && typeof draft.body === "string" && typeof draft.updatedAt === "number";
}

export function loadCommitMessageDraft(repoPath: string): CommitMessageDraft | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const parsed = JSON.parse(storage.getItem(keyForRepo(repoPath)) ?? "null");
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCommitMessageDraft(repoPath: string, subject: string, body: string) {
  const storage = getStorage();
  if (!storage) return;

  try {
    if (subject.trim() === "" && body.trim() === "") {
      storage.removeItem(keyForRepo(repoPath));
      return;
    }

    storage.setItem(keyForRepo(repoPath), JSON.stringify({
      subject,
      body,
      updatedAt: Date.now(),
    }));
  } catch {
  }
}

export function clearCommitMessageDraft(repoPath: string) {
  try {
    getStorage()?.removeItem(keyForRepo(repoPath));
  } catch {
  }
}
