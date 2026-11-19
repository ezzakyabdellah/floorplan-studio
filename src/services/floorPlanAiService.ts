import { generateLocalJson, type StreamOptions } from "./localAiService";
import {
  critiqueFloorPlanLayout,
  type LayoutDiagnostic,
} from "./floorPlanLayoutCritique";
import {
  solveFloorPlanLayout,
  validateSemanticFloorPlan,
  type RoomConnection,
  type RoomZone,
  type SemanticFloorPlan,
  type SemanticLink,
  type SemanticRoom,
  type SolvedFloorPlan,
  type SolvedRoom,
} from "./floorPlanLayoutSolver";
import type { Opening, Wall } from "../types/floorplan";

export type GeneratedFloorPlan = {
  name: string;
  walls: Wall[];
  openings: Opening[];
  rooms: SolvedRoom[];
  warnings: string[];
};

type ProgramRoom = Omit<SemanticRoom, "windows">;
type RoomProgram = {
  grid_unit_m: number;
  entrance_room: string;
  rooms: ProgramRoom[];
};

type RoomUpdate = {
  id: string;
  zone: RoomZone | null;
  area_m2: number | null;
};

type RepairPatch = {
  room_updates: RoomUpdate[];
  link_updates: SemanticLink[];
  link_removals: Array<{ from: string; to: string }>;
};

const ROOM_PROGRAM_SCHEMA = {
  type: "object",
  properties: {
    grid_unit_m: { type: "number", minimum: 0.1, maximum: 2 },
    entrance_room: { type: "string", minLength: 1 },
    rooms: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          area_m2: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          zone: { type: "string", enum: ["front", "core", "private", "service"] },
        },
        required: ["id", "type", "area_m2", "zone"],
        additionalProperties: false,
      },
    },
  },
  required: ["grid_unit_m", "entrance_room", "rooms"],
  additionalProperties: false,
} as const;

const LINKS_SCHEMA = {
  type: "object",
  properties: {
    links: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          connection: { type: "string", enum: ["door", "open", "arch"] },
        },
        required: ["from", "to", "connection"],
        additionalProperties: false,
      },
    },
  },
  required: ["links"],
  additionalProperties: false,
} as const;

const WINDOWS_SCHEMA = {
  type: "object",
  properties: {
    windows: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          room_id: { type: "string", minLength: 1 },
          count: { type: "integer", minimum: 0, maximum: 12 },
        },
        required: ["room_id", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["windows"],
  additionalProperties: false,
} as const;

const REPAIR_PATCH_SCHEMA = {
  type: "object",
  properties: {
    room_updates: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          zone: {
            type: ["string", "null"],
            enum: ["front", "core", "private", "service", null],
          },
          area_m2: {
            type: ["number", "null"],
            exclusiveMinimum: 0,
            maximum: 1000,
          },
        },
        required: ["id", "zone", "area_m2"],
        additionalProperties: false,
      },
    },
    link_updates: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          connection: { type: "string", enum: ["door", "open", "arch"] },
        },
        required: ["from", "to", "connection"],
        additionalProperties: false,
      },
    },
    link_removals: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["room_updates", "link_updates", "link_removals"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function fail(stage: string, message: string): never {
  const error = new Error(`Invalid ${stage}: ${message}.`);
  console.error(`[Floor plan ${stage}]`, error);
  throw error;
}

function parseJson(text: string, stage: string): unknown {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return JSON.parse(cleaned) as unknown;
  } catch (cause) {
    const error = new Error(`The AI returned invalid JSON for ${stage}.`);
    console.error(`[Floor plan ${stage}]`, error, cause);
    throw error;
  }
}

