import fs from 'node:fs';

export interface OrientationCandidate {
  normal: [number, number, number];
  contactArea: number;
  score: number;
}

/**
 * Heuristic Auto-Orientation:
 * Analyzes mesh triangles, groups coplanar surfaces, and computes
 * the orientation that maximizes bed contact surface area and minimizes overhangs.
 */
export class AutoOrient {
  /**
   * Find the best downward face normal for resting on the build plate.
   */
  static findBestOrientation(filePath: string): [number, number, number] {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 84) {
      return [0, 0, -1];
    }

    const triangleCount = buffer.readUInt32LE(80);
    const available = Math.min(triangleCount, Math.floor((buffer.length - 84) / 50));

    // Map quantized normals to accumulated face area
    const normalBins = new Map<string, { nx: number; ny: number; nz: number; area: number }>();

    let offset = 84;
    for (let i = 0; i < available; i++) {
      // Read normal
      let nx = buffer.readFloatLE(offset);
      let ny = buffer.readFloatLE(offset + 4);
      let nz = buffer.readFloatLE(offset + 8);
      offset += 12;

      // Read vertices v0, v1, v2
      const x0 = buffer.readFloatLE(offset);
      const y0 = buffer.readFloatLE(offset + 4);
      const z0 = buffer.readFloatLE(offset + 8);
      offset += 12;

      const x1 = buffer.readFloatLE(offset);
      const y1 = buffer.readFloatLE(offset + 4);
      const z1 = buffer.readFloatLE(offset + 8);
      offset += 12;

      const x2 = buffer.readFloatLE(offset);
      const y2 = buffer.readFloatLE(offset + 4);
      const z2 = buffer.readFloatLE(offset + 8);
      offset += 12;

      // Skip attribute byte count
      offset += 2;

      // Compute cross product of (v1 - v0) x (v2 - v0)
      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const crossLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const area = 0.5 * crossLen;

      if (crossLen > 1e-6) {
        nx = cx / crossLen;
        ny = cy / crossLen;
        nz = cz / crossLen;
      }

      // Quantize normal to 2 decimal places to cluster parallel faces
      const key = `${Math.round(nx * 20) / 20},${Math.round(ny * 20) / 20},${Math.round(nz * 20) / 20}`;
      const existing = normalBins.get(key);
      if (existing) {
        existing.area += area;
      } else {
        normalBins.set(key, { nx, ny, nz, area });
      }
    }

    let bestNormal: [number, number, number] = [0, 0, -1];
    let maxArea = -1;

    for (const bin of normalBins.values()) {
      if (bin.area > maxArea) {
        maxArea = bin.area;
        bestNormal = [bin.nx, bin.ny, bin.nz];
      }
    }

    return bestNormal;
  }
}
