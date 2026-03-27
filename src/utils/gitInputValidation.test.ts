import { describe, expect, test } from "vitest";
import {
  getRemoteNameError,
  getTagNameError,
  getCloneRepoUrlError,
} from "./gitInputValidation";

describe("getRemoteNameError", () => {
  test("returns null for empty/whitespace input", () => {
    expect(getRemoteNameError("")).toBeNull();
    expect(getRemoteNameError("   ")).toBeNull();
  });

  test("returns null for valid remote names", () => {
    expect(getRemoteNameError("origin")).toBeNull();
    expect(getRemoteNameError("upstream")).toBeNull();
    expect(getRemoteNameError("my-remote")).toBeNull();
    expect(getRemoteNameError("remote_1")).toBeNull();
  });

  test("rejects names starting with -", () => {
    expect(getRemoteNameError("-origin")).not.toBeNull();
  });

  test("rejects names with spaces", () => {
    expect(getRemoteNameError("my remote")).not.toBeNull();
  });

  test("rejects names with control characters", () => {
    expect(getRemoteNameError("remote\x00name")).not.toBeNull();
    expect(getRemoteNameError("remote\x1fname")).not.toBeNull();
    expect(getRemoteNameError("remote\x7fname")).not.toBeNull();
  });

  test("rejects invalid ref patterns", () => {
    expect(getRemoteNameError("remote..name")).not.toBeNull();
    expect(getRemoteNameError("remote@{name}")).not.toBeNull();
    expect(getRemoteNameError("remote//name")).not.toBeNull();
    expect(getRemoteNameError("remote/")).not.toBeNull();
    expect(getRemoteNameError("remote.")).not.toBeNull();
    expect(getRemoteNameError("remote.lock")).not.toBeNull();
    expect(getRemoteNameError("/remote")).not.toBeNull();
    expect(getRemoteNameError(".remote")).not.toBeNull();
  });

  test("rejects names with special chars ~^:?*[\\", () => {
    for (const ch of ["~", "^", ":", "?", "*", "[", "\\"]) {
      expect(getRemoteNameError(`remote${ch}`)).not.toBeNull();
    }
  });
});

describe("getTagNameError", () => {
  test("returns null for empty/whitespace input", () => {
    expect(getTagNameError("")).toBeNull();
    expect(getTagNameError("   ")).toBeNull();
  });

  test("returns null for valid tag names", () => {
    expect(getTagNameError("v1.0.0")).toBeNull();
    expect(getTagNameError("release-candidate")).toBeNull();
    expect(getTagNameError("my_tag")).toBeNull();
  });

  test("rejects names starting with -", () => {
    expect(getTagNameError("-v1.0")).not.toBeNull();
  });

  test("rejects names with spaces", () => {
    expect(getTagNameError("v1 0")).not.toBeNull();
  });

  test("rejects control characters", () => {
    expect(getTagNameError("v1\x00")).not.toBeNull();
  });

  test("rejects invalid ref patterns", () => {
    expect(getTagNameError("v1..0")).not.toBeNull();
    expect(getTagNameError("v1.lock")).not.toBeNull();
    expect(getTagNameError("v1/")).not.toBeNull();
  });
});

describe("getCloneRepoUrlError", () => {
  test("returns null for empty/whitespace input", () => {
    expect(getCloneRepoUrlError("")).toBeNull();
    expect(getCloneRepoUrlError("   ")).toBeNull();
  });

  test("returns null for valid URLs", () => {
    expect(getCloneRepoUrlError("https://github.com/user/repo")).toBeNull();
    expect(getCloneRepoUrlError("git@github.com:user/repo.git")).toBeNull();
    expect(getCloneRepoUrlError("ssh://git@host/repo")).toBeNull();
    expect(getCloneRepoUrlError("/local/path/to/repo")).toBeNull();
  });

  test("rejects URLs starting with -", () => {
    expect(getCloneRepoUrlError("-malicious")).not.toBeNull();
  });

  test("rejects URLs with control characters", () => {
    expect(getCloneRepoUrlError("https://host\x00/repo")).not.toBeNull();
    expect(getCloneRepoUrlError("https://host\x1f/repo")).not.toBeNull();
    expect(getCloneRepoUrlError("https://host\x7f/repo")).not.toBeNull();
  });
});