function validateRoomProgram(value: unknown): RoomProgram {
  const stage = "room program";
  if (!isRecord(value) || !hasOnlyKeys(value, ["grid_unit_m", "entrance_room", "rooms"])) {
    return fail(stage, "expected only grid_unit_m, entrance_room, and rooms");
  }
  if (
    typeof value.grid_unit_m !== "number" ||
    !Number.isFinite(value.grid_unit_m) ||
    value.grid_unit_m < 0.1 ||
    value.grid_unit_m > 2
  ) {
    return fail(stage, "grid_unit_m must be between 0.1 and 2 meters");
  }
  if (
    typeof value.entrance_room !== "string" ||
    !value.entrance_room.trim() ||
    value.entrance_room !== value.entrance_room.trim()
  ) {
    return fail(stage, "entrance_room must be a non-empty room id");
  }
  if (!Array.isArray(value.rooms) || value.rooms.length === 0 || value.rooms.length > 32) {
    return fail(stage, "rooms must contain between 1 and 32 entries");
  }

  const ids = new Set<string>();
  const rooms = value.rooms.map((entry, index): ProgramRoom => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "type", "area_m2", "zone"])) {
      return fail(stage, `room ${index + 1} must contain only id, type, area_m2, and zone`);
    }
    if (
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      entry.id !== entry.id.trim() ||
      typeof entry.type !== "string" ||
      !entry.type.trim()
    ) {
      return fail(stage, `room ${index + 1} needs non-empty id and type values`);
    }
    if (ids.has(entry.id)) return fail(stage, `room id "${entry.id}" is duplicated`);
    ids.add(entry.id);
    if (
      typeof entry.area_m2 !== "number" ||
      !Number.isFinite(entry.area_m2) ||
      entry.area_m2 <= 0 ||
      entry.area_m2 > 1000
    ) {
      return fail(stage, `room "${entry.id}" area_m2 must be positive and at most 1000`);
    }
    if (
      entry.zone !== "front" &&
      entry.zone !== "core" &&
      entry.zone !== "private" &&
      entry.zone !== "service"
    ) {
      return fail(stage, `room "${entry.id}" has an unsupported zone`);
    }
    return {
      id: entry.id,
      type: entry.type,
      area_m2: entry.area_m2,
      zone: entry.zone,
    };
  });
  if (!ids.has(value.entrance_room)) {
    return fail(stage, `entrance_room "${value.entrance_room}" does not exist`);
  }
  return {
    grid_unit_m: value.grid_unit_m,
    entrance_room: value.entrance_room,
    rooms,
  };
}

function validateLinks(value: unknown, program: RoomProgram): SemanticLink[] {
  const stage = "circulation links";
  if (!isRecord(value) || !hasOnlyKeys(value, ["links"]) || !Array.isArray(value.links)) {
    return fail(stage, "expected an object containing only a links array");
  }
  if (value.links.length > 128) return fail(stage, "links cannot exceed 128 entries");
  const ids = new Set(program.rooms.map((room) => room.id));
  const pairs = new Set<string>();
  const links = value.links.map((entry, index): SemanticLink => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["from", "to", "connection"]) ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string" ||
      !ids.has(entry.from) ||
      !ids.has(entry.to)
    ) {
      return fail(stage, `link ${index + 1} references an unknown room id or has extra fields`);
    }
    if (entry.from === entry.to) {
      return fail(stage, `link ${index + 1} connects a room to itself`);
    }
    if (
      entry.connection !== "door" &&
      entry.connection !== "open" &&
      entry.connection !== "arch"
    ) {
      return fail(stage, `link ${index + 1} has an unsupported connection`);
    }
    const key = [entry.from, entry.to].sort().join("\u0000");
    if (pairs.has(key)) return fail(stage, `link ${index + 1} duplicates a room connection`);
    pairs.add(key);
    return {
      from: entry.from,
      to: entry.to,
      connection: entry.connection,
    };
  });

  // Reuse the shared semantic validator for the connectivity invariant.
  validateSemanticFloorPlan({
    grid_unit_m: program.grid_unit_m,
    entrance_room: program.entrance_room,
    rooms: program.rooms.map((room) => ({ ...room, windows: 0 })),
    links,
  });
  return links;
}

function validateWindowAssignments(value: unknown, program: RoomProgram) {
  const stage = "window assignments";
  if (!isRecord(value) || !hasOnlyKeys(value, ["windows"]) || !Array.isArray(value.windows)) {
    return fail(stage, "expected an object containing only a windows array");
  }
  if (value.windows.length !== program.rooms.length) {
    return fail(stage, `expected one window count for each of the ${program.rooms.length} rooms`);
  }
  const validIds = new Set(program.rooms.map((room) => room.id));
  const assignments = new Map<string, number>();
  value.windows.forEach((entry, index) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["room_id", "count"]) ||
      typeof entry.room_id !== "string" ||
      !validIds.has(entry.room_id)
    ) {
      return fail(stage, `window entry ${index + 1} references an unknown room or has extra fields`);
    }
    if (
      typeof entry.count !== "number" ||
      !Number.isInteger(entry.count) ||
      entry.count < 0 ||
      entry.count > 12
    ) {
      return fail(stage, `window entry ${index + 1} count must be an integer from 0 to 12`);
    }
    if (assignments.has(entry.room_id)) {
      return fail(stage, `room "${entry.room_id}" has duplicate window assignments`);
    }
    assignments.set(entry.room_id, entry.count);
  });
  return program.rooms.map((room) => {
    const count = assignments.get(room.id);
    if (count === undefined) return fail(stage, `room "${room.id}" has no window assignment`);
    return { ...room, windows: count };
  });
}

