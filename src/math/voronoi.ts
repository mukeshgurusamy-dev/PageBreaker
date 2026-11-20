/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { SeededPRNG } from './prng';

export interface Point2D {
  x: number;
  y: number;
}

export interface VoronoiShardGeometry {
  centroidX: number;
  centroidY: number;
  area: number;
  geometry: THREE.BufferGeometry;
}

/**
 * Clips a convex 2D polygon against a linear half-plane: (q - mid) . normal >= 0
 * using exact Sutherland-Hodgman edge intersection.
 */
function clipPolygonByHalfPlane(
  poly: Point2D[],
  midX: number,
  midY: number,
  normX: number,
  normY: number,
): Point2D[] {
  if (poly.length < 3) return [];
  const out: Point2D[] = [];
  const eps = -1e-6;

  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    const dCur = (cur.x - midX) * normX + (cur.y - midY) * normY;
    const dNext = (next.x - midX) * normX + (next.y - midY) * normY;

    const curIn = dCur >= eps;
    const nextIn = dNext >= eps;

    if (curIn && nextIn) {
      out.push(next);
    } else if (curIn && !nextIn) {
      const denom = dCur - dNext;
      const t = Math.abs(denom) > 1e-8 ? dCur / denom : 0.5;
      out.push({
        x: cur.x + (next.x - cur.x) * t,
        y: cur.y + (next.y - cur.y) * t,
      });
    } else if (!curIn && nextIn) {
      const denom = dCur - dNext;
      const t = Math.abs(denom) > 1e-8 ? dCur / denom : 0.5;
      out.push({
        x: cur.x + (next.x - cur.x) * t,
        y: cur.y + (next.y - cur.y) * t,
      });
      out.push(next);
    }
  }

  // Deduplicate ultra-short degenerate edges
  const clean: Point2D[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const prev = clean[clean.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-4) {
      clean.push(p);
    }
  }
  if (
    clean.length > 2 &&
    Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 1e-4
  ) {
    clean.pop();
  }
  return clean;
}

function polygonAreaAndCentroid(poly: Point2D[]): { area: number; cx: number; cy: number } {
  let signedArea = 0;
  let cx = 0;
  let cy = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    signedArea += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  signedArea *= 0.5;
  if (Math.abs(signedArea) < 1e-6) {
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p.x;
      sy += p.y;
    }
    return { area: 0, cx: sx / Math.max(1, n), cy: sy / Math.max(1, n) };
  }
  const factor = 1 / (6 * signedArea);
  return {
    area: Math.abs(signedArea),
    cx: cx * factor,
    cy: cy * factor,
  };
}

/**
 * Slices a rectangular backdrop strip [-width/2, width/2] x [-height/2, height/2]
 * into flush, pixel-exact convex Voronoi 3D glass prism shards.
 *
 * Each shard geometry sits centered on (0, 0, 0) with:
 * - Front cap flush at z = 0 (so intact Act I tiles match 1:1 with zero seam gaps)
 * - Back cap at z = -depth (gives real crystalline thickness when shards tumble in Act II)
 * - Custom attributes: aLayer (tile slice index) and aEdge (0 at centroid, 1 on rim/bevel)
 */
