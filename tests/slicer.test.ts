import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { STLParser, K1_SPECS } from '../src/geometry/stl-parser.js';
import { AutoOrient } from '../src/geometry/auto-orient.js';
import { GcodeParser } from '../src/engine/gcode-parser.js';
import { OrcaWrapper } from '../src/engine/orca-wrapper.js';

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

  // Clean up
  [tmpTestStl, centeredStl, oversizedStl, outputGcode].forEach((f) => {
    try { fs.unlinkSync(f); } catch {}
  });

  console.log('\n🎉 ALL TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
