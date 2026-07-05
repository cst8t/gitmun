import { useState, useEffect, useCallback } from "react";
import { getIdentity, setIdentity as setIdentityApi } from "../api/commands";
import type { GitIdentity, IdentityScope, SetIdentityRequest } from "../types";

export function useGitIdentity(repoPath: string | null, scope: IdentityScope) {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshIdentity = useCallback(async () => {
    if (!repoPath) {
      setIdentity(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const id = await getIdentity(repoPath, scope);
      setIdentity(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoPath, scope]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!repoPath) {
        setIdentity(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const id = await getIdentity(repoPath, scope);
        if (!cancelled) setIdentity(id);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => { cancelled = true; };
  }, [repoPath, scope]);

  const saveIdentity = async (payload: Omit<SetIdentityRequest, "scope" | "repoPath">) => {
    if (!repoPath) return;
    setSaving(true);
    setError(null);
    try {
      await setIdentityApi({ repoPath, scope, ...payload });
      const updated = await getIdentity(repoPath, scope);
      setIdentity(updated);
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  return { identity, loading, saving, error, saveIdentity, refreshIdentity };
}
