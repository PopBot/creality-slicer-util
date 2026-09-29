#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import open from 'open';
import { STLParser, K1_SPECS } from '../src/geometry/stl-parser.js';
import { AutoOrient } from '../src/geometry/auto-orient.js';
import { OrcaWrapper, SliceOptions } from '../src/engine/orca-wrapper.js';
import { K1PrinterClient } from '../src/printer/k1-client.js';
import { ConfigManager } from '../src/config/config-manager.js';
import { startStudioServer } from '../src/server/app.js';

const userConfig = ConfigManager.load();
const program = new Command();

program
  .name('k1-slice')
  .description('High-performance CLI & 3D Plate Studio for Creality K1 3D Printers')
  .version('1.0.0');

// 1. Studio command
program
  .command('studio [file]')
  .description('Open the interactive 3D Plate Studio in your default browser')
  .option('-p, --port <port>', 'Custom local port (default: 3125)', '3125')
  .action(async (file, opts) => {
    const modelPath = file ? path.resolve(process.cwd(), file) : undefined;
    const port = await startStudioServer(parseInt(opts.port, 10), modelPath);
    const url = modelPath ? `http://localhost:${port}/?model=${encodeURIComponent(modelPath)}` : `http://localhost:${port}/`;
    console.log(`\n⚡ Launching Creality K1 3D Plate Studio...`);
    console.log(`🚀 Live at: ${url}`);
    console.log(`(Press Ctrl+C to terminate the local studio session)\n`);
    await open(url);
  });

// 2. Config command
const configCmd = program.command('config').description('View and manage persistent slicer defaults');

configCmd
  .command('list', { isDefault: true })
  .description('List all saved configuration defaults')
  .action(() => {
    const config = ConfigManager.load();
    console.log('\n⚙️  Creality K1 Slicer Defaults (~/.k1-slicer/config.json):');
    console.log('──────────────────────────────────────────────────────');
    for (const [k, v] of Object.entries(config)) {
      console.log(`  ${k.padEnd(16)}: ${v}`);
    }
    console.log('──────────────────────────────────────────────────────\n');
  });

configCmd
  .command('set <key> <value>')
  .description('Set a default setting (e.g. "k1-slice config set printer-ip 192.168.1.100")')
  .action((key, value) => {
    const updated = ConfigManager.set(key, value);
    console.log(`\n✅ Saved default: ${key} = ${value}\n`);
  });

configCmd
  .command('get <key>')
  .description('Get the current value of a default setting')
  .action((key) => {
    const val = ConfigManager.get(key);
    console.log(`${val}`);
  });

configCmd
  .command('reset')
  .description('Reset all defaults to factory settings')
  .action(() => {
    ConfigManager.reset();
    console.log('\n🔄 Configuration reset to factory defaults.\n');
  });