function assembleSemanticPlan(
  program: RoomProgram,
  links: SemanticLink[],
  rooms: SemanticRoom[],
): SemanticFloorPlan {
  return validateSemanticFloorPlan({
    grid_unit_m: program.grid_unit_m,
    entrance_room: program.entrance_room,
    rooms,
    links,
  });
}

function roomIsEntryLike(room: Record<string, unknown>) {
  return (
    typeof room.id === "string" &&
    /entrance|entry|foyer|living|hall/i.test(
      `${room.id} ${typeof room.type === "string" ? room.type : ""}`,
    )
  );
}

function parseMergedPlanWithEntranceFallback(
  text: string,
): { plan: SemanticFloorPlan; warnings: string[] } {
  const value = parseJson(text, "pasted floor plan");
  if (!isRecord(value) || !Array.isArray(value.rooms)) {
    return { plan: validateSemanticFloorPlan(value), warnings: [] };
  }
  const roomRecords = value.rooms.filter(isRecord);
  const roomIds = roomRecords
    .map((room) => room.id)
    .filter((id): id is string => typeof id === "string");
  if (typeof value.entrance_room === "string" && roomIds.includes(value.entrance_room)) {
    return { plan: validateSemanticFloorPlan(value), warnings: [] };
  }

  const preferredRoom =
    roomRecords.find((room) => room.zone === "front" && roomIsEntryLike(room)) ??
    roomRecords.find((room) => room.zone === "front") ??
    roomRecords.find(roomIsEntryLike) ??
    roomRecords[0];
  if (typeof preferredRoom?.id !== "string") {
    return { plan: validateSemanticFloorPlan(value), warnings: [] };
  }
  const warning =
    `Pasted JSON selected nonexistent entrance_room "${String(value.entrance_room)}"; ` +
    `using existing room "${preferredRoom.id}" instead.`;
  console.warn(`[Floor plan paste] ${warning}`);
  return {
    plan: validateSemanticFloorPlan({
      ...value,
      entrance_room: preferredRoom.id,
    }),
    warnings: [warning],
  };
}

