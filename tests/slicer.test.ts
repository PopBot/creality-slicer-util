import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { STLParser, K1_SPECS } from '../src/geometry/stl-parser.js';
import { AutoOrient } from '../src/geometry/auto-orient.js';
import { GcodeParser } from '../src/engine/gcode-parser.js';
import { OrcaWrapper, parseSpeed } from '../src/engine/orca-wrapper.js';
import { ConfigManager } from '../src/config/config-manager.js';
import { K1PrinterClient } from '../src/printer/k1-client.js';

// Helper to generate test STL
function createBoxStl(filename: string, ox: number, oy: number, oz: number, w: number, d: number, h: number) {
  const triangles = [
    // bottom
    ([ox,oy,oz]), ([ox+w,oy,oz]), ([ox+w,oy+d,oz]),
    ([ox,oy,oz]), ([ox+w,oy+d,oz]), ([ox,oy+d,oz]),
    // top
    ([ox,oy,oz+h]), ([ox+w,oy+d,oz+h]), ([ox+w,oy,oz+h]),
    ([ox,oy,oz+h]), ([ox,oy+d,oz+h]), ([ox+w,oy+d,oz+h]),
    // front
    ([ox,oy,oz]), ([ox+w,oy,oz+h]), ([ox+w,oy,oz]),
    ([ox,oy,oz]), ([ox,oy,oz+h]), ([ox+w,oy,oz+h]),
    // back
    ([ox,oy+d,oz]), ([ox+w,oy+d,oz]), ([ox+w,oy+d,oz+h]),
    ([ox,oy+d,oz]), ([ox+w,oy+d,oz+h]), ([ox,oy+d,oz+h]),
    // left
    ([ox,oy,oz]), ([ox,oy,oz+h]), ([ox,oy+d,oz+h]),
    ([ox,oy,oz]), ([ox,oy+d,oz+h]), ([ox,oy+d,oz]),
    // right
    ([ox+w,oy,oz]), ([ox+w,oy+d,oz]), ([ox+w,oy+d,oz+h]),
    ([ox+w,oy,oz]), ([ox+w,oy+d,oz+h]), ([ox+w,oy,oz+h]),
  ];

  const buf = Buffer.alloc(84 + 12 * 50);
  buf.writeUInt32LE(12, 80);
  let offset = 84;
  for (let i = 0; i < triangles.length; i += 3) {
    offset += 12; // skip normal
    for (let v = 0; v < 3; v++) {
      const vert = triangles[i + v];
      buf.writeFloatLE(vert[0], offset);
      buf.writeFloatLE(vert[1], offset + 4);
      buf.writeFloatLE(vert[2], offset + 8);
      offset += 12;
    }
    offset += 2; // attr
  }
  fs.writeFileSync(filename, buf);
}

