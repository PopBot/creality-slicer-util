import fs from 'node:fs';

export interface SliceStats {
  estimatedTimeStr: string;
  filamentUsedMeters: number;
  filamentUsedGrams: number;
  filamentUsedCm3: number;
  totalLayers: number;
  maxZHeight: number;
  gcodePath: string;
  fileSizeBytes: number;
}

export class GcodeParser {
  static parse(gcodePath: string): SliceStats {
    const content = fs.readFileSync(gcodePath, 'utf8');
    const stats: SliceStats = {
      estimatedTimeStr: 'Unknown',
      filamentUsedMeters: 0,
      filamentUsedGrams: 0,
      filamentUsedCm3: 0,
      totalLayers: 0,
      maxZHeight: 0,
      gcodePath,
      fileSizeBytes: fs.statSync(gcodePath).size,
    };

    // Estimated time
    const timeMatch = content.match(/;\s*estimated printing time.*?=\s*(.+)/i);
    if (timeMatch) {
      stats.estimatedTimeStr = timeMatch[1].trim();
    }

    // Filament mm
    const mmMatch = content.match(/;\s*filament used \[mm\]\s*=\s*([\d.]+)/i);
    if (mmMatch) {
      stats.filamentUsedMeters = parseFloat(mmMatch[1]) / 1000;
    }

    // Filament cm3
    const cm3Match = content.match(/;\s*filament used \[cm3\]\s*=\s*([\d.]+)/i);
    if (cm3Match) {
      stats.filamentUsedCm3 = parseFloat(cm3Match[1]);
      // Density of standard PLA is approx 1.24 g/cm3
      stats.filamentUsedGrams = parseFloat((stats.filamentUsedCm3 * 1.24).toFixed(1));
    }

    // Layers
    const layerMatch = content.match(/;\s*total layer number:\s*(\d+)/i);
    if (layerMatch) {
      stats.totalLayers = parseInt(layerMatch[1], 10);
    }

    // Max Z
    const zMatch = content.match(/;\s*max_z_height:\s*([\d.]+)/i);
    if (zMatch) {
      stats.maxZHeight = parseFloat(zMatch[1]);
    }

    return stats;
  }
}
