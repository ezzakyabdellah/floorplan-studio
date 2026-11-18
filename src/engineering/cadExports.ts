import {
  buildLadder3DLayout,
  buildSpiralStringerPath,
  buildStair3DLayout,
  type Point3,
} from "./stair3d";
import type { ProjectState } from "./types";

type Vec3 = [number, number, number];
type Triangle = [Vec3, Vec3, Vec3];

function nativePerFoot(project: ProjectState) {
  return project.units === "imperial" ? 12 : 304.8;
}

function dxfLine(
  layer: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  return [
    "0", "LINE", "8", layer,
    "10", String(Number(x1.toFixed(4))),
    "20", String(Number(y1.toFixed(4))),
    "30", "0",
    "11", String(Number(x2.toFixed(4))),
    "21", String(Number(y2.toFixed(4))),
    "31", "0",
  ].join("\n");
}

function dxfArc(layer: string, radius: number, startDegrees: number, endDegrees: number) {
  return [
    "0", "ARC", "8", layer,
    "10", "0", "20", "0", "30", "0",
    "40", String(Number(radius.toFixed(4))),
    "50", String(Number(startDegrees.toFixed(4))),
    "51", String(Number(endDegrees.toFixed(4))),
  ].join("\n");
}

function dxfArcSegments(layer: string, radius: number, start: number, end: number) {
  const degreesPerRadian = 180 / Math.PI;
  const startDegrees = start * degreesPerRadian;
  const spanDegrees = (end - start) * degreesPerRadian;
  const normalizedStart = ((startDegrees % 360) + 360) % 360;
  const normalizedEnd = normalizedStart + spanDegrees;
  if (normalizedEnd <= 360) {
    return [dxfArc(layer, radius, normalizedStart, normalizedEnd)];
  }
  return [
    dxfArc(layer, radius, normalizedStart, 360),
    dxfArc(layer, radius, 0, normalizedEnd - 360),
  ];
}

function dxfText(layer: string, x: number, y: number, value: string) {
  return [
    "0", "TEXT", "8", layer,
    "10", String(Number(x.toFixed(4))),
    "20", String(Number(y.toFixed(4))),
    "30", "0", "40", "6",
    "1", value.replace(/[^\x20-\x7e]/g, " "),
  ].join("\n");
}

