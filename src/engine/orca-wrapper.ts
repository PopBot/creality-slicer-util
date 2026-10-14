import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ProfileManager } from './profiles.js';
import { GcodeParser, SliceStats } from './gcode-parser.js';

export interface SliceOptions {
  preset?: 'standard' | 'fine' | 'optimal' | 'draft';
  material?: 'hyper-pla' | 'ender-pla' | 'pla' | 'petg' | 'abs' | 'tpu';
  infill?: number; // e.g. 20 for 20%
  infillPattern?: 'gyroid' | 'grid' | 'cubic' | 'honeycomb' | 'rectilinear' | 'lightning';
  layerHeight?: number; // e.g. 0.20
  firstLayerHeight?: number; // e.g. 0.20 or 0.25
  supports?: boolean;
  supportType?: 'tree' | 'normal';
  brim?: 'auto' | 'outer' | 'inner_and_outer' | 'none';
  walls?: number;
  topShellLayers?: number;
  bottomShellLayers?: number;
  speed?: string | number; // base / preset mode
  // Thermals
  nozzleTemp?: number;
  nozzleTempInitialLayer?: number;
  bedTemp?: number;
  bedTempInitialLayer?: number;
  // Speeds Hierarchy (mm/s)
  initialLayerSpeed?: number;
  initialLayerInfillSpeed?: number;
  outerWallSpeed?: number;
  innerWallSpeed?: number;
  infillSpeed?: number;
  solidInfillSpeed?: number;
  topSurfaceSpeed?: number;
  travelSpeed?: number;
  // Flow & Dynamics
  maxVolumetricSpeed?: number; // mm³/s
  flowRatio?: number; // e.g. 1.0 or 0.98
  retractionLength?: number; // mm
  // Fans & Cooling
  auxiliaryFanSpeed?: number; // 0-100%
  modelFanSpeed?: number; // 0-100%
  closeFanFirstNLayers?: number; // e.g. 1
  arrange?: boolean;
  orient?: boolean;
  outputGcodePath?: string;
  onLog?: (message: string) => void;
}

export interface SpeedInfo {
  factor: number;
  targetSpeedMmS: number;
  description: string;
}

