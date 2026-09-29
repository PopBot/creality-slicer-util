import path from 'node:path';
import fs from 'node:fs';

export interface SlicerProfiles {
  machine: string;
  process: string;
  filament: string;
}

export class ProfileManager {
  private static getBaseDir(): string {
    const defaultMacPath = '/Applications/OrcaSlicer.app/Contents/Resources/profiles/Creality';
    if (fs.existsSync(defaultMacPath)) {
      return defaultMacPath;
    }
    // Check if custom env var is set
    if (process.env.ORCA_PROFILES_DIR && fs.existsSync(process.env.ORCA_PROFILES_DIR)) {
      return process.env.ORCA_PROFILES_DIR;
    }
    return defaultMacPath;
  }

  static getMachineProfile(nozzle: '0.4' | '0.6' | '0.8' = '0.4'): string {
    const base = this.getBaseDir();
    const file = path.join(base, 'machine', `Creality K1 (${nozzle} nozzle).json`);
    if (!fs.existsSync(file)) {
      throw new Error(`K1 Machine profile not found at ${file}`);
    }
    return file;
  }

  static getProcessProfile(preset: 'standard' | 'fine' | 'optimal' | 'draft' = 'standard'): string {
    const base = this.getBaseDir();
    const map: Record<string, string> = {
      standard: '0.20mm Standard @Creality K1 (0.4 nozzle).json',
      fine: '0.12mm Fine @Creality K1 (0.4 nozzle).json',
      optimal: '0.16mm Optimal @Creality K1 (0.4 nozzle).json',
      draft: '0.24mm Draft @Creality K1 (0.4 nozzle).json',
    };
    const filename = map[preset] || map.standard;
    const file = path.join(base, 'process', filename);
    if (!fs.existsSync(file)) {
      throw new Error(`Process profile ${preset} not found at ${file}`);
    }
    return file;
  }

  static getFilamentProfile(material: 'hyper-pla' | 'pla' | 'petg' | 'abs' | 'tpu' = 'hyper-pla'): string {
    const base = this.getBaseDir();
    const map: Record<string, string> = {
      'hyper-pla': 'Hyper PLA @K1_CFS-C-all.json',
      'pla': 'Generic PLA @K1_CFS-C-all.json',
      'petg': 'Hyper PETG @K1_CFS-C-all.json',
      'abs': 'Hyper ABS @K1_CFS-C-all.json',
      'tpu': 'Generic TPU @K1_CFS-C-all.json',
    };
    const filename = map[material] || map['hyper-pla'];
    const file = path.join(base, 'filament', filename);
    if (!fs.existsSync(file)) {
      throw new Error(`Filament profile ${material} not found at ${file}`);
    }
    return file;
  }
}