/** Deterministic ASCII DXF with plan and elevation geometry in project units. */
export function buildDxf(project: ProjectState): string {
  const entities: string[] = [];
  const scale = nativePerFoot(project);
  const labelUnit = project.units === "imperial" ? "in" : "mm";

  if (project.projectType === "staircase") {
    const layout = buildStair3DLayout(project);
    const planOffsetY =
      (layout.bounds.maxZ - layout.bounds.minZ) * scale + scale * 2;
    if (layout.style === "spiral") {
      for (const tread of layout.spiralTreads) {
        entities.push(
          ...dxfArcSegments(
            "TREADS",
            tread.innerRadius * scale,
            tread.startAngle,
            tread.endAngle,
          ),
          ...dxfArcSegments(
            "TREADS",
            tread.outerRadius * scale,
            tread.startAngle,
            tread.endAngle,
          ),
        );
        const innerStart = {
          x: tread.innerRadius * Math.cos(tread.startAngle) * scale,
          y: tread.innerRadius * Math.sin(tread.startAngle) * scale,
        };
        const outerStart = {
          x: tread.outerRadius * Math.cos(tread.startAngle) * scale,
          y: tread.outerRadius * Math.sin(tread.startAngle) * scale,
        };
        const innerEnd = {
          x: tread.innerRadius * Math.cos(tread.endAngle) * scale,
          y: tread.innerRadius * Math.sin(tread.endAngle) * scale,
        };
        const outerEnd = {
          x: tread.outerRadius * Math.cos(tread.endAngle) * scale,
          y: tread.outerRadius * Math.sin(tread.endAngle) * scale,
        };
        entities.push(
          dxfLine("TREADS", innerStart.x, innerStart.y, outerStart.x, outerStart.y),
          dxfLine("TREADS", innerEnd.x, innerEnd.y, outerEnd.x, outerEnd.y),
        );
      }
    } else {
      for (const flight of layout.flights) {
        const direction = flight.direction;
        const across = { x: -direction.z, z: direction.x };
        const start = { x: flight.start.x, z: flight.start.z };
        const end = {
          x: flight.start.x + direction.x * flight.run,
          z: flight.start.z + direction.z * flight.run,
        };
        const corners = [
          { x: start.x - across.x * flight.width / 2, z: start.z - across.z * flight.width / 2 },
          { x: start.x + across.x * flight.width / 2, z: start.z + across.z * flight.width / 2 },
          { x: end.x + across.x * flight.width / 2, z: end.z + across.z * flight.width / 2 },
          { x: end.x - across.x * flight.width / 2, z: end.z - across.z * flight.width / 2 },
        ].map((point) => ({ x: point.x * scale, y: point.z * scale }));
        corners.forEach((point, index) => {
          const next = corners[(index + 1) % corners.length];
          entities.push(dxfLine("PLAN", point.x, point.y, next.x, next.y));
        });
        for (let index = 1; index < flight.treadCount; index += 1) {
          const progress = index / flight.treadCount;
          const center = {
            x: (start.x + direction.x * flight.run * progress) * scale,
            y: (start.z + direction.z * flight.run * progress) * scale,
          };
          const half = (flight.width * scale) / 2;
          entities.push(
            dxfLine(
              "TREADS",
              center.x - across.x * half,
              center.y - across.z * half,
              center.x + across.x * half,
              center.y + across.z * half,
            ),
          );
        }
      }
      for (const landing of layout.landings) {
        const left = (landing.center.x - landing.length / 2) * scale;
        const right = (landing.center.x + landing.length / 2) * scale;
        const bottom = (landing.center.z - landing.width / 2) * scale;
        const top = (landing.center.z + landing.width / 2) * scale;
        entities.push(
          dxfLine("LANDING", left, bottom, right, bottom),
          dxfLine("LANDING", right, bottom, right, top),
          dxfLine("LANDING", right, top, left, top),
          dxfLine("LANDING", left, top, left, bottom),
        );
      }
    }

    const rise = project.stairParams.totalRise;
    const run =
      layout.style === "spiral"
        ? project.calculatedMetrics.totalWalkingRun
        : project.stairParams.totalRun;
    const stepCount = Math.max(1, project.calculatedMetrics.stepCount);
    const treadCount = Math.max(1, project.calculatedMetrics.treadCount);
    let x = 0;
    let y = -planOffsetY;
    const stepRun = run / treadCount;
    const stepRise = rise / stepCount;
    for (let index = 0; index < treadCount; index += 1) {
      const nextX = x + stepRun;
      entities.push(
        dxfLine("ELEVATION", x, y, nextX, y),
        dxfLine("ELEVATION", nextX, y, nextX, y + stepRise),
      );
      x = nextX;
      y += stepRise;
    }
    entities.push(
      dxfText("NOTES", 0, -planOffsetY - rise - scale, `STAIR ${layout.style} | ${labelUnit}`),
    );
  } else {
    const layout = buildLadder3DLayout(project);
    for (const rail of layout.rails) {
      entities.push(
        dxfLine(
          "RAILS",
          rail.start.x * scale,
          rail.start.y * scale,
          rail.end.x * scale,
          rail.end.y * scale,
        ),
      );
    }
    for (const rung of layout.rungs) {
      entities.push(
        dxfLine(
          "RUNGS",
          rung.start.x * scale,
          rung.start.y * scale,
          rung.end.x * scale,
          rung.end.y * scale,
        ),
      );
    }
    entities.push(
      dxfText("NOTES", 0, -scale, `LADDER ${project.ladderParams.ladderType} | ${labelUnit}`),
    );
  }

  const layers = ["0", "PLAN", "TREADS", "LANDING", "ELEVATION", "RAILS", "RUNGS", "NOTES"];
  const layerTable = [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER", "70", String(layers.length),
    ...layers.flatMap((layer) => [
      "0", "LAYER", "2", layer, "70", "0", "62", layer === "0" ? "7" : "4", "6", "CONTINUOUS",
    ]),
    "0", "ENDTAB", "0", "ENDSEC",
  ].join("\n");
  return [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1015",
    "9", "$INSUNITS", "70", project.units === "imperial" ? "1" : "4",
    "0", "ENDSEC",
    layerTable,
    "0", "SECTION", "2", "ENTITIES",
    ...entities,
    "0", "ENDSEC",
    "0", "EOF",
  ].join("\n");
}

function addQuad(triangles: Triangle[], a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
  triangles.push([a, b, c], [a, c, d]);
}

function addOrientedBox(
  triangles: Triangle[],
  center: Vec3,
  axis: [number, number, number],
  along: number,
  across: number,
  vertical: number,
) {
  const length = Math.hypot(...axis) || 1;
  const ux = axis[0] / length;
  const uz = axis[2] / length;
  const vx = -uz;
  const vz = ux;
  const make = (a: number, b: number, y: number): Vec3 => [
    center[0] + ux * a + vx * b,
    center[1] + y,
    center[2] + uz * a + vz * b,
  ];
  const a = make(-along / 2, -across / 2, -vertical / 2);
  const b = make(along / 2, -across / 2, -vertical / 2);
  const c = make(along / 2, across / 2, -vertical / 2);
  const d = make(-along / 2, across / 2, -vertical / 2);
  const e = make(-along / 2, -across / 2, vertical / 2);
  const f = make(along / 2, -across / 2, vertical / 2);
  const g = make(along / 2, across / 2, vertical / 2);
  const h = make(-along / 2, across / 2, vertical / 2);
  addQuad(triangles, a, b, c, d);
  addQuad(triangles, e, h, g, f);
  addQuad(triangles, a, e, f, b);
  addQuad(triangles, b, f, g, c);
  addQuad(triangles, c, g, h, d);
  addQuad(triangles, d, h, e, a);
}

