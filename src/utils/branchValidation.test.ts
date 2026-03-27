import { describe, expect, test } from "vitest";
import { getBranchNameError } from "./branchValidation";

describe("getBranchNameError", () => {
  test("returns null for empty/whitespace input", () => {
    expect(getBranchNameError("")).toBeNull();
    expect(getBranchNameError("   ")).toBeNull();
  });

  test("returns null for valid branch names", () => {
    expect(getBranchNameError("main")).toBeNull();
    expect(getBranchNameError("feature/my-thing")).toBeNull();
    expect(getBranchNameError("fix-123")).toBeNull();
    expect(getBranchNameError("release/1.0.0")).toBeNull();
    expect(getBranchNameError("user/feature_branch")).toBeNull();
  });

  test("rejects HEAD", () => {
    expect(getBranchNameError("HEAD")).not.toBeNull();
  });

  test("rejects names starting with -", () => {
    expect(getBranchNameError("-branch")).not.toBeNull();
  });

  test("rejects names starting with /", () => {
    expect(getBranchNameError("/branch")).not.toBeNull();
  });

  test("rejects names starting with .", () => {
    expect(getBranchNameError(".branch")).not.toBeNull();
  });

  test("rejects names with spaces", () => {
    expect(getBranchNameError("my branch")).not.toBeNull();
    expect(getBranchNameError("feature/ thing")).not.toBeNull();
  });

  test("rejects names containing ..", () => {
    expect(getBranchNameError("feat..fix")).not.toBeNull();
  });

  test("rejects names containing @{", () => {
    expect(getBranchNameError("branch@{1}")).not.toBeNull();
  });

  test("rejects names containing //", () => {
    expect(getBranchNameError("feat//fix")).not.toBeNull();
  });

  test("rejects names ending with /", () => {
    expect(getBranchNameError("branch/")).not.toBeNull();
  });

  test("rejects names ending with .", () => {
    expect(getBranchNameError("branch.")).not.toBeNull();
  });

  test("rejects names ending with .lock", () => {
    expect(getBranchNameError("branch.lock")).not.toBeNull();
    expect(getBranchNameError("refs/heads/main.lock")).not.toBeNull();
  });

  test("rejects names with special chars ~^:?*[\\", () => {
    for (const ch of ["~", "^", ":", "?", "*", "[", "\\"]) {
      expect(getBranchNameError(`branch${ch}name`)).not.toBeNull();
    }
  });
});
