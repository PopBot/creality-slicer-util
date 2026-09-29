import fs from 'node:fs';

export interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
  height: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  boundingBox: BoundingBox;
  triangleCount: number;
}

export const K1_SPECS = {
  bedWidth: 220, // X
  bedDepth: 220, // Y
  maxHeight: 250, // Z
  centerX: 110,
  centerY: 110,
};

export class STLParser {
  /**
   * Parse an STL file and compute its exact bounding box and triangle metrics.
   */
  static parse(filePath: string): { boundingBox: BoundingBox; triangleCount: number; isBinary: boolean } {
    const buffer = fs.readFileSync(filePath);
    return this.parseBuffer(buffer);
  }

  static parseBuffer(buffer: Buffer): { boundingBox: BoundingBox; triangleCount: number; isBinary: boolean } {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let triangleCount = 0;
    let isBinary = true;

    // Check if ASCII
    const headerStr = buffer.subarray(0, 80).toString('utf8');
    if (headerStr.startsWith('solid') && !buffer.subarray(0, 512).includes(0)) {
      // Potentially ASCII STL
      try {
        const text = buffer.toString('utf8');
        const vertexMatches = text.match(/vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g);
        if (vertexMatches && vertexMatches.length > 0) {
          isBinary = false;
          triangleCount = Math.floor(vertexMatches.length / 3);
          for (const line of vertexMatches) {
            const parts = line.trim().split(/\s+/);
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
      } catch {
        // Fall back to binary parsing
        isBinary = true;
      }
    }

    if (isBinary) {
      if (buffer.length < 84) {
        throw new Error('Invalid STL buffer: file is too small to be a valid STL.');
      }
      triangleCount = buffer.readUInt32LE(80);
      let offset = 84;
      const expectedSize = 84 + triangleCount * 50;

      // Handle cases where triangle count in header might be incomplete
      const availableTriangles = Math.min(triangleCount, Math.floor((buffer.length - 84) / 50));
      for (let i = 0; i < availableTriangles; i++) {
        // Skip normal vector (12 bytes)
        offset += 12;
        for (let v = 0; v < 3; v++) {
          const x = buffer.readFloatLE(offset);
          const y = buffer.readFloatLE(offset + 4);
          const z = buffer.readFloatLE(offset + 8);
          offset += 12;

          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        // Skip attribute byte count (2 bytes)
        offset += 2;
      }
    }

    if (minX === Infinity) {
      minX = maxX = minY = maxY = minZ = maxZ = 0;
    }

    const width = maxX - minX;
    const depth = maxY - minY;
    const height = maxZ - minZ;

    const boundingBox: BoundingBox = {
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      width,
      depth,
      height,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
    };

    return { boundingBox, triangleCount, isBinary };
  }

  /**
   * Validate if the model fits within the Creality K1 build volume.
   */
  static validateForK1(filePath: string): ValidationResult {
    const { boundingBox, triangleCount } = this.parse(filePath);
    const issues: string[] = [];

    // 1. Dimensions check
    if (boundingBox.width > K1_SPECS.bedWidth) {
      issues.push(`Model width (${boundingBox.width.toFixed(1)}mm) exceeds K1 bed width (${K1_SPECS.bedWidth}mm)`);
    }
    if (boundingBox.depth > K1_SPECS.bedDepth) {
      issues.push(`Model depth (${boundingBox.depth.toFixed(1)}mm) exceeds K1 bed depth (${K1_SPECS.bedDepth}mm)`);
    }
    if (boundingBox.height > K1_SPECS.maxHeight) {
      issues.push(`Model height (${boundingBox.height.toFixed(1)}mm) exceeds K1 max height (${K1_SPECS.maxHeight}mm)`);
    }

    // 2. Position bounds check
    if (boundingBox.minX < 0) {
      issues.push(`Model extends left of build plate (Min X: ${boundingBox.minX.toFixed(1)}mm < 0mm)`);
    }
    if (boundingBox.maxX > K1_SPECS.bedWidth) {
      issues.push(`Model extends right of build plate (Max X: ${boundingBox.maxX.toFixed(1)}mm > ${K1_SPECS.bedWidth}mm)`);
    }
    if (boundingBox.minY < 0) {
      issues.push(`Model extends front of build plate (Min Y: ${boundingBox.minY.toFixed(1)}mm < 0mm)`);
    }
    if (boundingBox.maxY > K1_SPECS.bedDepth) {
      issues.push(`Model extends back of build plate (Max Y: ${boundingBox.maxY.toFixed(1)}mm > ${K1_SPECS.bedDepth}mm)`);
    }

    // 3. Grounding check
    if (boundingBox.minZ < -0.1) {
      issues.push(`Model penetrates below build surface (Min Z: ${boundingBox.minZ.toFixed(2)}mm < 0mm)`);
    } else if (boundingBox.minZ > 0.5) {
      issues.push(`Model is floating above build plate (Min Z: ${boundingBox.minZ.toFixed(2)}mm > 0mm)`);
    }

    return {
      valid: issues.length === 0,
      issues,
      boundingBox,
      triangleCount,
    };
  }

  /**
   * Auto-centers an STL file on the K1 bed (110, 110) and aligns bottom to Z=0.
   * Writes the resulting binary STL to targetPath.
   */
  static autoCenterAndGround(sourcePath: string, targetPath: string): BoundingBox {
    const buffer = fs.readFileSync(sourcePath);
    const { boundingBox, triangleCount } = this.parseBuffer(buffer);

    const shiftX = K1_SPECS.centerX - boundingBox.centerX;
    const shiftY = K1_SPECS.centerY - boundingBox.centerY;
    const shiftZ = -boundingBox.minZ;

    // Read and transform each vertex into a new binary STL
    const outBuffer = Buffer.alloc(84 + triangleCount * 50);
    // Copy 80-byte header
    buffer.copy(outBuffer, 0, 0, 80);
    outBuffer.writeUInt32LE(triangleCount, 80);

    let srcOffset = 84;
    let dstOffset = 84;

    for (let i = 0; i < triangleCount; i++) {
      // Copy normal vector (12 bytes)
      buffer.copy(outBuffer, dstOffset, srcOffset, srcOffset + 12);
      srcOffset += 12;
      dstOffset += 12;

      // Transform 3 vertices
      for (let v = 0; v < 3; v++) {
        const x = buffer.readFloatLE(srcOffset) + shiftX;
        const y = buffer.readFloatLE(srcOffset + 4) + shiftY;
        const z = buffer.readFloatLE(srcOffset + 8) + shiftZ;

        outBuffer.writeFloatLE(x, dstOffset);
        outBuffer.writeFloatLE(y, dstOffset + 4);
        outBuffer.writeFloatLE(z, dstOffset + 8);

        srcOffset += 12;
        dstOffset += 12;
      }

      // Copy attribute byte count (2 bytes)
      buffer.copy(outBuffer, dstOffset, srcOffset, srcOffset + 2);
      srcOffset += 2;
      dstOffset += 2;
    }

    fs.writeFileSync(targetPath, outBuffer);

    return {
      minX: boundingBox.minX + shiftX,
      maxX: boundingBox.maxX + shiftX,
      minY: boundingBox.minY + shiftY,
      maxY: boundingBox.maxY + shiftY,
      minZ: 0,
      maxZ: boundingBox.height,
      width: boundingBox.width,
      depth: boundingBox.depth,
      height: boundingBox.height,
      centerX: K1_SPECS.centerX,
      centerY: K1_SPECS.centerY,
      centerZ: boundingBox.height / 2,
    };
  }
}