function addBeam(
  triangles: Triangle[],
  start: Point3,
  end: Point3,
  radius: number,
  scale: number,
) {
  const a: Vec3 = [start.x * scale, start.y * scale, start.z * scale];
  const b: Vec3 = [end.x * scale, end.y * scale, end.z * scale];
  const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...delta) || 1;
  const u: Vec3 = [delta[0] / length, delta[1] / length, delta[2] / length];
  const reference: Vec3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross: Vec3 = [
    u[1] * reference[2] - u[2] * reference[1],
    u[2] * reference[0] - u[0] * reference[2],
    u[0] * reference[1] - u[1] * reference[0],
  ];
  const crossLength = Math.hypot(...cross) || 1;
  const v = cross.map((value) => (value / crossLength) * radius * scale) as Vec3;
  const w: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const corners = (point: Vec3) => [
    [point[0] + v[0] + w[0], point[1] + v[1] + w[1], point[2] + v[2] + w[2]] as Vec3,
    [point[0] - v[0] + w[0], point[1] - v[1] + w[1], point[2] - v[2] + w[2]] as Vec3,
    [point[0] - v[0] - w[0], point[1] - v[1] - w[1], point[2] - v[2] - w[2]] as Vec3,
    [point[0] + v[0] - w[0], point[1] + v[1] - w[1], point[2] + v[2] - w[2]] as Vec3,
  ];
  const startCorners = corners(a);
  const endCorners = corners(b);
  addQuad(triangles, startCorners[3], startCorners[2], startCorners[1], startCorners[0]);
  addQuad(triangles, endCorners[0], endCorners[1], endCorners[2], endCorners[3]);
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    addQuad(triangles, startCorners[index], startCorners[next], endCorners[next], endCorners[index]);
  }
}

function addVerticalCylinder(
  triangles: Triangle[],
  centerX: number,
  centerZ: number,
  height: number,
  radius: number,
  segments = 20,
) {
  const bottomY = 0;
  const topY = height;
  const bottomCenter: Vec3 = [centerX, bottomY, centerZ];
  const topCenter: Vec3 = [centerX, topY, centerZ];
  for (let index = 0; index < segments; index += 1) {
    const a0 = (Math.PI * 2 * index) / segments;
    const a1 = (Math.PI * 2 * (index + 1)) / segments;
    const b0: Vec3 = [centerX + radius * Math.cos(a0), bottomY, centerZ + radius * Math.sin(a0)];
    const b1: Vec3 = [centerX + radius * Math.cos(a1), bottomY, centerZ + radius * Math.sin(a1)];
    const t0: Vec3 = [b0[0], topY, b0[2]];
    const t1: Vec3 = [b1[0], topY, b1[2]];
    addQuad(triangles, b0, t0, t1, b1);
    triangles.push([bottomCenter, b0, b1], [topCenter, t1, t0]);
  }
}

function addSpiralTread(
  triangles: Triangle[],
  tread: {
    innerRadius: number;
    outerRadius: number;
    startAngle: number;
    endAngle: number;
    elevation: number;
  },
  thickness: number,
  scale: number,
) {
  const pieces = Math.max(2, Math.ceil((tread.endAngle - tread.startAngle) / (Math.PI / 18)));
  const bottom = (tread.elevation * scale) - thickness * scale;
  const top = tread.elevation * scale;
  for (let index = 0; index < pieces; index += 1) {
    const a0 = tread.startAngle + ((tread.endAngle - tread.startAngle) * index) / pieces;
    const a1 = tread.startAngle + ((tread.endAngle - tread.startAngle) * (index + 1)) / pieces;
    const inner = tread.innerRadius * scale;
    const outer = tread.outerRadius * scale;
    const point = (radius: number, angle: number, y: number): Vec3 => [
      radius * Math.cos(angle), y, radius * Math.sin(angle),
    ];
    const it0 = point(inner, a0, top);
    const ot0 = point(outer, a0, top);
    const ot1 = point(outer, a1, top);
    const it1 = point(inner, a1, top);
    const ib0 = point(inner, a0, bottom);
    const ob0 = point(outer, a0, bottom);
    const ob1 = point(outer, a1, bottom);
    const ib1 = point(inner, a1, bottom);
    addQuad(triangles, it1, ot1, ot0, it0);
    addQuad(triangles, ib0, ob0, ob1, ib1);
    addQuad(triangles, ib1, it1, it0, ib0);
    addQuad(triangles, ob0, ot0, ot1, ob1);
    if (index === 0) addQuad(triangles, ib0, it0, ot0, ob0);
    if (index === pieces - 1) addQuad(triangles, ib1, ob1, ot1, it1);
  }
}