export function buildVoronoiTileShards(params: {
  width: number;
  height: number;
  cols: number;
  rows: number;
  depth: number;
  layerIndex: number;
  prng: SeededPRNG;
}): VoronoiShardGeometry[] {
  const { width, height, cols, rows, depth, layerIndex, prng } = params;
  const halfW = width * 0.5;
  const halfH = height * 0.5;

  // Generate jittered grid seed points for well-balanced Voronoi mirror shards
  const cellW = width / cols;
  const cellH = height / rows;
  const sites: Point2D[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = -halfW + (c + 0.18 + prng.next() * 0.64) * cellW;
      const sy = -halfH + (r + 0.18 + prng.next() * 0.64) * cellH;
      sites.push({ x: sx, y: sy });
    }
  }

  const invW = 1 / Math.max(0.01, width);
  const invH = 1 / Math.max(0.01, height);
  const results: VoronoiShardGeometry[] = [];

  for (let i = 0; i < sites.length; i++) {
    const siteA = sites[i];
    let poly: Point2D[] = [
      { x: -halfW, y: -halfH },
      { x: halfW, y: -halfH },
      { x: halfW, y: halfH },
      { x: -halfW, y: halfH },
    ];

    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const siteB = sites[j];
      const midX = (siteA.x + siteB.x) * 0.5;
      const midY = (siteA.y + siteB.y) * 0.5;
      const normX = siteA.x - siteB.x;
      const normY = siteA.y - siteB.y;
      poly = clipPolygonByHalfPlane(poly, midX, midY, normX, normY);
      if (poly.length < 3) break;
    }

    if (poly.length < 3) continue;

    // Ensure CCW winding
    const { area, cx, cy } = polygonAreaAndCentroid(poly);
    if (area < 0.04) continue;

    const p0 = poly[0];
    const p1 = poly[1];
    const p2 = poly[2];
    const crossCheck = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    if (crossCheck < 0) poly.reverse();

    const n = poly.length;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const layers: number[] = [];
    const edges: number[] = [];

    const pushVertex = (
      lx: number,
      ly: number,
      lz: number,
      nx: number,
      ny: number,
      nz: number,
      u: number,
      v: number,
      edgeVal: number,
    ) => {
      positions.push(lx, ly, lz);
      normals.push(nx, ny, nz);
      uvs.push(u, v);
      layers.push(layerIndex);
      edges.push(edgeVal);
    };

    const centroidU = THREE.MathUtils.clamp((cx + halfW) * invW, 0, 1);
    const centroidV = THREE.MathUtils.clamp((cy + halfH) * invH, 0, 1);

    // 1. Front Cap (z = 0, facing +Z) — triangulated from centroid fan
    for (let k = 0; k < n; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % n];
      const au = THREE.MathUtils.clamp((a.x + halfW) * invW, 0, 1);
      const av = THREE.MathUtils.clamp((a.y + halfH) * invH, 0, 1);
      const bu = THREE.MathUtils.clamp((b.x + halfW) * invW, 0, 1);
      const bv = THREE.MathUtils.clamp((b.y + halfH) * invH, 0, 1);

      pushVertex(0, 0, 0, 0, 0, 1, centroidU, centroidV, 0.0);
      pushVertex(a.x - cx, a.y - cy, 0, 0, 0, 1, au, av, 1.0);
      pushVertex(b.x - cx, b.y - cy, 0, 0, 0, 1, bu, bv, 1.0);
    }

    // 2. Back Cap (z = -depth, facing -Z) — reverse winding
    for (let k = 0; k < n; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % n];
      const au = THREE.MathUtils.clamp((a.x + halfW) * invW, 0, 1);
      const av = THREE.MathUtils.clamp((a.y + halfH) * invH, 0, 1);
      const bu = THREE.MathUtils.clamp((b.x + halfW) * invW, 0, 1);
      const bv = THREE.MathUtils.clamp((b.y + halfH) * invH, 0, 1);

      pushVertex(0, 0, -depth, 0, 0, -1, centroidU, centroidV, 0.25);
      pushVertex(b.x - cx, b.y - cy, -depth, 0, 0, -1, bu, bv, 1.0);
      pushVertex(a.x - cx, a.y - cy, -depth, 0, 0, -1, au, av, 1.0);
    }

    // 3. Bevelled Glass Side Walls (each edge quad -> 2 triangles)
    for (let k = 0; k < n; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len = Math.max(1e-5, Math.hypot(ex, ey));
      const nx = ey / len;
      const ny = -ex / len;

      const au = THREE.MathUtils.clamp((a.x + halfW) * invW, 0, 1);
      const av = THREE.MathUtils.clamp((a.y + halfH) * invH, 0, 1);
      const bu = THREE.MathUtils.clamp((b.x + halfW) * invW, 0, 1);
      const bv = THREE.MathUtils.clamp((b.y + halfH) * invH, 0, 1);

      const ax = a.x - cx;
      const ay = a.y - cy;
      const bx = b.x - cx;
      const by = b.y - cy;

      pushVertex(ax, ay, 0, nx, ny, 0, au, av, 1.0);
      pushVertex(ax, ay, -depth, nx, ny, 0, au, av, 1.0);
      pushVertex(bx, by, 0, nx, ny, 0, bu, bv, 1.0);

      pushVertex(bx, by, 0, nx, ny, 0, bu, bv, 1.0);
      pushVertex(ax, ay, -depth, nx, ny, 0, au, av, 1.0);
      pushVertex(bx, by, -depth, nx, ny, 0, bu, bv, 1.0);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('aLayer', new THREE.Float32BufferAttribute(layers, 1));
    geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
    geometry.computeBoundingSphere();

    results.push({
      centroidX: cx,
      centroidY: cy,
      area,
      geometry,
    });
  }

  return results;
}
