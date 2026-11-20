import { isLengthUnit } from "./units";
import type { ProjectState } from "./types";

export type ProjectRevision = {
  id: string;
  label: string;
  savedAt: string;
  project: ProjectState;
};

export type LocalProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectState;
  revisions: ProjectRevision[];
};

export type ProjectLibrary = {
  version: 1;
  projects: LocalProject[];
};

const STORAGE_KEY = "floorplan-studio-stair-projects-v1";

function createId() {
  return globalThis.crypto?.randomUUID?.() ??
    `project-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProjectState(value: unknown): value is ProjectState {
  return (
    isRecord(value) &&
    (value.projectType === "staircase" || value.projectType === "ladder") &&
    (value.units === "imperial" || value.units === "metric") &&
    (value.displayUnit === undefined || isLengthUnit(value.displayUnit)) &&
    isRecord(value.stairParams) &&
    isRecord(value.ladderParams) &&
    isRecord(value.calculatedMetrics)
  );
}

export function readProjectLibrary(): ProjectLibrary {
  if (typeof localStorage === "undefined") return { version: 1, projects: [] };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.projects)
    ) {
      return { version: 1, projects: [] };
    }
    const projects: LocalProject[] = [];
    for (const item of parsed.projects) {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.createdAt !== "string" ||
        typeof item.updatedAt !== "string" ||
        !isProjectState(item.project) ||
        !Array.isArray(item.revisions)
      ) {
        continue;
      }
      const revisions: ProjectRevision[] = item.revisions.filter(
        (revision): revision is ProjectRevision =>
          isRecord(revision) &&
          typeof revision.id === "string" &&
          typeof revision.label === "string" &&
          typeof revision.savedAt === "string" &&
          isProjectState(revision.project),
      );
      projects.push({
        id: item.id,
        name: item.name,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        project: item.project,
        revisions,
      });
    }
    return { version: 1, projects };
  } catch {
    return { version: 1, projects: [] };
  }
}

export function writeProjectLibrary(library: ProjectLibrary) {
  if (typeof localStorage === "undefined") {
    throw new Error("Local project storage is unavailable in this environment.");
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
}

export function makeLocalProject(
  name: string,
  project: ProjectState,
): LocalProject {
  const now = new Date().toISOString();
  return {
    id: createId(),
    name: name.trim() || "Untitled project",
    createdAt: now,
    updatedAt: now,
    project: structuredClone(project),
    revisions: [],
  };
}

export function addProjectRevision(
  project: LocalProject,
  label: string,
  state: ProjectState,
): LocalProject {
  const now = new Date().toISOString();
  return {
    ...project,
    updatedAt: now,
    project: structuredClone(state),
    revisions: [
      ...project.revisions,
      {
        id: createId(),
        label: label.trim() || `Revision ${project.revisions.length + 1}`,
        savedAt: now,
        project: structuredClone(state),
      },
    ],
  };
}

export function duplicateLocalProject(
  project: LocalProject,
  name?: string,
): LocalProject {
  return {
    ...makeLocalProject(name ?? `${project.name} copy`, project.project),
    revisions: project.revisions.map((revision) => ({
      ...revision,
      id: createId(),
      project: structuredClone(revision.project),
    })),
  };
}