function normal(triangle: Triangle): Vec3 {
  const [a, b, c] = triangle;
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...n) || 1;
  return [n[0] / length, n[1] / length, n[2] / length];
}

/** ASCII STL in the project's native unit (STL itself does not encode units). */
export function buildStl(project: ProjectState): string {
  const triangles: Triangle[] = [];
  const scale = nativePerFoot(project);
  const thickness = project.stairParams.treadThickness;
  if (project.projectType === "ladder") {
    const layout = buildLadder3DLayout(project);
    [...layout.rails, ...layout.rungs].forEach((beam) =>
      addBeam(triangles, beam.start, beam.end, beam.radius, scale),
    );
  } else {
    const layout = buildStair3DLayout(project);
    if (layout.style === "spiral") {
      layout.spiralTreads.forEach((tread) =>
        addSpiralTread(triangles, tread, thickness, scale),
      );
      addVerticalCylinder(
        triangles,
        0,
        0,
        layout.totalRise * scale,
        0.16 * scale,
      );
      for (const radialOffset of [-layout.width / 2, layout.width / 2]) {
        const stringerPath = buildSpiralStringerPath(layout, radialOffset);
        for (let index = 0; index < stringerPath.length - 1; index += 1) {
          addBeam(
            triangles,
            stringerPath[index],
            stringerPath[index + 1],
            0.08,
            scale,
          );
        }
      }
    } else {
      for (const flight of layout.flights) {
        const depth = flight.run / Math.max(1, flight.treadCount);
        const risePerRiser = flight.rise / Math.max(1, flight.riserCount);
        for (let index = 0; index < flight.treadCount; index += 1) {
          const riseProgress = Math.min(1, (index + 1) / flight.riserCount);
          const center: Vec3 = [
            (flight.start.x + flight.direction.x * depth * (index + 0.5)) * scale,
            (flight.start.y + flight.rise * riseProgress - thickness / (2 * scale)) * scale,
            (flight.start.z + flight.direction.z * depth * (index + 0.5)) * scale,
          ];
          addOrientedBox(
            triangles,
            center,
            [flight.direction.x, 0, flight.direction.z],
            depth * scale,
            flight.width * scale,
            thickness,
          );
        }
        for (let index = 0; index < flight.riserCount; index += 1) {
          const progress = index / Math.max(1, flight.treadCount);
          const center: Vec3 = [
            (flight.start.x + flight.direction.x * flight.run * progress) * scale,
            (flight.start.y + risePerRiser * (index + 0.5)) * scale,
            (flight.start.z + flight.direction.z * flight.run * progress) * scale,
          ];
          addOrientedBox(
            triangles,
            center,
            [flight.direction.x, 0, flight.direction.z],
            project.stairParams.riserThickness,
            flight.width * scale,
            risePerRiser * scale,
          );
        }
        for (const side of [-1, 1]) {
          const offset = side * (flight.width / 2 - 0.08);
          const start: Point3 = {
            x: flight.start.x - flight.direction.z * offset,
            y: flight.start.y - 0.12,
            z: flight.start.z + flight.direction.x * offset,
          };
          const end: Point3 = {
            x: flight.start.x + flight.direction.x * flight.run - flight.direction.z * offset,
            y: flight.start.y + flight.rise - 0.12,
            z: flight.start.z + flight.direction.z * flight.run + flight.direction.x * offset,
          };
          addBeam(triangles, start, end, 0.08, scale);
        }
      }
      for (const landing of layout.landings) {
        addOrientedBox(
          triangles,
          [
            landing.center.x * scale,
            (landing.center.y - thickness / (2 * scale)) * scale,
            landing.center.z * scale,
          ],
          [1, 0, 0],
          landing.length * scale,
          landing.width * scale,
          thickness,
        );
      }
    }
  }
  const unitName = project.units === "imperial" ? "inch" : "millimeter";
  const rows = [`solid stair_ladder_${unitName}`];
  for (const triangle of triangles) {
    const n = normal(triangle);
    rows.push(`  facet normal ${n.map((value) => value.toFixed(7)).join(" ")}`);
    rows.push("    outer loop");
    for (const point of triangle) {
      rows.push(`      vertex ${point.map((value) => value.toFixed(5)).join(" ")}`);
    }
    rows.push("    endloop", "  endfacet");
  }
  rows.push("endsolid");
  return rows.join("\n");
}
