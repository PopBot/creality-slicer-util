import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface K1Config {
  printerIp?: string;
  printerPort?: number;
  preset?: 'standard' | 'fine' | 'optimal' | 'draft';
  material?: 'hyper-pla' | 'ender-pla' | 'pla' | 'petg' | 'abs' | 'tpu';
  infill?: number;
  infillPattern?: 'gyroid' | 'grid' | 'cubic' | 'honeycomb' | 'rectilinear' | 'lightning';
  layerHeight?: number;
  firstLayerHeight?: number;
  supports?: boolean;
  supportType?: 'tree' | 'normal';
  brim?: 'auto' | 'outer' | 'inner_and_outer' | 'none';
  walls?: number;
  topShellLayers?: number;
  bottomShellLayers?: number;
  autoCenter?: boolean;
  autoOrient?: boolean;
  unit?: 'inches' | 'mm';
  speed?: string;
  // Thermals
  nozzleTemp?: number;
  nozzleTempInitialLayer?: number;
  bedTemp?: number;
  bedTempInitialLayer?: number;
  // Speeds (mm/s)
  initialLayerSpeed?: number;
  initialLayerInfillSpeed?: number;
  outerWallSpeed?: number;
  innerWallSpeed?: number;
  infillSpeed?: number;
  solidInfillSpeed?: number;
  topSurfaceSpeed?: number;
  travelSpeed?: number;
  // Dynamics & Cooling
  maxVolumetricSpeed?: number;
  flowRatio?: number;
  retractionLength?: number;
  auxiliaryFanSpeed?: number;
  modelFanSpeed?: number;
  closeFanFirstNLayers?: number;
  orcaPath?: string;
}

export const DEFAULT_CONFIG: K1Config = {
  printerPort: 7125,
  preset: 'standard',
  material: 'ender-pla',
  infill: 15,
  infillPattern: 'gyroid',
  layerHeight: 0.20,
  firstLayerHeight: 0.20,
  supports: true,
  supportType: 'tree',
  brim: 'auto',
  walls: 3,
  topShellLayers: 4,
  bottomShellLayers: 3,
  speed: '100%',
  nozzleTemp: 230,
  nozzleTempInitialLayer: 230,
  bedTemp: 50,
  bedTempInitialLayer: 50,
  initialLayerSpeed: 50,
  initialLayerInfillSpeed: 60,
  outerWallSpeed: 80,
  innerWallSpeed: 120,
  infillSpeed: 120,
  solidInfillSpeed: 120,
  topSurfaceSpeed: 80,
  travelSpeed: 300,
  maxVolumetricSpeed: 12,
  flowRatio: 1.0,
  retractionLength: 0.8,
  auxiliaryFanSpeed: 50,
  modelFanSpeed: 100,
  closeFanFirstNLayers: 1,
  autoCenter: true,
  autoOrient: false,
  unit: 'inches',
};

export class ConfigManager {
  private static getConfigDir(): string {
    const dir = path.join(os.homedir(), '.k1-slicer');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static getConfigFile(): string {
    return path.join(this.getConfigDir(), 'config.json');
  }

  static load(): K1Config {
    const file = this.getConfigFile();
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_CONFIG, ...parsed };
      } catch {
        return { ...DEFAULT_CONFIG };
      }
    }
    return { ...DEFAULT_CONFIG };
  }

  static save(config: Partial<K1Config>): K1Config {
    const current = this.load();
    const merged = { ...current, ...config };
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  static set(key: string, value: string): K1Config {
    const config = this.load();
    const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (normalizedKey === 'infill' || normalizedKey === 'walls' || normalizedKey === 'printerPort') {
      (config as any)[normalizedKey] = parseInt(value, 10);
    } else if (normalizedKey === 'layerHeight') {
      (config as any)[normalizedKey] = parseFloat(value);
    } else if (normalizedKey === 'supports' || normalizedKey === 'autoCenter' || normalizedKey === 'autoOrient') {
      (config as any)[normalizedKey] = value === 'true' || value === '1' || value === 'yes';
    } else {
      (config as any)[normalizedKey] = value;
    }

    return this.save(config);
  }

  static get(key: string): any {
    const config = this.load();
    const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return (config as any)[normalizedKey];
  }

  static reset(): K1Config {
    const file = this.getConfigFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return { ...DEFAULT_CONFIG };
  }
}