// 3. Main Slice command (root action)
program
  .argument('[files...]', 'Path to 3D model file(s) (.stl, .3mf, .obj)')
  .option('-p, --preset <preset>', 'Quality preset: standard (0.20mm), fine (0.12mm), optimal (0.16mm), draft (0.24mm)', userConfig.preset || 'standard')
  .option('-m, --material <material>', 'Filament preset: hyper-pla, pla, petg, abs, tpu', userConfig.material || 'hyper-pla')
  .option('--infill <percent>', 'Infill density percentage (e.g. 20 for 20%)', (val) => parseInt(val, 10), userConfig.infill || 20)
  .option('--infill-pattern <pattern>', 'Infill pattern: gyroid, grid, cubic, honeycomb, rectilinear, lightning', userConfig.infillPattern || 'gyroid')
  .option('--layer-height <height>', 'Layer height in mm (e.g. 0.16)', (val) => parseFloat(val))
  .option('--supports', 'Enable support structures', userConfig.supports ?? true)
  .option('--no-supports', 'Explicitly disable support generation')
  .option('--support-type <type>', 'Support type: tree (organic) or normal', userConfig.supportType || 'tree')
  .option('--brim <type>', 'Brim adhesion: auto, outer, inner_and_outer, none', userConfig.brim || 'auto')
  .option('--walls <count>', 'Number of wall loops / perimeters', (val) => parseInt(val, 10), userConfig.walls || 3)
  .option('-o, --output <path>', 'Output .gcode file path (default: same directory as input model)')
  .option('-i, --preview', 'Open 3D interactive plate studio in browser')
  .option('--auto-center', 'Automatically center model at (110, 110) and ground bottom to Z=0', userConfig.autoCenter ?? true)
  .option('--no-auto-center', 'Do not auto-center the model')
  .option('--auto-orient', 'Heuristically orient the model to maximize bed contact area')
  .option('--unit <unit>', 'Measurement unit: inches or mm (default: inches)', userConfig.unit || 'inches')
  .option('--printer-ip <ip>', 'Creality K1 printer IP address to send G-code directly over LAN', userConfig.printerIp)
  .option('--print', 'Automatically start print immediately after uploading to printer')
  .option('--headless', 'Force headless slicing without launching browser even if boundary issues exist')
  .action(async (files: string[], options: any) => {
    try {
      // If no files are passed, open the 3D Plate Studio!
      if (!files || files.length === 0) {
        console.log(`\n⚡ No model specified — launching Creality K1 3D Plate Studio...`);
        const port = await startStudioServer(3125);
        const url = `http://localhost:${port}/`;
        console.log(`🚀 Live at: ${url}`);
        console.log(`(Press Ctrl+C to terminate the local studio session when finished)\n`);
        await open(url);
        return;
      }

      const resolvedFiles = files.map((f) => path.resolve(process.cwd(), f));

      for (const f of resolvedFiles) {
        if (!fs.existsSync(f)) {
          console.error(`❌ Error: File not found: ${f}`);
          process.exit(1);
        }
      }

      const isInch = (options.unit || 'inches').toLowerCase() === 'inches';
      const toIn = (mm: number) => (mm / 25.4).toFixed(2);

      console.log(`\n======================================================`);
      console.log(`  ⚡ CREALITY K1 SLICER ENGINE (OrcaSlicer Core)`);
      console.log(`  Bed Volume: 8.66 × 8.66 × 9.84 in (220 × 220 × 250 mm)`);
      console.log(`  Preset    : ${options.preset} | Default Unit: ${options.unit}`);
      console.log(`======================================================\n`);

      // 1. Inspect geometry of first file
      const primaryFile = resolvedFiles[0];
      const isStl = primaryFile.toLowerCase().endsWith('.stl');
      let validation = isStl ? STLParser.validateForK1(primaryFile) : null;

      if (validation) {
        const bb = validation.boundingBox;
        console.log(`📦 Model Metrics: ${path.basename(primaryFile)}`);
        if (isInch) {
          console.log(`   Dimensions : ${toIn(bb.width)} × ${toIn(bb.depth)} × ${toIn(bb.height)} in (${bb.width.toFixed(1)} × ${bb.depth.toFixed(1)} × ${bb.height.toFixed(1)} mm)`);
          console.log(`   Position   : X [${toIn(bb.minX)} to ${toIn(bb.maxX)} in], Y [${toIn(bb.minY)} to ${toIn(bb.maxY)} in], Z [${toIn(bb.minZ)} to ${toIn(bb.maxZ)} in]`);
        } else {
          console.log(`   Dimensions : ${bb.width.toFixed(1)} × ${bb.depth.toFixed(1)} × ${bb.height.toFixed(1)} mm`);
          console.log(`   Position   : X [${bb.minX.toFixed(1)} to ${bb.maxX.toFixed(1)} mm], Y [${bb.minY.toFixed(1)} to ${bb.maxY.toFixed(1)} mm], Z [${bb.minZ.toFixed(1)} to ${bb.maxZ.toFixed(1)} mm]`);
        }
        console.log(`   Triangles  : ${validation.triangleCount.toLocaleString()}`);

        if (bb.width > K1_SPECS.bedWidth || bb.depth > K1_SPECS.bedDepth || bb.height > K1_SPECS.maxHeight) {
          console.error(`\n❌ ERROR: Model dimensions exceed physical K1 build volume (8.66×8.66×9.84 in / 220×220×250 mm)!`);
          console.error(`   Model size: ${toIn(bb.width)}×${toIn(bb.depth)}×${toIn(bb.height)} in (${bb.width.toFixed(1)}×${bb.depth.toFixed(1)}×${bb.height.toFixed(1)} mm)`);
          console.error(`   Please scale down the model in the 3D Plate Studio.\n`);
        }
      }

      // 2. Escalation check
      const hasIssues = validation && !validation.valid;
      const shouldLaunchBrowser = options.preview || (hasIssues && !options.headless);

      if (shouldLaunchBrowser) {
        if (hasIssues && !options.preview) {
          console.warn(`\n⚠️  Model Placement Issues Detected:`);
          validation?.issues.forEach((issue) => console.warn(`   • ${issue}`));
          console.log(`\n🌐 Launching 3D Plate Studio in your browser to adjust position & orientation...`);
        } else {
          console.log(`\n🌐 Launching 3D Plate Studio in your browser...`);
        }

        const port = await startStudioServer(3125, primaryFile);
        const url = `http://localhost:${port}/?model=${encodeURIComponent(primaryFile)}`;
        console.log(`🚀 Plate Studio live at: ${url}`);
        console.log(`(Press Ctrl+C to terminate the local studio session when finished)\n`);
        await open(url);
        return;
      }

      // 3. Process geometry for headless slicing
      let filesToSlice = resolvedFiles;
      let tempAutoCenteredFile: string | null = null;

      if (options.autoCenter && isStl) {
        console.log(`🎯 Auto-centering model at (110, 110) and grounding to Z=0...`);
        tempAutoCenteredFile = path.join(os.tmpdir(), `k1_centered_${Date.now()}_${path.basename(primaryFile)}`);
        STLParser.autoCenterAndGround(primaryFile, tempAutoCenteredFile);
        filesToSlice = [tempAutoCenteredFile, ...resolvedFiles.slice(1)];
      }

      // 4. Run Slicing Pipeline
      const finalOutputPath = options.output
        ? path.resolve(process.cwd(), options.output)
        : primaryFile.replace(/\.(stl|obj|3mf)$/i, '.gcode');

      const sliceOpts: SliceOptions = {
        preset: options.preset,
        material: options.material,
        infill: options.infill,
        infillPattern: options.infillPattern,
        layerHeight: options.layerHeight,
        supports: options.supports,
        supportType: options.supportType,
        brim: options.brim,
        walls: options.walls,
        arrange: false,
        outputGcodePath: finalOutputPath,
        onLog: (msg) => {
          if (process.env.DEBUG) console.log(msg.trim());
        },
      };

      console.log(`🔪 Slicing with Creality K1 profiles...`);
      const startTime = Date.now();
      const stats = await OrcaWrapper.slice(filesToSlice, sliceOpts);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`\n✅ SLICING COMPLETE in ${elapsed}s!`);
      console.log(`──────────────────────────────────────────────────────`);
      console.log(`  ⏱️  Est. Print Time : ${stats.estimatedTimeStr}`);
      console.log(`  🧵 Filament Used   : ${stats.filamentUsedMeters.toFixed(2)} m (${stats.filamentUsedGrams} g)`);
      console.log(`  🥞 Layer Count     : ${stats.totalLayers} layers`);
      console.log(`  📏 Max Z Height    : ${stats.maxZHeight.toFixed(2)} mm`);
      console.log(`  💾 Output G-Code   : ${stats.gcodePath} (${(stats.fileSizeBytes / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`──────────────────────────────────────────────────────\n`);

      if (tempAutoCenteredFile && fs.existsSync(tempAutoCenteredFile)) {
        try { fs.unlinkSync(tempAutoCenteredFile); } catch {}
      }

      // 5. Direct Network Upload
      if (options.printerIp) {
        console.log(`📡 Uploading G-code to Creality K1 at ${options.printerIp}...`);
        const client = new K1PrinterClient(options.printerIp);
        const result = await client.uploadAndPrint(stats.gcodePath, !!options.print);
        console.log(`🎉 ${result.message}\n`);
      } else {
        console.log(`💡 Tip: To send directly to your K1 next time, pass '--printer-ip <IP>'.`);
      }
    } catch (err: any) {
      console.error(`\n❌ Slicing Failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program.parse();