function validateRepairPatch(value: unknown, plan: SemanticFloorPlan): RepairPatch {
  const stage = "layout repair patch";
  const patchKeys = ["room_updates", "link_updates", "link_removals"];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, patchKeys) ||
    !Array.isArray(value.room_updates) ||
    !Array.isArray(value.link_updates) ||
    !Array.isArray(value.link_removals)
  ) {
    return fail(stage, "expected room_updates, link_updates, and link_removals arrays only");
  }
  if (
    value.room_updates.length > 32 ||
    value.link_updates.length > 128 ||
    value.link_removals.length > 128
  ) {
    return fail(stage, "patch exceeds allowed item counts");
  }

  const roomIds = new Set(plan.rooms.map((room) => room.id));
  const updatedRooms = new Set<string>();
  const roomUpdates = value.room_updates.map((entry, index): RoomUpdate => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["id", "zone", "area_m2"]) ||
      typeof entry.id !== "string" ||
      !roomIds.has(entry.id)
    ) {
      return fail(stage, `room update ${index + 1} references an unknown room or has extra fields`);
    }
    if (updatedRooms.has(entry.id)) {
      return fail(stage, `room "${entry.id}" is updated more than once`);
    }
    updatedRooms.add(entry.id);
    const zone =
      entry.zone === null ||
      entry.zone === "front" ||
      entry.zone === "core" ||
      entry.zone === "private" ||
      entry.zone === "service"
        ? entry.zone
        : undefined;
    const area =
      entry.area_m2 === null ||
      (typeof entry.area_m2 === "number" &&
        Number.isFinite(entry.area_m2) &&
        entry.area_m2 > 0 &&
        entry.area_m2 <= 1000)
        ? entry.area_m2
        : undefined;
    if (zone === undefined || area === undefined || (zone === null && area === null)) {
      return fail(stage, `room update ${index + 1} has invalid or empty zone/area fields`);
    }
    return { id: entry.id, zone, area_m2: area };
  });

  const parsePatchLink = (entry: unknown, index: number, withConnection: boolean) => {
    const allowed = withConnection ? ["from", "to", "connection"] : ["from", "to"];
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, allowed) ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string" ||
      !roomIds.has(entry.from) ||
      !roomIds.has(entry.to) ||
      entry.from === entry.to
    ) {
      return fail(stage, `link patch ${index + 1} has invalid room references`);
    }
    if (
      withConnection &&
      entry.connection !== "door" &&
      entry.connection !== "open" &&
      entry.connection !== "arch"
    ) {
      return fail(stage, `link patch ${index + 1} has an unsupported connection`);
    }
    return withConnection
      ? ({
          from: entry.from,
          to: entry.to,
          connection: entry.connection as RoomConnection,
        } satisfies SemanticLink)
      : { from: entry.from, to: entry.to };
  };
  const linkUpdates = value.link_updates.map((entry, index) =>
    parsePatchLink(entry, index, true) as SemanticLink,
  );
  const linkRemovals = value.link_removals.map((entry, index) =>
    parsePatchLink(entry, index, false) as { from: string; to: string },
  );
  return { room_updates: roomUpdates, link_updates: linkUpdates, link_removals: linkRemovals };
}

function applyRepairPatch(plan: SemanticFloorPlan, patch: RepairPatch) {
  const rooms = plan.rooms.map((room) => {
    const update = patch.room_updates.find((candidate) => candidate.id === room.id);
    return update
      ? {
          ...room,
          ...(update.zone !== null ? { zone: update.zone } : {}),
          ...(update.area_m2 !== null ? { area_m2: update.area_m2 } : {}),
        }
      : room;
  });
  const pairKey = (from: string, to: string) => [from, to].sort().join("\u0000");
  const removedPairs = new Set(
    patch.link_removals.map((link) => pairKey(link.from, link.to)),
  );
  const links = plan.links.filter(
    (link) => !removedPairs.has(pairKey(link.from, link.to)),
  );
  for (const update of patch.link_updates) {
    const existingIndex = links.findIndex(
      (link) => pairKey(link.from, link.to) === pairKey(update.from, update.to),
    );
    if (existingIndex >= 0) links[existingIndex] = update;
    else links.push(update);
  }
  return validateSemanticFloorPlan({
    grid_unit_m: plan.grid_unit_m,
    entrance_room: plan.entrance_room,
    rooms,
    links,
  });
}

function diagnosticRoomContext(
  plan: SemanticFloorPlan,
  diagnostics: LayoutDiagnostic[],
) {
  const affectedIds = new Set(diagnostics.flatMap((diagnostic) => diagnostic.roomIds));
  return {
    rooms: plan.rooms
      .filter((room) => affectedIds.has(room.id))
      .map(({ id, type, area_m2, zone }) => ({ id, type, area_m2, zone })),
    links: plan.links.filter(
      (link) => affectedIds.has(link.from) || affectedIds.has(link.to),
    ),
  };
}

function logDiagnostics(diagnostics: LayoutDiagnostic[]) {
  for (const diagnostic of diagnostics) {
    console.warn(`[Floor plan critique:${diagnostic.code}] ${diagnostic.message}`);
  }
}

function makeGeneratedPlan(
  solved: SolvedFloorPlan,
  warnings: string[] = [],
): GeneratedFloorPlan {
  return {
    name: "AI Generated Floor Plan",
    rooms: solved.rooms,
    walls: solved.walls,
    openings: solved.openings,
    warnings: [...solved.warnings, ...warnings],
  };
}

function solveWithoutRepair(plan: SemanticFloorPlan, warnings: string[] = []) {
  const solved = solveFloorPlanLayout(plan);
  const diagnostics = critiqueFloorPlanLayout(plan, solved);
  logDiagnostics(diagnostics);
  return makeGeneratedPlan(solved, [
    ...warnings,
    ...diagnostics.map((diagnostic) => diagnostic.message),
  ]);
}

