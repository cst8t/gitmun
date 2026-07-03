import type { FileStatusItem } from "../types";

export type FileTreeFileNode = {
  type: "file";
  name: string;
  path: string;
  file: FileStatusItem;
  additions: number;
  deletions: number;
};

export type FileTreeDirectoryNode = {
  type: "directory";
  name: string;
  path: string;
  children: FileTreeNode[];
  selectablePath?: string;
  status?: string;
  fileCount: number;
  additions: number;
  deletions: number;
};

export type FileTreeNode = FileTreeDirectoryNode | FileTreeFileNode;

type MutableDirectoryNode = Omit<FileTreeDirectoryNode, "children"> & {
  children: Map<string, MutableTreeNode>;
};

type MutableTreeNode = MutableDirectoryNode | FileTreeFileNode;

function createDirectory(name: string, path: string): MutableDirectoryNode {
  return {
    type: "directory",
    name,
    path,
    children: new Map(),
    fileCount: 0,
    additions: 0,
    deletions: 0,
  };
}

function accumulateFileStats(directory: MutableDirectoryNode, file: FileStatusItem) {
  directory.fileCount += 1;
  directory.additions += file.additions ?? 0;
  directory.deletions += file.deletions ?? 0;
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function finaliseDirectory(directory: MutableDirectoryNode): FileTreeDirectoryNode {
  const children = sortNodes(
    Array.from(directory.children.values()).map((child) =>
      child.type === "directory" ? finaliseDirectory(child) : child,
    ),
  );

  if (directory.name !== "" && children.length === 1 && children[0].type === "directory") {
    const child = children[0];
    return {
      type: "directory",
      name: `${directory.name}/${child.name}`,
      path: child.path,
      children: child.children,
      selectablePath: child.selectablePath,
      status: child.status,
      fileCount: directory.fileCount,
      additions: directory.additions,
      deletions: directory.deletions,
    };
  }

  return {
    type: "directory",
    name: directory.name,
    path: directory.path,
    children,
    selectablePath: directory.selectablePath,
    status: directory.status,
    fileCount: directory.fileCount,
    additions: directory.additions,
    deletions: directory.deletions,
  };
}

export function buildFileTree(files: FileStatusItem[]): FileTreeNode[] {
  const root = createDirectory("", "");

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let directory = root;
    accumulateFileStats(directory, file);

    if (file.kind === "directory") {
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        const path = parts.slice(0, index + 1).join("/");
        const existing = directory.children.get(name);
        const child = existing?.type === "directory" ? existing : createDirectory(name, path);
        directory.children.set(name, child);
        accumulateFileStats(child, file);
        directory = child;
      }

      directory.selectablePath = file.path;
      directory.status = file.status;
      continue;
    }

    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join("/");
      const existing = directory.children.get(name);
      const child = existing?.type === "directory" ? existing : createDirectory(name, path);
      directory.children.set(name, child);
      accumulateFileStats(child, file);
      directory = child;
    }

    const name = parts[parts.length - 1];
    directory.children.set(name, {
      type: "file",
      name,
      path: file.path,
      file,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    });
  }

  return finaliseDirectory(root).children;
}

export function descendantFilePaths(node: FileTreeDirectoryNode): string[] {
  return [
    ...(node.selectablePath ? [node.selectablePath] : []),
    ...node.children.flatMap((child) =>
      child.type === "directory" ? descendantFilePaths(child) : [child.path],
    ),
  ];
}
