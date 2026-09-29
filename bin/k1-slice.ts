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
import { startStudioServer } from '../src/server/app.js';

const program = new Command();

program
  .name('k1-slice')
  .description('High-performance CLI & 3D Plate Studio for Creality K1 3D Printers')
  .version('1.0.0')
  .argument('<files...>', 'Path to 3D model file(s) (.stl, .3mf, .obj)')
  .option('-p, --preset <preset>', 'Quality preset: standard (0.20mm), fine (0.12mm), optimal (0.16mm), draft (0.24mm)', 'standard')
  .option('-m, --material <material>', 'Filament preset: hyper-pla, pla, petg, abs, tpu', 'hyper-pla')
  .option('--infill <percent>', 'Infill density percentage (e.g. 20 for 20%)', (val) => parseInt(val, 10))
  .option('--infill-pattern <pattern>', 'Infill pattern: gyroid, grid, cubic, honeycomb, rectilinear, lightning', 'gyroid')
  .option('--layer-height <height>', 'Layer height in mm (e.g. 0.16)', (val) => parseFloat(val))
  .option('--supports', 'Enable support structures (default: auto)')
  .option('--no-supports', 'Explicitly disable support generation')
  .option('--support-type <type>', 'Support type: tree (organic) or normal', 'tree')
  .option('--brim <type>', 'Brim adhesion: auto, outer, inner_and_outer, none', 'auto')
  .option('--walls <count>', 'Number of wall loops / perimeters', (val) => parseInt(val, 10))
  .option('-o, --output <path>', 'Output .gcode file path (default: same directory as input model)')
  .option('-i, --preview', 'Open 3D interactive plate studio in browser')
  .option('--auto-center', 'Automatically center model at (110, 110) and ground bottom to Z=0', true)
  .option('--no-auto-center', 'Do not auto-center the model')
  .option('--auto-orient', 'Heuristically orient the model to maximize bed contact area')
  .option('--printer-ip <ip>', 'Creality K1 printer IP address to send G-code directly over LAN')
  .option('--print', 'Automatically start print immediately after uploading to printer')
  .option('--headless', 'Force headless slicing without launching browser even if boundary issues exist')
  .action(async (files: string[], options: any) => {
    try {
      const resolvedFiles = files.map((f) => path.resolve(process.cwd(), f));

      for (const f of resolvedFiles) {
        if (!fs.existsSync(f)) {
          console.error(`❌ Error: File not found: ${f}`);
          process.exit(1);
        }
      }

      console.log(`\n======================================================`);
      console.log(`  ⚡ CREALITY K1 SLICER ENGINE (OrcaSlicer Core)`);
      console.log(`  Bed Volume: 220 × 220 × 250 mm | Preset: ${options.preset}`);
      console.log(`======================================================\n`);

      // 1. Inspect geometry of first file
      const primaryFile = resolvedFiles[0];
      const isStl = primaryFile.toLowerCase().endsWith('.stl');
      let validation = isStl ? STLParser.validateForK1(primaryFile) : null;

      if (validation) {
        const bb = validation.boundingBox;
        console.log(`📦 Model Metrics: ${path.basename(primaryFile)}`);
        console.log(`   Dimensions : ${bb.width.toFixed(1)} × ${bb.depth.toFixed(1)} × ${bb.height.toFixed(1)} mm`);
        console.log(`   Position   : X [${bb.minX.toFixed(1)} to ${bb.maxX.toFixed(1)}], Y [${bb.minY.toFixed(1)} to ${bb.maxY.toFixed(1)}], Z [${bb.minZ.toFixed(1)} to ${bb.maxZ.toFixed(1)}]`);
        console.log(`   Triangles  : ${validation.triangleCount.toLocaleString()}`);

        // Check if dimension exceeds physical printer
        if (bb.width > K1_SPECS.bedWidth || bb.depth > K1_SPECS.bedDepth || bb.height > K1_SPECS.maxHeight) {
          console.error(`\n❌ ERROR: Model dimensions exceed physical K1 build volume (220×220×250 mm)!`);
          console.error(`   Model size: ${bb.width.toFixed(1)}×${bb.depth.toFixed(1)}×${bb.height.toFixed(1)} mm`);
          console.error(`   Please scale down the model in the 3D Plate Studio.\n`);
        }
      }

      // 2. Escalation check: Auto-open browser if --preview requested OR boundary issues detected
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
        await open(url);
        console.log(`(Press Ctrl+C to terminate the local studio session when finished)\n`);
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
        arrange: false, // Keep the centered/placed coordinates
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

      // Clean up temp centered file if generated
      if (tempAutoCenteredFile && fs.existsSync(tempAutoCenteredFile)) {
        try { fs.unlinkSync(tempAutoCenteredFile); } catch {}
      }

      // 5. Direct Network Upload & Print
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