async function solveWithBoundedRepair(
  initialPlan: SemanticFloorPlan,
  options: StreamOptions,
): Promise<GeneratedFloorPlan> {
  let plan = initialPlan;
  let solved = solveFloorPlanLayout(plan);
  let diagnostics = critiqueFloorPlanLayout(plan, solved);
  const repairWarnings: string[] = [];

  for (let retry = 1; diagnostics.length > 0 && retry <= 2; retry += 1) {
    logDiagnostics(diagnostics);
    options.onChunk?.(`\n[Layout critique: repair ${retry}/2]\n`);
    const repairPrompt = [
      `Repair iteration ${retry} of 2. Return a minimal JSON patch matching the supplied schema.`,
      "Only address the listed geometry issues. Do not repeat the full room program.",
      "Use room_updates to change only zone and/or area_m2 (use null for unchanged fields).",
      "Use link_updates to add or change a connection; link_removals only when a link itself prevents a valid adjacency.",
      "Keep the room-link graph connected. Use only IDs in the supplied context. If no safe change applies, return empty arrays.",
      `Affected room and link context: ${JSON.stringify(diagnosticRoomContext(plan, diagnostics))}`,
      `Specific geometry issues: ${JSON.stringify(diagnostics)}`,
    ].join("\n");
    try {
      const patchValue = await generateStructuredPass(
        repairPrompt,
        REPAIR_PATCH_SCHEMA,
        (value) => validateRepairPatch(value, plan),
        options,
        `layout-repair-${retry}`,
        600,
      );
      plan = applyRepairPatch(plan, patchValue);
      solved = solveFloorPlanLayout(plan);
      diagnostics = critiqueFloorPlanLayout(plan, solved);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      console.error(`[Floor plan repair ${retry}]`, error);
      repairWarnings.push(
        `Layout repair ${retry} could not be applied: ${
          error instanceof Error ? error.message : "invalid repair response"
        }`,
      );
      break;
    }
  }

  logDiagnostics(diagnostics);
  return makeGeneratedPlan(solved, [
    ...diagnostics.map((diagnostic) => diagnostic.message),
    ...repairWarnings,
  ]);
}

function buildRoomProgramPrompt(request: string) {
  return [
    "Pass 1/3 — define the room program only. Return one JSON object matching the supplied schema.",
    "Do not output links, windows, coordinates, walls, or extra properties.",
    "Use square meters. Use grid_unit_m 0.5 unless the user specifies another metric grid.",
    "Use unique short room IDs, positive practical target areas, and only front/core/private/service zones.",
    "entrance_room must exactly match an id in rooms. Prefer a front-zone living room, foyer, or entry.",
    `User request: ${request}`,
  ].join("\n");
}

function buildLinksPrompt(request: string, program: RoomProgram) {
  return [
    "Pass 2/3 — add only room-to-room circulation links for the locked room list below.",
    "Return one JSON object with a links array only. Include every room in one connected graph, avoid self-links and duplicate pairs, and use door/open/arch connections.",
    `User request: ${request}`,
    `Locked rooms: ${JSON.stringify(program.rooms.map(({ id, type, zone }) => ({ id, type, zone })))}`,
    `Entrance room: ${program.entrance_room}`,
  ].join("\n");
}

function buildWindowsPrompt(
  request: string,
  program: RoomProgram,
  links: SemanticLink[],
) {
  return [
    "Pass 3/3 — assign exterior window counts only.",
    "Return one JSON object containing a windows array with exactly one {room_id,count} entry per listed room. Use a non-negative integer count. Use 0 for interior-only bathrooms, closets, and utility rooms.",
    "Do not change rooms or links.",
    `User request: ${request}`,
    `Rooms: ${JSON.stringify(program.rooms.map(({ id, type, zone }) => ({ id, type, zone })))}`,
    `Links: ${JSON.stringify(links)}`,
  ].join("\n");
}

