import { basename } from "node:path";

import { normalizePath } from "./git-utils.js";
import { getGitStatus } from "./git-status.js";
import { buildWorkspaceReviewFilesResponse } from "./workspace-review.js";
import type {
  Session,
  Workspace,
  WorkspaceReviewFile,
  WorkspaceReviewSessionAction,
} from "./types.js";

export class WorkspaceReviewSessionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceReviewSessionError";
  }
}

type ReviewSessionSelection = {
  files: WorkspaceReviewFile[];
  visiblePrompt: string;
  sessionName: string;
};

function visiblePrompt(action: WorkspaceReviewSessionAction): string {
  switch (action) {
    case "review":
      return "Review the selected files for bugs, regressions, and risky patterns. Cite file and line number for each finding.";
    case "reflect":
      return "Reflect on the changes in the selected files. Identify missing follow-ups, cleanup work, and next steps.";
    case "prepare_commit":
      return "Prepare a commit for the selected changes. Suggest a conventional commit title and body.";
  }
}

function sessionTitle(action: WorkspaceReviewSessionAction): string {
  switch (action) {
    case "review":
      return "Review";
    case "reflect":
      return "Reflect";
    case "prepare_commit":
      return "Prepare commit";
  }
}

export async function prepareWorkspaceReviewSession(args: {
  workspaceId: string;
  workspace: Workspace;
  action: WorkspaceReviewSessionAction;
  paths: string[];
  selectedSession?: Session;
}): Promise<ReviewSessionSelection> {
  const { workspace, action, paths, selectedSession } = args;

  if (!workspace.hostMount) {
    throw new WorkspaceReviewSessionError(404, "Workspace review unavailable");
  }

  const gitStatus = await getGitStatus(workspace.hostMount);
  if (!gitStatus.isGitRepo) {
    throw new WorkspaceReviewSessionError(409, "Workspace is not a git repository");
  }

  const review = buildWorkspaceReviewFilesResponse({
    workspaceId: args.workspaceId,
    gitStatus,
    selectedSession,
    workspaceRoot: workspace.hostMount,
  });

  const uniquePaths = Array.from(
    new Set(paths.map((p) => normalizePath(p)).filter((value) => value.length > 0)),
  );

  if (uniquePaths.length === 0) {
    throw new WorkspaceReviewSessionError(400, "paths array required");
  }

  const reviewFilesByPath = new Map(
    review.files.map((file) => [normalizePath(file.path), file] as const),
  );
  const requestedFiles: WorkspaceReviewFile[] = [];
  const missingPaths: string[] = [];

  for (const path of uniquePaths) {
    const file = reviewFilesByPath.get(path);
    if (!file) {
      missingPaths.push(path);
      continue;
    }
    requestedFiles.push(file);
  }

  if (missingPaths.length > 0) {
    throw new WorkspaceReviewSessionError(
      400,
      `Selected files are no longer available in the current review: ${missingPaths.join(", ")}`,
    );
  }

  const title = sessionTitle(action);
  const onlyFile = requestedFiles.length === 1 ? requestedFiles[0] : undefined;
  const sessionName = (
    onlyFile ? `${title}: ${basename(onlyFile.path)}` : `${title}: ${requestedFiles.length} files`
  ).slice(0, 160);

  return {
    files: requestedFiles,
    visiblePrompt: visiblePrompt(action),
    sessionName,
  };
}