export function parseSpeed(speedInput: string | number | undefined, baseSpeed: number = 300): SpeedInfo | null {
  if (speedInput === undefined || speedInput === null || speedInput === '') {
    return null;
  }

  const str = String(speedInput).trim().toLowerCase();

  // Named K1 touchscreen modes
  if (str === 'silent') {
    const factor = 0.5;
    return { factor, targetSpeedMmS: Math.round(baseSpeed * factor), description: 'Silent (50% / 150 mm/s)' };
  }
  if (str === 'standard') {
    const factor = 1.0;
    return { factor, targetSpeedMmS: baseSpeed, description: 'Standard (100% / 300 mm/s)' };
  }
  if (str === 'sport') {
    const factor = 1.25;
    return { factor, targetSpeedMmS: Math.round(baseSpeed * factor), description: 'Sport (125% / 375 mm/s)' };
  }
  if (str === 'ludicrous') {
    const factor = 1.66;
    return { factor, targetSpeedMmS: Math.round(baseSpeed * factor), description: 'Ludicrous (166% / 500 mm/s)' };
  }

  // Percentage input (e.g. "80%", "150%")
  if (str.endsWith('%')) {
    const pct = parseFloat(str.slice(0, -1));
    if (isNaN(pct) || pct <= 0) return null;
    const factor = pct / 100;
    const target = Math.round(baseSpeed * factor);
    return { factor, targetSpeedMmS: target, description: `${pct}% (${target} mm/s)` };
  }

  // Absolute speed in mm/s (e.g. "250mm/s", "250 mms", or numeric 250)
  const cleaned = str.replace(/mm\/s|mms/g, '').trim();
  const val = parseFloat(cleaned);
  if (isNaN(val) || val <= 0) return null;

  // If a small decimal factor was passed like 0.8
  if (val <= 3.0) {
    const factor = val;
    const target = Math.round(baseSpeed * factor);
    const pct = Math.round(factor * 100);
    return { factor, targetSpeedMmS: target, description: `${pct}% (${target} mm/s)` };
  }

  // Otherwise, treat as speed in mm/s
  const targetSpeedMmS = Math.min(600, Math.max(10, Math.round(val)));
  const factor = targetSpeedMmS / baseSpeed;
  const pct = Math.round(factor * 100);
  return { factor, targetSpeedMmS, description: `${targetSpeedMmS} mm/s (${pct}%)` };
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
    let filamentProfile = ProfileManager.getFilamentProfile(options.material || 'hyper-pla');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-slice-'));

    // Material-specific speed and thermal guards
    if (options.material === 'ender-pla') {
      if (!options.speed || options.speed === '100%' || options.speed === 'standard') {
        options.speed = '60mm/s';
      }

      try {
        const filData = JSON.parse(fs.readFileSync(filamentProfile, 'utf-8'));
        // 1. Cap max volumetric flow to safe melt rate
        filData.filament_max_volumetric_speed = ['12'];
        // 2. Set nozzle to 210°C for smooth fluidity
        filData.nozzle_temperature = ['210'];
        filData.nozzle_temperature_initial_layer = ['210'];

        const customFilPath = path.join(tempDir, 'custom_ender_filament.json');
        fs.writeFileSync(customFilPath, JSON.stringify(filData, null, 2), 'utf-8');
        filamentProfile = customFilPath;
      } catch {}
    }

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

    const logCallback = options.onLog || (() => {});

    if (options.speed !== undefined && options.speed !== null && options.speed !== '') {
      const baseSpeed = parseFloat(processJson.inner_wall_speed) || 300;
      const speedInfo = parseSpeed(options.speed, baseSpeed);
      if (speedInfo) {
        logCallback(`Applying print speed: ${speedInfo.description}`);

        const factor = speedInfo.factor;

        const speedKeys = [
          'outer_wall_speed',
          'inner_wall_speed',
          'sparse_infill_speed',
          'internal_solid_infill_speed',
          'top_surface_speed',
          'gap_infill_speed',
          'initial_layer_speed',
          'initial_layer_infill_speed',
          'support_speed',
          'support_interface_speed',
          'bridge_speed',
          'skirt_speed',
        ];

        for (const k of speedKeys) {
          if (processJson[k] && !processJson[k].includes('%')) {
            const orig = parseFloat(processJson[k]);
            if (!isNaN(orig)) {
              const minSpeed = (k === 'initial_layer_speed' || k === 'initial_layer_infill_speed') ? 35 : 20;
              processJson[k] = String(Math.max(minSpeed, Math.min(600, Math.round(orig * factor))));
            }
          }
        }

        // Adjust travel speed
        if (processJson.travel_speed && !processJson.travel_speed.includes('%')) {
          const origTravel = parseFloat(processJson.travel_speed);
          if (!isNaN(origTravel)) {
            if (factor < 1.0) {
              processJson.travel_speed = String(Math.max(150, Math.round(origTravel * factor)));
            } else {
              processJson.travel_speed = String(Math.min(600, Math.round(origTravel * Math.min(1.2, factor))));
            }
          }
        }

        // Adjust accelerations
        const accelKeys = [
          'default_acceleration',
          'outer_wall_acceleration',
          'inner_wall_acceleration',
          'travel_acceleration',
          'top_surface_acceleration',
        ];

        for (const k of accelKeys) {
          if (processJson[k] && !processJson[k].includes('%')) {
            const origAccel = parseFloat(processJson[k]);
            if (!isNaN(origAccel)) {
              if (factor < 1.0) {
                processJson[k] = String(Math.max(1000, Math.round(origAccel * factor)));
              } else {
                processJson[k] = String(Math.min(15000, Math.round(origAccel * Math.min(1.5, factor))));
              }
            }
          }
        }
      }
    }

    // Granular process parameters (layer heights, shells, speeds, cooling)
    if (options.layerHeight && !isNaN(options.layerHeight)) {
      processJson.layer_height = String(options.layerHeight);
      logCallback(`Layer height: ${options.layerHeight} mm`);
    }
    if (options.firstLayerHeight && !isNaN(options.firstLayerHeight)) {
      processJson.initial_layer_print_height = String(options.firstLayerHeight);
      logCallback(`First layer height: ${options.firstLayerHeight} mm`);
    }
    if (options.topShellLayers && !isNaN(options.topShellLayers)) {
      processJson.top_shell_layers = String(options.topShellLayers);
      logCallback(`Top shell layers: ${options.topShellLayers}`);
    }
    if (options.bottomShellLayers && !isNaN(options.bottomShellLayers)) {
      processJson.bottom_shell_layers = String(options.bottomShellLayers);
      logCallback(`Bottom shell layers: ${options.bottomShellLayers}`);
    }

    // Granular speed hierarchy
    if (options.initialLayerSpeed && !isNaN(options.initialLayerSpeed)) {
      processJson.initial_layer_speed = String(options.initialLayerSpeed);
      logCallback(`Initial layer speed: ${options.initialLayerSpeed} mm/s`);
    }
    if (options.initialLayerInfillSpeed && !isNaN(options.initialLayerInfillSpeed)) {
      processJson.initial_layer_infill_speed = String(options.initialLayerInfillSpeed);
      logCallback(`Initial layer infill speed: ${options.initialLayerInfillSpeed} mm/s`);
    }
    if (options.innerWallSpeed && !isNaN(options.innerWallSpeed)) {
      processJson.inner_wall_speed = String(options.innerWallSpeed);
      logCallback(`Inner wall speed: ${options.innerWallSpeed} mm/s`);
    }
    if (options.outerWallSpeed && !isNaN(options.outerWallSpeed)) {
      processJson.outer_wall_speed = String(options.outerWallSpeed);
      logCallback(`Outer wall speed: ${options.outerWallSpeed} mm/s`);
    }
    if (options.infillSpeed && !isNaN(options.infillSpeed)) {
      processJson.sparse_infill_speed = String(options.infillSpeed);
      logCallback(`Sparse infill speed: ${options.infillSpeed} mm/s`);
    }
    if (options.solidInfillSpeed && !isNaN(options.solidInfillSpeed)) {
      processJson.internal_solid_infill_speed = String(options.solidInfillSpeed);
      logCallback(`Internal solid infill speed: ${options.solidInfillSpeed} mm/s`);
    }
    if (options.topSurfaceSpeed && !isNaN(options.topSurfaceSpeed)) {
      processJson.top_surface_speed = String(options.topSurfaceSpeed);
      logCallback(`Top surface speed: ${options.topSurfaceSpeed} mm/s`);
    }
    if (options.travelSpeed && !isNaN(options.travelSpeed)) {
      processJson.travel_speed = String(options.travelSpeed);
      logCallback(`Travel speed: ${options.travelSpeed} mm/s`);
    }

    const customProcessPath = path.join(tempDir, 'custom_process.json');
    fs.writeFileSync(customProcessPath, JSON.stringify(processJson, null, 2), 'utf-8');

    // Create custom filament profile to apply custom temperatures, volumetric limit, flow ratio, and cooling
    let effectiveFilamentPath = filamentProfile;
    try {
      const filamentRaw = fs.readFileSync(filamentProfile, 'utf-8');
      const filamentJson = JSON.parse(filamentRaw);
      let filamentModified = false;

      // Thermals (Subsequent & Initial Layer)
      if (options.nozzleTemp && !isNaN(options.nozzleTemp)) {
        filamentJson.nozzle_temperature = [String(options.nozzleTemp)];
        if (!options.nozzleTempInitialLayer) {
          filamentJson.nozzle_temperature_initial_layer = [String(options.nozzleTemp)];
        }
        filamentModified = true;
        logCallback(`Nozzle temperature: ${options.nozzleTemp}°C`);
      }
      if (options.nozzleTempInitialLayer && !isNaN(options.nozzleTempInitialLayer)) {
        filamentJson.nozzle_temperature_initial_layer = [String(options.nozzleTempInitialLayer)];
        filamentModified = true;
        logCallback(`Initial layer nozzle temperature: ${options.nozzleTempInitialLayer}°C`);
      }
      if (options.bedTemp && !isNaN(options.bedTemp)) {
        filamentJson.hot_plate_temp = [String(options.bedTemp)];
        filamentJson.cool_plate_temp = [String(options.bedTemp)];
        filamentJson.textured_plate_temp = [String(options.bedTemp)];
        if (!options.bedTempInitialLayer) {
          filamentJson.hot_plate_temp_initial_layer = [String(options.bedTemp)];
          filamentJson.cool_plate_temp_initial_layer = [String(options.bedTemp)];
          filamentJson.textured_plate_temp_initial_layer = [String(options.bedTemp)];
        }
        filamentModified = true;
        logCallback(`Bed temperature: ${options.bedTemp}°C`);
      }
      if (options.bedTempInitialLayer && !isNaN(options.bedTempInitialLayer)) {
        filamentJson.hot_plate_temp_initial_layer = [String(options.bedTempInitialLayer)];
        filamentJson.cool_plate_temp_initial_layer = [String(options.bedTempInitialLayer)];
        filamentJson.textured_plate_temp_initial_layer = [String(options.bedTempInitialLayer)];
        filamentModified = true;
        logCallback(`Initial layer bed temperature: ${options.bedTempInitialLayer}°C`);
      }

      // Flow & Dynamics
      if (options.maxVolumetricSpeed && !isNaN(options.maxVolumetricSpeed)) {
        filamentJson.filament_max_volumetric_speed = [String(options.maxVolumetricSpeed)];
        filamentModified = true;
        logCallback(`Max volumetric speed cap: ${options.maxVolumetricSpeed} mm³/s`);
      }
      if (options.flowRatio && !isNaN(options.flowRatio)) {
        filamentJson.filament_flow_ratio = [String(options.flowRatio)];
        filamentModified = true;
        logCallback(`Filament flow ratio: ${options.flowRatio}`);
      }
      if (options.retractionLength && !isNaN(options.retractionLength)) {
        filamentJson.filament_retraction_length = [String(options.retractionLength)];
        filamentModified = true;
        logCallback(`Retraction length: ${options.retractionLength} mm`);
      }

      // Fans & Cooling
      if (options.auxiliaryFanSpeed !== undefined && !isNaN(options.auxiliaryFanSpeed)) {
        filamentJson.additional_cooling_fan_speed = [String(options.auxiliaryFanSpeed)];
        filamentModified = true;
        logCallback(`Auxiliary cooling fan speed: ${options.auxiliaryFanSpeed}%`);
      }
      if (options.modelFanSpeed !== undefined && !isNaN(options.modelFanSpeed)) {
        filamentJson.fan_max_speed = [String(options.modelFanSpeed)];
        filamentJson.fan_min_speed = [String(Math.min(options.modelFanSpeed, 40))];
        filamentModified = true;
        logCallback(`Model part cooling fan speed: ${options.modelFanSpeed}%`);
      }
      if (options.closeFanFirstNLayers !== undefined && !isNaN(options.closeFanFirstNLayers)) {
        filamentJson.close_fan_the_first_x_layers = [String(options.closeFanFirstNLayers)];
        filamentModified = true;
        logCallback(`Disable cooling fan for first: ${options.closeFanFirstNLayers} layers`);
      }

      if (filamentModified) {
        const customFilamentPath = path.join(tempDir, 'custom_filament.json');
        fs.writeFileSync(customFilamentPath, JSON.stringify(filamentJson, null, 2), 'utf-8');
        effectiveFilamentPath = customFilamentPath;
      }
    } catch (err: any) {
      logCallback(`Notice: Could not generate custom filament profile: ${err.message}`);
    }

    const args: string[] = [
      '--load-settings',
      `${machineProfile};${customProcessPath}`,
      '--load-filaments',
      effectiveFilamentPath,
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