async function runTests() {
  console.log('🧪 Running Creality K1 Slicer Util Test Suite...\n');

  const tmpTestStl = '/tmp/test_runner_box.stl';
  createBoxStl(tmpTestStl, 10, 20, 0, 30, 40, 50);

  // Test 1: STL Parsing & Metrics
  console.log('1. Testing STLParser metrics...');
  const { boundingBox, triangleCount } = STLParser.parse(tmpTestStl);
  assert.strictEqual(triangleCount, 12, 'Should have 12 triangles');
  assert.strictEqual(boundingBox.width, 30, 'Width should be 30');
  assert.strictEqual(boundingBox.depth, 40, 'Depth should be 40');
  assert.strictEqual(boundingBox.height, 50, 'Height should be 50');
  console.log('   ✓ STLParser accurately parsed dimensions');

  // Test 2: Auto-Center & Grounding
  console.log('2. Testing AutoCenter and Grounding...');
  const centeredStl = '/tmp/test_runner_centered.stl';
  const centeredBB = STLParser.autoCenterAndGround(tmpTestStl, centeredStl);
  assert.strictEqual(centeredBB.centerX, K1_SPECS.centerX, 'Center X should be 110');
  assert.strictEqual(centeredBB.centerY, K1_SPECS.centerY, 'Center Y should be 110');
  assert.strictEqual(centeredBB.minZ, 0, 'Min Z should be 0');
  assert.strictEqual(centeredBB.height, 50, 'Height should be preserved');
  console.log('   ✓ AutoCenter perfectly centered mesh at (110, 110, 0)');

  // Test 3: Boundary Validation
  console.log('3. Testing K1 Build Volume Boundary Validation...');
  const validResult = STLParser.validateForK1(centeredStl);
  assert.strictEqual(validResult.valid, true, 'Centered box should be valid');
  assert.strictEqual(validResult.issues.length, 0, 'No issues expected');

  // Test oversized model
  const oversizedStl = '/tmp/test_runner_oversized.stl';
  createBoxStl(oversizedStl, 0, 0, 0, 250, 100, 100);
  const oversizedResult = STLParser.validateForK1(oversizedStl);
  assert.strictEqual(oversizedResult.valid, false, 'Oversized model should fail');
  assert.ok(oversizedResult.issues[0].includes('exceeds K1 bed width'), 'Should flag bed width');
  console.log('   ✓ Boundary validation catches out-of-bounds models');

  // Test 4: Auto-Orientation Heuristic
  console.log('4. Testing AutoOrient Heuristic...');
  const bestNormal = AutoOrient.findBestOrientation(tmpTestStl);
  assert.ok(Array.isArray(bestNormal) && bestNormal.length === 3, 'Returns 3D normal vector');
  console.log(`   ✓ Best resting normal detected: [${bestNormal.map(n => n.toFixed(2)).join(', ')}]`);

  // Test 5: End-to-End Slicing with OrcaWrapper
  console.log('5. Testing End-to-End Slicing Pipeline with Creality K1 Profiles...');
  const outputGcode = '/tmp/test_runner.gcode';
  const stats = await OrcaWrapper.slice([centeredStl], {
    preset: 'standard',
    material: 'hyper-pla',
    infill: 15,
    infillPattern: 'gyroid',
    supports: false,
    outputGcodePath: outputGcode,
  });

  assert.ok(fs.existsSync(outputGcode), 'Output G-code should exist');
  assert.ok(stats.totalLayers > 0, 'Total layers should be > 0');
  assert.ok(stats.filamentUsedMeters > 0, 'Filament meters should be > 0');
  assert.ok(stats.estimatedTimeStr !== 'Unknown', 'Estimated time should be parsed');
  console.log(`   ✓ Sliced successfully: ${stats.totalLayers} layers, est time: ${stats.estimatedTimeStr}, filament: ${stats.filamentUsedMeters.toFixed(2)}m`);

  // Test 6: Speed Parsing Logic
  console.log('6. Testing Speed Parser (Percentages, mm/s, and Named K1 Modes)...');
  const silentInfo = parseSpeed('silent');
  assert.strictEqual(silentInfo?.factor, 0.5);
  assert.strictEqual(silentInfo?.targetSpeedMmS, 150);

  const sportInfo = parseSpeed('sport');
  assert.strictEqual(sportInfo?.factor, 1.25);
  assert.strictEqual(sportInfo?.targetSpeedMmS, 375);

  const pctInfo = parseSpeed('80%');
  assert.strictEqual(pctInfo?.factor, 0.8);
  assert.strictEqual(pctInfo?.targetSpeedMmS, 240);

  const mmsInfo = parseSpeed('250mm/s');
  assert.strictEqual(mmsInfo?.targetSpeedMmS, 250);
  assert.strictEqual(Math.round(mmsInfo?.factor * 300), 250);

  const numMmsInfo = parseSpeed('200');
  assert.strictEqual(numMmsInfo?.targetSpeedMmS, 200);
  console.log('   ✓ Speed parser correctly handles modes, %, and mm/s inputs');

  // Test 7: ConfigManager Speed Persistence
  console.log('7. Testing ConfigManager Speed Persistence...');
  ConfigManager.set('speed', '250mm/s');
  assert.strictEqual(ConfigManager.get('speed'), '250mm/s');
  ConfigManager.set('speed', '80%');
  assert.strictEqual(ConfigManager.get('speed'), '80%');
  ConfigManager.set('speed', '100%'); // restore standard
  console.log('   ✓ ConfigManager properly persists and retrieves speed setting');

  // Test 8: Slicing with Custom Speed Override
  console.log('8. Testing Slicing with Custom Speed Overrides (Silent 50% & Custom mm/s)...');
  const silentGcode = '/tmp/test_runner_silent.gcode';
  const silentStats = await OrcaWrapper.slice([centeredStl], {
    preset: 'standard',
    material: 'hyper-pla',
    infill: 15,
    speed: 'silent',
    supports: false,
    outputGcodePath: silentGcode,
  });
  // Test 9: Custom Print/Job Name Slicing and Output Path
  console.log('9. Testing Custom Job / Print Naming...');
  const customNamedGcode = '/tmp/custom_battery_box.gcode';
  const customStats = await OrcaWrapper.slice([centeredStl], {
    preset: 'standard',
    outputGcodePath: customNamedGcode,
  });
  assert.ok(fs.existsSync(customNamedGcode), 'Custom named G-code should exist');
  assert.strictEqual(path.basename(customStats.gcodePath), 'custom_battery_box.gcode');
  console.log('   ✓ Custom output file naming correctly produces designated .gcode');

  // Test 10: K1PrinterClient Creality OS connection
  console.log('10. Testing K1PrinterClient Connection & Status...');
  const client = new K1PrinterClient('192.168.1.145');
  const status = await client.getStatus();
  assert.ok(status.connected, 'Printer at 192.168.1.145 should report connected');
  assert.ok(status.extruderTemp !== undefined, 'Should report extruder temperature');
  assert.ok(status.bedTemp !== undefined, 'Should report bed temperature');
  console.log(`   ✓ K1 connected via Creality OS: Extruder: ${status.extruderTemp}°C, Bed: ${status.bedTemp}°C, State: ${status.state}`);

  // Clean up
  [tmpTestStl, centeredStl, oversizedStl, outputGcode, silentGcode, customNamedGcode].forEach((f) => {
    try { fs.unlinkSync(f); } catch {}
  });

  console.log('\n🎉 ALL TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
