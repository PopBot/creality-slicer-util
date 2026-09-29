import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ProfileManager } from './profiles.js';
import { GcodeParser, SliceStats } from './gcode-parser.js';

export interface SliceOptions {
  preset?: 'standard' | 'fine' | 'optimal' | 'draft';
  material?: 'hyper-pla' | 'pla' | 'petg' | 'abs' | 'tpu';
  infill?: number; // e.g. 20 for 20%
  infillPattern?: 'gyroid' | 'grid' | 'cubic' | 'honeycomb' | 'rectilinear' | 'lightning';
  layerHeight?: number; // e.g. 0.20
  supports?: boolean;
  supportType?: 'tree' | 'normal';
  brim?: 'auto' | 'outer' | 'inner_and_outer' | 'none';
  walls?: number;
  arrange?: boolean;
  orient?: boolean;
  outputGcodePath?: string;
  onLog?: (message: string) => void;
}

export class OrcaWrapper {
  private static findBinary(): string {
    const candidates = [
      process.env.ORCA_SLICER_PATH,
      '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
      `${os.homedir()}/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer`,
      'orca-slicer',
      'OrcaSlicer',
    ];

    for (const bin of candidates) {
      if (bin && fs.existsSync(bin)) {
        return bin;
      }
    }
    return '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer';
  }

  static async slice(inputStlPaths: string[], options: SliceOptions = {}): Promise<SliceStats> {
    const binary = this.findBinary();
    if (!fs.existsSync(binary)) {
      throw new Error(
        `OrcaSlicer binary not found at "${binary}". Please install it via 'brew install --cask orcaslicer' or set ORCA_SLICER_PATH.`
      );
    }

    if (inputStlPaths.length === 0) {
      throw new Error('No input STL files provided for slicing.');
    }

    // Verify all input files exist
    for (const p of inputStlPaths) {
      if (!fs.existsSync(p)) {
        throw new Error(`Input 3D model file does not exist: ${p}`);
      }
    }

    const machineProfile = ProfileManager.getMachineProfile('0.4');
    const processProfile = ProfileManager.getProcessProfile(options.preset || 'standard');
    const filamentProfile = ProfileManager.getFilamentProfile(options.material || 'hyper-pla');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-slice-'));

    // Clone and customize process profile to cleanly override parameters without CLI flag friction
    const processJson = JSON.parse(fs.readFileSync(processProfile, 'utf-8'));
    if (options.infill !== undefined) {
      processJson.sparse_infill_density = `${options.infill}%`;
    }
    if (options.infillPattern) {
      processJson.sparse_infill_pattern = options.infillPattern;
    }
    if (options.layerHeight !== undefined) {
      processJson.layer_height = options.layerHeight.toString();
    }
    if (options.supports !== undefined) {
      processJson.enable_support = options.supports ? '1' : '0';
      if (options.supports) {
        processJson.support_type = options.supportType === 'tree' ? 'tree(auto)' : 'normal(auto)';
      }
    }
    if (options.brim) {
      const brimMap: Record<string, string> = {
        none: 'no_brim',
        outer: 'outer_only',
        inner_and_outer: 'outer_and_inner',
        auto: 'auto_brim',
      };
      processJson.brim_type = brimMap[options.brim] || 'auto_brim';
    }
    if (options.walls !== undefined) {
      processJson.wall_loops = options.walls.toString();
    }

    const customProcessPath = path.join(tempDir, 'custom_process.json');
    fs.writeFileSync(customProcessPath, JSON.stringify(processJson, null, 2), 'utf-8');

    const args: string[] = [
      '--load-settings',
      `${machineProfile};${customProcessPath}`,
      '--load-filaments',
      filamentProfile,
    ];

    // Arrange / Orient flags supported by CLI
    if (options.arrange === false) {
      args.push('--arrange', '0');
    } else {
      args.push('--arrange', '1');
    }

    if (options.orient) {
      args.push('--orient', '1');
    }

    // Output dir and slice action
    args.push('--slice', '0', '--outputdir', tempDir);
    args.push(...inputStlPaths);

    const logCallback = options.onLog || (() => {});
    logCallback(`Executing: ${binary} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        logCallback(text);
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        logCallback(text);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(
            new Error(
              `OrcaSlicer exited with code ${code}.\n${stderr || stdout || 'Ensure models are inside K1 build volume (220x220x250mm).'}`
            )
          );
        }

        // Locate generated gcode
        const generatedGcode = path.join(tempDir, 'plate_1.gcode');
        if (!fs.existsSync(generatedGcode)) {
          return reject(new Error(`Slicing completed but expected gcode was not found in ${tempDir}.`));
        }

        const finalGcodePath = options.outputGcodePath || inputStlPaths[0].replace(/\.(stl|obj|3mf)$/i, '.gcode');
        fs.copyFileSync(generatedGcode, finalGcodePath);

        try {
          const stats = GcodeParser.parse(finalGcodePath);
          resolve(stats);
        } catch (err: any) {
          reject(new Error(`Failed to parse sliced G-code statistics: ${err.message}`));
        } finally {
          // Clean up temp dir
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {}
        }
      });
    });
  }
}
