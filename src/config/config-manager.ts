import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface K1Config {
  printerIp?: string;
  preset?: 'standard' | 'fine' | 'optimal' | 'draft';
  material?: 'hyper-pla' | 'pla' | 'petg' | 'abs' | 'tpu';
  infill?: number;
  infillPattern?: 'gyroid' | 'grid' | 'cubic' | 'honeycomb' | 'rectilinear' | 'lightning';
  supports?: boolean;
  supportType?: 'tree' | 'normal';
  brim?: 'auto' | 'outer' | 'inner_and_outer' | 'none';
  walls?: number;
  autoCenter?: boolean;
}

export const DEFAULT_CONFIG: K1Config = {
  preset: 'standard',
  material: 'hyper-pla',
  infill: 20,
  infillPattern: 'gyroid',
  supports: true,
  supportType: 'tree',
  brim: 'auto',
  walls: 3,
  autoCenter: true,
};

export class ConfigManager {
  private static getConfigDir(): string {
    const dir = path.join(os.homedir(), '.k1-slicer');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private static getConfigFile(): string {
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

    if (normalizedKey === 'infill' || normalizedKey === 'walls') {
      (config as any)[normalizedKey] = parseInt(value, 10);
    } else if (normalizedKey === 'supports' || normalizedKey === 'autoCenter') {
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