async function generateStructuredPass<T>(
  prompt: string,
  schema: unknown,
  validate: (value: unknown) => T,
  options: StreamOptions,
  operation: string,
  numPredict: number,
) {
  let currentPrompt = prompt;
  let previousOutput = "";
  let previousError = "No valid response was returned.";
  let attempt = 0;
  let batch = 1;

  while (true) {
    attempt += 1;
    options.onChunk?.(`\n[${operation}: attempt ${attempt}/5]\n`);
    let output = "";
    try {
      output = await generateLocalJson(
        currentPrompt,
        {
          ...options,
          numPredict,
          operation: `floorplan-${operation}`,
        },
        schema,
      );
      previousOutput = output;
      return validate(parseJson(output, operation));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      console.error(
        `[Floor plan ${operation}] Attempt ${attempt}/5 failed.`,
        error,
      );
      previousError =
        error instanceof Error ? error.message : "Unknown structured-output error.";
      if (attempt < 5) {
        currentPrompt = buildCorrectionPrompt(
          prompt,
          output || previousOutput,
          previousError,
          operation,
        );
        continue;
      }

      const shouldContinue = await options.onRetryLimit?.({
        stage: operation,
        attempts: attempt,
        batch,
        error: previousError,
      });
      if (!shouldContinue) {
        throw new Error(
          `Stopped after ${attempt} failed attempts for ${operation}. ${previousError}`,
        );
      }

      batch += 1;
      attempt = 0;
      options.onChunk?.(`\n[Continuing ${operation}, retry batch ${batch}]\n`);
      currentPrompt = buildCorrectionPrompt(
        prompt,
        previousOutput,
        previousError,
        operation,
      );
    }
  }
}

function buildCorrectionPrompt(
  originalPrompt: string,
  existingOutput: string,
  error: string,
  stage: string,
) {
  return [
    originalPrompt,
    "",
    `CORRECTION REQUIRED for ${stage}: Fix the existing output; do not ignore the validation error or start a different design.`,
    `Validation/runtime error: ${error}`,
    `Existing output to repair: ${existingOutput || "(no output was returned)"}`,
    "Preserve all valid values. Correct only what is necessary, then return the complete JSON object matching the supplied schema.",
  ].join("\n");
}

async function generatePlan(
  request: string,
  options: StreamOptions,
): Promise<GeneratedFloorPlan> {
  const roomProgram = await generateStructuredPass(
    buildRoomProgramPrompt(request),
    ROOM_PROGRAM_SCHEMA,
    validateRoomProgram,
    options,
    "pass-1-room-program",
    900,
  );
  options.onChunk?.("\n[Room program validated.]\n");

  const links = await generateStructuredPass(
    buildLinksPrompt(request, roomProgram),
    LINKS_SCHEMA,
    (value) => validateLinks(value, roomProgram),
    options,
    "pass-2-circulation",
    700,
  );
  options.onChunk?.("\n[Connected room graph validated.]\n");

  const rooms = await generateStructuredPass(
    buildWindowsPrompt(request, roomProgram, links),
    WINDOWS_SCHEMA,
    (value) => validateWindowAssignments(value, roomProgram),
    options,
    "pass-3-windows",
    700,
  );
  options.onChunk?.("\n[Window assignments validated.]\n");

  const semanticPlan = assembleSemanticPlan(roomProgram, links, rooms);
  return solveWithBoundedRepair(semanticPlan, options);
}

export function parseGeneratedFloorPlan(text: string): GeneratedFloorPlan {
  try {
    const plan = validateSemanticFloorPlan(parseJson(text, "semantic floor plan"));
    return solveWithoutRepair(plan);
  } catch (error) {
    console.error("[Floor plan parsing]", error);
    throw error;
  }
}

export function parsePastedFloorPlan(text: string): GeneratedFloorPlan {
  try {
    const parsed = parseMergedPlanWithEntranceFallback(text);
    return solveWithoutRepair(parsed.plan, parsed.warnings);
  } catch (error) {
    console.error("[Floor plan paste]", error);
    throw error;
  }
}

export async function generateFloorPlanFromPrompt(
  request: string,
  options: StreamOptions = {},
): Promise<GeneratedFloorPlan> {
  try {
    const trimmedRequest = request.trim();
    if (!trimmedRequest) {
      throw new Error("Describe the rooms and dimensions you want first.");
    }
    if (trimmedRequest.length > 1200) {
      throw new Error("Keep the floor-plan description under 1,200 characters.");
    }
    return await generatePlan(trimmedRequest, {
      ...options,
      numContext: options.numContext ?? 8192,
      timeoutMs: options.timeoutMs ?? 300_000,
    });
  } catch (error) {
    console.error("[Floor plan generation]", error);
    throw error;
  }
}
