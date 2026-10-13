import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

// K1 Physical Specifications
const BED_SIZE_X = 220;
const BED_SIZE_Y = 220;
const MAX_HEIGHT_Z = 250;
const BED_CENTER_X = BED_SIZE_X / 2;
const BED_CENTER_Y = BED_SIZE_Y / 2;

// App State
let scene, camera, renderer, orbitControls, transformControls;
let currentUnit = 'inches'; // default to inches as requested
let models = [];
let selectedModel = null;
let layFlatMode = false;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

export function formatDim(mmVal) {
  if (currentUnit === 'inches') {
    return `${(mmVal / 25.4).toFixed(2)} in`;
  }
  return `${mmVal.toFixed(1)} mm`;
}

// Materials
const matNormal = new THREE.MeshStandardMaterial({
  color: 0x00d285,
  roughness: 0.35,
  metalness: 0.15,
});

const matOutOfBounds = new THREE.MeshStandardMaterial({
  color: 0xff4757,
  emissive: 0x550011,
  roughness: 0.4,
  metalness: 0.1,
});

const matSelected = new THREE.MeshStandardMaterial({
  color: 0x00a8ff,
  roughness: 0.35,
  metalness: 0.15,
});

init();

function init() {
  const container = document.getElementById('canvas-container');

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12141a);

  // Camera - 360 degree freedom
  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 3000);
  camera.position.set(110, -220, 280);
  camera.up.set(0, 0, 1); // Z is UP in 3D printing

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  // OrbitControls
  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(BED_CENTER_X, BED_CENTER_Y, 0);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.05;
  // Full 360 degree rotation freedom in all directions
  orbitControls.minPolarAngle = 0;
  orbitControls.maxPolarAngle = Math.PI;

  // Transform Controls
  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.size = 0.8;
  transformControls.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value;
  });
  transformControls.addEventListener('change', () => {
    checkBoundaries();
  });
  scene.add(transformControls.getHelper());

  // Lights
  setupLighting();

  // K1 Build Plate & Bounding Cage
  setupBuildPlate();

  // Window Resize
  window.addEventListener('resize', onWindowResize);

  // Canvas Click for Raycasting (Selection, Lay-Flat & Orientation Gizmo)
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);

  // Setup UI Listeners
  setupUI();

  // Auto-load initial model from server if query param or session provided
  checkInitialServerModel();

  // Animation Loop
  animate();
}

function setupLighting() {
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
  dir1.position.set(110, -150, 400);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0x70a1ff, 0.5);
  dir2.position.set(110, 350, 200);
  scene.add(dir2);
}

function setupBuildPlate() {
  // Grid on XY plane (Z = 0)
  const gridHelper = new THREE.GridHelper(BED_SIZE_X, 22, 0x00d285, 0x2c354a);
  gridHelper.position.set(BED_CENTER_X, BED_CENTER_Y, 0);
  gridHelper.rotation.x = Math.PI / 2; // Lie flat on XY
  scene.add(gridHelper);

  // Bed plate surface geometry
  const plateGeo = new THREE.PlaneGeometry(BED_SIZE_X, BED_SIZE_Y);
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0x181c26,
    roughness: 0.9,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  const plateMesh = new THREE.Mesh(plateGeo, plateMat);
  plateMesh.position.set(BED_CENTER_X, BED_CENTER_Y, -0.1);
  scene.add(plateMesh);

  // K1 Bounding Envelope Wireframe (220 x 220 x 250)
  const boxGeo = new THREE.BoxGeometry(BED_SIZE_X, BED_SIZE_Y, MAX_HEIGHT_Z);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x3f4b66, transparent: true, opacity: 0.4 });
  const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(boxGeo), wireMat);
  wireframe.position.set(BED_CENTER_X, BED_CENTER_Y, MAX_HEIGHT_Z / 2);
  scene.add(wireframe);

  // Center crosshair
  const crossMat = new THREE.LineBasicMaterial({ color: 0x00a8ff });
  const crossGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(BED_CENTER_X - 10, BED_CENTER_Y, 0.1),
    new THREE.Vector3(BED_CENTER_X + 10, BED_CENTER_Y, 0.1),
    new THREE.Vector3(BED_CENTER_X, BED_CENTER_Y - 10, 0.1),
    new THREE.Vector3(BED_CENTER_X, BED_CENTER_Y + 10, 0.1),
  ]);
  const crosshair = new THREE.LineSegments(crossGeo, crossMat);
  scene.add(crosshair);
}

function onWindowResize() {
  const container = document.getElementById('canvas-container');
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  orbitControls.update();
  renderer.render(scene, camera);
}

// ----------------- Model Management -----------------

export function loadSTLFromBuffer(buffer, filename = 'model.stl') {
  const loader = new STLLoader();
  const geometry = loader.parse(buffer);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, matNormal.clone());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { filename, originalGeometry: geometry.clone() };

  scene.add(mesh);
  models.push(mesh);

  // Auto center & drop to bed initially
  centerModel(mesh);
  dropModelToBed(mesh);
  selectModel(mesh);
  updateModelListUI();
  checkBoundaries();

  const txtJobName = document.getElementById('txtJobName');
  if (txtJobName && (!txtJobName.value || txtJobName.value === '')) {
    txtJobName.value = filename.replace(/\.(stl|obj|3mf)$/i, '');
  }
}

function selectModel(mesh) {
  if (selectedModel && selectedModel !== mesh) {
    selectedModel.material = matNormal;
  }
  selectedModel = mesh;
  if (mesh) {
    transformControls.attach(mesh);
  } else {
    transformControls.detach();
  }
  checkBoundaries();
}

function centerModel(mesh) {
  if (!mesh) return;
  mesh.geometry.computeBoundingBox();
  const box = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  box.getCenter(center);

  mesh.position.x += (BED_CENTER_X - center.x);
  mesh.position.y += (BED_CENTER_Y - center.y);
  checkBoundaries();
}

function dropModelToBed(mesh) {
  if (!mesh) return;
  const box = new THREE.Box3().setFromObject(mesh);
  mesh.position.z -= box.min.z;
  checkBoundaries();
}

// ----------------- Out of Bounds Detection -----------------

function checkBoundaries() {
  const banner = document.getElementById('boundaryBanner');
  const bannerText = document.getElementById('boundaryText');
  const btnSlice = document.getElementById('btnSlice');
  const btnSliceAndPrint = document.getElementById('btnSliceAndPrint');

  if (models.length === 0) {
    banner.className = 'boundary-banner valid';
    bannerText.textContent = 'Ready: Load a 3D model onto the build plate';
    btnSlice.disabled = true;
    btnSliceAndPrint.disabled = true;
    return;
  }

  let allValid = true;
  const issues = [];

  for (const m of models) {
    const box = new THREE.Box3().setFromObject(m);
    let modelValid = true;

    // Check XY boundaries [0, 220]
    if (box.min.x < 0 || box.max.x > BED_SIZE_X) {
      modelValid = false;
      issues.push(`Extends past X boundary (0–${formatDim(BED_SIZE_X)})`);
    }
    if (box.min.y < 0 || box.max.y > BED_SIZE_Y) {
      modelValid = false;
      issues.push(`Extends past Y boundary (0–${formatDim(BED_SIZE_Y)})`);
    }

    // Check Z grounding & max height
    if (box.min.z < -0.1) {
      modelValid = false;
      issues.push(`Penetrates below bed surface (${formatDim(box.min.z)})`);
    } else if (box.min.z > 0.5) {
      modelValid = false;
      issues.push(`Floating above bed (${formatDim(box.min.z)})`);
    }

    if (box.max.z > MAX_HEIGHT_Z) {
      modelValid = false;
      issues.push(`Exceeds max Z height of ${formatDim(MAX_HEIGHT_Z)}`);
    }

    // Update material
    if (!modelValid) {
      m.material = matOutOfBounds;
      allValid = false;
    } else {
      m.material = (m === selectedModel) ? matSelected : matNormal;
    }
  }

  if (allValid) {
    banner.className = 'boundary-banner valid';
    banner.querySelector('.status-icon').textContent = '✓';
    const bedDesc = currentUnit === 'inches' ? '8.66×8.66×9.84 in' : '220×220×250 mm';
    bannerText.textContent = `Model placed within K1 build envelope (${bedDesc})`;
    btnSlice.disabled = false;
    btnSliceAndPrint.disabled = !document.getElementById('txtPrinterIp').value.trim();
  } else {
    banner.className = 'boundary-banner invalid';
    banner.querySelector('.status-icon').textContent = '⚠️';
    bannerText.textContent = issues.slice(0, 2).join(' | ');
    btnSlice.disabled = false; // allow forced slicing or prompt
    btnSliceAndPrint.disabled = true;
  }
}

// ----------------- Lay Flat on Click & Auto Orient -----------------

function onCanvasPointerDown(event) {
  const container = document.getElementById('canvas-container');
  const rect = container.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  if (layFlatMode && selectedModel) {
    const intersects = raycaster.intersectObject(selectedModel, false);
    if (intersects.length > 0) {
      const hit = intersects[0];
      if (hit.face) {
        // Intersected triangle normal in world coordinates
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(selectedModel.matrixWorld);
        const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();

        // Target: point normal directly downwards (0, 0, -1) to touch bed
        const targetDown = new THREE.Vector3(0, 0, -1);
        const rotQuaternion = new THREE.Quaternion().setFromUnitVectors(worldNormal, targetDown);

        // Apply rotation to mesh
        selectedModel.applyQuaternion(rotQuaternion);
        selectedModel.updateMatrixWorld(true);

        dropModelToBed(selectedModel);
        centerModel(selectedModel);

        // Turn off lay-flat mode
        layFlatMode = false;
        document.getElementById('btnLayFlat').classList.remove('active');
        return;
      }
    }
  }

  // Model selection check
  const hits = raycaster.intersectObjects(models, false);
  if (hits.length > 0) {
    selectModel(hits[0].object);
  }
}

function autoOrientModel(mesh) {
  if (!mesh) return;
  // Sample triangles and find normal with highest coplanar area
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const count = pos.count / 3;

  const normalMap = new Map();

  for (let i = 0; i < count; i++) {
    const vA = new THREE.Vector3().fromBufferAttribute(pos, i * 3);
    const vB = new THREE.Vector3().fromBufferAttribute(pos, i * 3 + 1);
    const vC = new THREE.Vector3().fromBufferAttribute(pos, i * 3 + 2);

    const cb = new THREE.Vector3().subVectors(vC, vB);
    const ab = new THREE.Vector3().subVectors(vA, vB);
    const cross = new THREE.Vector3().crossVectors(cb, ab);
    const area = cross.length() * 0.5;
    const normal = cross.normalize();

    // Quantize
    const key = `${Math.round(normal.x * 10) / 10},${Math.round(normal.y * 10) / 10},${Math.round(normal.z * 10) / 10}`;
    normalMap.set(key, (normalMap.get(key) || { normal, area: 0 }));
    normalMap.get(key).area += area;
  }

  let best = null;
  for (const entry of normalMap.values()) {
    if (!best || entry.area > best.area) {
      best = entry;
    }
  }

  if (best) {
    const worldNormal = best.normal.clone().applyQuaternion(mesh.quaternion).normalize();
    const rot = new THREE.Quaternion().setFromUnitVectors(worldNormal, new THREE.Vector3(0, 0, -1));
    mesh.applyQuaternion(rot);
    mesh.updateMatrixWorld(true);
    dropModelToBed(mesh);
    centerModel(mesh);
  }
}

// ----------------- UI Controls Setup -----------------

function setupUI() {
  // Views
  document.getElementById('btnViewIso').onclick = () => {
    camera.position.set(110, -220, 280);
    orbitControls.target.set(BED_CENTER_X, BED_CENTER_Y, 0);
  };
  document.getElementById('btnViewTop').onclick = () => {
    camera.position.set(BED_CENTER_X, BED_CENTER_Y, 500);
    orbitControls.target.set(BED_CENTER_X, BED_CENTER_Y, 0);
  };
  document.getElementById('btnViewFront').onclick = () => {
    camera.position.set(BED_CENTER_X, -300, 100);
    orbitControls.target.set(BED_CENTER_X, BED_CENTER_Y, 50);
  };
  document.getElementById('btnViewRight').onclick = () => {
    camera.position.set(450, BED_CENTER_Y, 100);
    orbitControls.target.set(BED_CENTER_X, BED_CENTER_Y, 50);
  };

  // Transform Modes
  const btnT = document.getElementById('btnModeTranslate');
  const btnR = document.getElementById('btnModeRotate');
  const btnS = document.getElementById('btnModeScale');

  btnT.onclick = () => {
    transformControls.setMode('translate');
    [btnT, btnR, btnS].forEach(b => b.classList.remove('active'));
    btnT.classList.add('active');
  };
  btnR.onclick = () => {
    transformControls.setMode('rotate');
    [btnT, btnR, btnS].forEach(b => b.classList.remove('active'));
    btnR.classList.add('active');
  };
  btnS.onclick = () => {
    transformControls.setMode('scale');
    [btnT, btnR, btnS].forEach(b => b.classList.remove('active'));
    btnS.classList.add('active');
  };

  // Arrangement
  document.getElementById('btnAutoCenter').onclick = () => {
    if (selectedModel) centerModel(selectedModel);
  };
  document.getElementById('btnDropToBed').onclick = () => {
    if (selectedModel) dropModelToBed(selectedModel);
  };
  document.getElementById('btnLayFlat').onclick = () => {
    layFlatMode = !layFlatMode;
    document.getElementById('btnLayFlat').classList.toggle('active', layFlatMode);
    if (layFlatMode) {
      alert('Click-to-Lay-Flat: Click on any surface/triangle of the model to align it flat on the bed!');
    }
  };
  document.getElementById('btnAutoOrient').onclick = () => {
    if (selectedModel) autoOrientModel(selectedModel);
  };

  // Rotations
  document.getElementById('btnRotX90').onclick = () => rotateSelected(Math.PI / 2, 0, 0);
  document.getElementById('btnRotY90').onclick = () => rotateSelected(0, Math.PI / 2, 0);
  document.getElementById('btnRotZ90').onclick = () => rotateSelected(0, 0, Math.PI / 2);

  // File Input
  const fileInput = document.getElementById('fileInput');
  fileInput.onchange = (e) => {
    const files = e.target.files;
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = (event) => {
        loadSTLFromBuffer(event.target.result, f.name);
      };
      reader.readAsArrayBuffer(f);
    }
  };

  // Infill Slider
  const rangeInfill = document.getElementById('rangeInfill');
  const infillVal = document.getElementById('infillVal');
  rangeInfill.oninput = () => {
    infillVal.textContent = `${rangeInfill.value}%`;
  };

  // Supports checkbox
  document.getElementById('chkSupports').onchange = (e) => {
    document.getElementById('supportOptions').style.display = e.target.checked ? 'block' : 'none';
  };

  // Speed controls
  const selSpeed = document.getElementById('selSpeed');
  const txtCustomSpeed = document.getElementById('txtCustomSpeed');
  if (selSpeed) {
    selSpeed.onchange = () => {
      if (selSpeed.value === 'custom') {
        txtCustomSpeed.style.display = 'block';
        txtCustomSpeed.focus();
      } else {
        txtCustomSpeed.style.display = 'none';
      }
      updateSpeedBadge();
    };
  }
  if (txtCustomSpeed) {
    txtCustomSpeed.oninput = updateSpeedBadge;
  }

  // Material change -> auto-adapt recommended speed
  const selMaterial = document.getElementById('selMaterial');
  if (selMaterial) {
    selMaterial.onchange = () => {
      if (selMaterial.value === 'ender-pla') {
        if (selSpeed) selSpeed.value = '60mm/s';
        if (txtCustomSpeed) txtCustomSpeed.style.display = 'none';
        updateSpeedBadge();
      } else if (selMaterial.value === 'hyper-pla') {
        if (selSpeed) selSpeed.value = '100%';
        if (txtCustomSpeed) txtCustomSpeed.style.display = 'none';
        updateSpeedBadge();
      }
    };
  }

  // Unit toggle buttons
  const btnUnitInches = document.getElementById('btnUnitInches');
  const btnUnitMm = document.getElementById('btnUnitMm');
  if (btnUnitInches) btnUnitInches.onclick = () => setUnit('inches');
  if (btnUnitMm) btnUnitMm.onclick = () => setUnit('mm');

  // Save Defaults Button
  const btnSaveDefaults = document.getElementById('btnSaveDefaults');
  if (btnSaveDefaults) {
    btnSaveDefaults.onclick = async () => {
      const payload = {
        preset: document.getElementById('selPreset').value,
        material: document.getElementById('selMaterial').value,
        infill: parseInt(document.getElementById('rangeInfill').value, 10),
        infillPattern: document.getElementById('selInfillPattern').value,
        walls: parseInt(document.getElementById('numWalls').value, 10),
        brim: document.getElementById('selBrim').value,
        supports: document.getElementById('chkSupports').checked,
        supportType: document.getElementById('selSupportType').value,
        speed: getSelectedSpeed(),
        printerIp: document.getElementById('txtPrinterIp').value.trim(),
        unit: currentUnit,
      };
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          alert('✓ Settings saved as persistent defaults in ~/.k1-slicer/config.json!');
        }
      } catch (e) {
        alert(`Failed to save settings: ${e.message}`);
      }
    };
  }

  // Drag and Drop files onto 3D Canvas
  const canvasContainer = document.getElementById('canvas-container');
  ['dragenter', 'dragover'].forEach((name) => {
    window.addEventListener(name, (e) => {
      e.preventDefault();
      canvasContainer.style.filter = 'brightness(1.15)';
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    window.addEventListener(name, (e) => {
      e.preventDefault();
      canvasContainer.style.filter = 'none';
    });
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const f of e.dataTransfer.files) {
        const reader = new FileReader();
        reader.onload = (event) => {
          loadSTLFromBuffer(event.target.result, f.name);
        };
        reader.readAsArrayBuffer(f);
      }
    }
  });

  // Printer IP Check
  document.getElementById('btnCheckPrinter').onclick = checkPrinterConnection;

  // Slicing Action
  document.getElementById('btnSlice').onclick = () => executeSlice(false);
  document.getElementById('btnSliceAndPrint').onclick = () => executeSlice(true);

  // Monitor and Navigation Setup
  setupPageNavigation();
  setupMonitorDashboard();
  setupMonitorControls();

  // Load persistent user config
  loadSavedConfig();

  // Settings Modal setup
  setupSettingsModal();
}

export function setUnit(unit) {
  currentUnit = unit;
  const btnInches = document.getElementById('btnUnitInches');
  const btnMm = document.getElementById('btnUnitMm');
  if (btnInches && btnMm) {
    btnInches.classList.toggle('active', unit === 'inches');
    btnMm.classList.toggle('active', unit === 'mm');
  }

  // Update physical specs card
  const specBed = document.getElementById('specBed');
  const specMaxZ = document.getElementById('specMaxZ');
  const specNozzle = document.getElementById('specNozzle');
  if (specBed) {
    specBed.textContent = unit === 'inches' ? '8.66 × 8.66 in' : '220 × 220 mm';
  }
  if (specMaxZ) {
    specMaxZ.textContent = unit === 'inches' ? '9.84 in' : '250 mm';
  }
  if (specNozzle) {
    specNozzle.textContent = unit === 'inches' ? '0.016 in (0.4mm)' : '0.4 mm';
  }

  checkBoundaries();
  updateModelListUI();
}

let activeConfig = {};

async function loadSavedConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      activeConfig = await res.json();
      applyConfigToUI(activeConfig);
      if (activeConfig.printerIp) {
        startTelemetryPolling(activeConfig.printerIp);
      }
    }
  } catch {}
}

function getSelectedSpeed() {
  const sel = document.getElementById('selSpeed');
  if (!sel) return '100%';
  if (sel.value === 'custom') {
    const customInput = document.getElementById('txtCustomSpeed');
    return (customInput && customInput.value.trim()) || '100%';
  }
  return sel.value;
}

function updateSpeedBadge() {
  const badge = document.getElementById('speedBadge');
  if (!badge) return;
  const speed = getSelectedSpeed();
  if (lower === '60mm/s' || lower === '60' || lower === '60mms') {
    badge.textContent = '60 mm/s (Ender PLA Safe)';
  } else if (lower === '50%' || lower === 'silent') {
    badge.textContent = 'Silent (50% / 150 mm/s)';
  } else if (lower === '100%' || lower === 'standard') {
    badge.textContent = '100% (300 mm/s)';
  } else if (lower === '125%' || lower === 'sport') {
    badge.textContent = 'Sport (125% / 375 mm/s)';
  } else if (lower === '166%' || lower === 'ludicrous') {
    badge.textContent = 'Ludicrous (166% / 500 mm/s)';
  } else if (lower.endsWith('%')) {
    const pct = parseFloat(lower);
    const mm = Math.round(300 * (pct / 100));
    badge.textContent = `${pct}% (${mm} mm/s)`;
  } else {
    const val = parseFloat(lower.replace(/mm\/s|mms/g, ''));
    if (!isNaN(val)) {
      const pct = Math.round((val / 300) * 100);
      badge.textContent = `${val} mm/s (${pct}%)`;
    } else {
      badge.textContent = speed;
    }
  }
}

function applyConfigToUI(cfg) {
  if (cfg.unit) {
    setUnit(cfg.unit);
  }
  if (cfg.preset) document.getElementById('selPreset').value = cfg.preset;
  if (cfg.material) document.getElementById('selMaterial').value = cfg.material;
  if (cfg.infill !== undefined) {
    document.getElementById('rangeInfill').value = cfg.infill;
    document.getElementById('infillVal').textContent = `${cfg.infill}%`;
  }
  if (cfg.infillPattern) document.getElementById('selInfillPattern').value = cfg.infillPattern;
  if (cfg.walls) document.getElementById('numWalls').value = cfg.walls;
  if (cfg.brim) document.getElementById('selBrim').value = cfg.brim;
  if (cfg.supports !== undefined) {
    document.getElementById('chkSupports').checked = cfg.supports;
    document.getElementById('supportOptions').style.display = cfg.supports ? 'block' : 'none';
  }
  if (cfg.supportType) document.getElementById('selSupportType').value = cfg.supportType;
  if (cfg.speed) {
    const selSpeed = document.getElementById('selSpeed');
    const txtCustomSpeed = document.getElementById('txtCustomSpeed');
    if (selSpeed) {
      if (['100%', '50%', '125%', '166%'].includes(cfg.speed)) {
        selSpeed.value = cfg.speed;
        if (txtCustomSpeed) txtCustomSpeed.style.display = 'none';
      } else {
        selSpeed.value = 'custom';
        if (txtCustomSpeed) {
          txtCustomSpeed.value = cfg.speed;
          txtCustomSpeed.style.display = 'block';
        }
      }
      updateSpeedBadge();
    }
  }
  if (cfg.printerIp) {
    document.getElementById('txtPrinterIp').value = cfg.printerIp;
    checkPrinterConnection();
  }
}

function setupSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const btnOpen = document.getElementById('btnOpenSettings');
  const btnClose = document.getElementById('btnCloseSettings');
  const btnCancel = document.getElementById('btnCancelSettings');
  const btnSave = document.getElementById('btnSaveGlobalSettings');
  const btnReset = document.getElementById('btnResetDefaults');
  const btnTestPrinter = document.getElementById('btnTestCfgPrinter');

  // Open modal
  btnOpen.onclick = () => {
    // Populate modal inputs from activeConfig
    document.getElementById('cfgPrinterIp').value = activeConfig.printerIp || '';
    document.getElementById('cfgPrinterPort').value = activeConfig.printerPort || 7125;
    document.getElementById('cfgPreset').value = activeConfig.preset || 'standard';
    document.getElementById('cfgMaterial').value = activeConfig.material || 'hyper-pla';
    document.getElementById('cfgInfill').value = activeConfig.infill ?? 20;
    document.getElementById('cfgInfillPattern').value = activeConfig.infillPattern || 'gyroid';
    document.getElementById('cfgWalls').value = activeConfig.walls ?? 3;
    document.getElementById('cfgBrim').value = activeConfig.brim || 'auto';
    document.getElementById('cfgSupports').checked = activeConfig.supports !== false;
    document.getElementById('cfgSupportType').value = activeConfig.supportType || 'tree';
    document.getElementById('cfgAutoCenter').checked = activeConfig.autoCenter !== false;
    document.getElementById('cfgAutoOrient').checked = !!activeConfig.autoOrient;
    document.getElementById('cfgUnit').value = activeConfig.unit || 'inches';

    const cfgSpeed = document.getElementById('cfgSpeed');
    const cfgCustomSpeed = document.getElementById('cfgCustomSpeed');
    const cfgCustomSpeedContainer = document.getElementById('cfgCustomSpeedContainer');
    const activeSpeed = activeConfig.speed || '100%';
    if (['100%', '50%', '125%', '166%'].includes(activeSpeed)) {
      if (cfgSpeed) cfgSpeed.value = activeSpeed;
      if (cfgCustomSpeedContainer) cfgCustomSpeedContainer.style.display = 'none';
    } else {
      if (cfgSpeed) cfgSpeed.value = 'custom';
      if (cfgCustomSpeed) cfgCustomSpeed.value = activeSpeed;
      if (cfgCustomSpeedContainer) cfgCustomSpeedContainer.style.display = 'block';
    }

    modal.classList.remove('hidden');
  };

  const cfgSpeed = document.getElementById('cfgSpeed');
  const cfgCustomSpeed = document.getElementById('cfgCustomSpeed');
  const cfgCustomSpeedContainer = document.getElementById('cfgCustomSpeedContainer');
  if (cfgSpeed) {
    cfgSpeed.onchange = () => {
      if (cfgSpeed.value === 'custom') {
        if (cfgCustomSpeedContainer) cfgCustomSpeedContainer.style.display = 'block';
        if (cfgCustomSpeed) cfgCustomSpeed.focus();
      } else {
        if (cfgCustomSpeedContainer) cfgCustomSpeedContainer.style.display = 'none';
      }
    };
  }

  // Close modal
  const closeModal = () => modal.classList.add('hidden');
  btnClose.onclick = closeModal;
  btnCancel.onclick = closeModal;

  // Tabs switching
  const tabBtns = modal.querySelectorAll('.settings-tabs .tab-btn');
  tabBtns.forEach((btn) => {
    btn.onclick = () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      modal.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
    };
  });

  // Test printer connection in settings
  btnTestPrinter.onclick = async () => {
    const ip = document.getElementById('cfgPrinterIp').value.trim();
    const statusText = document.getElementById('cfgPrinterStatusText');
    const badge = document.getElementById('cfgPrinterStatus');
    if (!ip) {
      statusText.textContent = 'Please enter an IP address';
      return;
    }
    statusText.textContent = 'Pinging printer...';
    try {
      const res = await fetch(`/api/printer/status?ip=${encodeURIComponent(ip)}`);
      const data = await res.json();
      if (data.connected) {
        badge.className = 'printer-status-badge connected';
        statusText.textContent = `${data.message} (${data.state || 'Online'})`;
      } else {
        badge.className = 'printer-status-badge';
        statusText.textContent = data.message || 'Printer unreachable';
      }
    } catch {
      statusText.textContent = 'Connection error';
    }
  };

  // Save global defaults
  btnSave.onclick = async () => {
    const payload = {
      printerIp: document.getElementById('cfgPrinterIp').value.trim(),
      printerPort: parseInt(document.getElementById('cfgPrinterPort').value, 10),
      preset: document.getElementById('cfgPreset').value,
      material: document.getElementById('cfgMaterial').value,
      infill: parseInt(document.getElementById('cfgInfill').value, 10),
      infillPattern: document.getElementById('cfgInfillPattern').value,
      walls: parseInt(document.getElementById('cfgWalls').value, 10),
      brim: document.getElementById('cfgBrim').value,
      supports: document.getElementById('cfgSupports').checked,
      supportType: document.getElementById('cfgSupportType').value,
      autoCenter: document.getElementById('cfgAutoCenter').checked,
      autoOrient: document.getElementById('cfgAutoOrient').checked,
      unit: document.getElementById('cfgUnit').value,
      speed: (() => {
        const val = document.getElementById('cfgSpeed').value;
        if (val === 'custom') {
          return document.getElementById('cfgCustomSpeed').value.trim() || '100%';
        }
        return val;
      })(),
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        activeConfig = await res.json();
        applyConfigToUI(activeConfig);
        closeModal();
        alert('✓ Default settings saved to ~/.k1-slicer/config.json!');
      }
    } catch (e) {
      alert(`Error saving defaults: ${e.message}`);
    }
  };

  // Reset defaults
  btnReset.onclick = async () => {
    if (!confirm('Are you sure you want to reset all configuration defaults to factory settings?')) {
      return;
    }
    try {
      const res = await fetch('/api/config/reset', { method: 'POST' });
      if (res.ok) {
        activeConfig = await res.json();
        applyConfigToUI(activeConfig);
        closeModal();
        alert('🔄 Settings reset to factory defaults.');
      }
    } catch (e) {
      alert(`Error resetting: ${e.message}`);
    }
  };
}

function rotateSelected(rx, ry, rz) {
  if (!selectedModel) return;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  selectedModel.applyQuaternion(q);
  selectedModel.updateMatrixWorld(true);
  dropModelToBed(selectedModel);
  checkBoundaries();
}

function updateModelListUI() {
  const list = document.getElementById('modelList');
  list.innerHTML = '';
  models.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = `model-item ${m === selectedModel ? 'selected' : ''}`;
    const box = new THREE.Box3().setFromObject(m);
    const size = new THREE.Vector3();
    box.getSize(size);
    const sizeStr = currentUnit === 'inches'
      ? `${(size.x / 25.4).toFixed(2)} × ${(size.y / 25.4).toFixed(2)} × ${(size.z / 25.4).toFixed(2)} in`
      : `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
    item.innerHTML = `<div style="font-weight: 600;">${m.userData.filename || `Model #${idx + 1}`}</div><div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">${sizeStr}</div>`;
    item.onclick = () => selectModel(m);
    list.appendChild(item);
  });
}

async function checkInitialServerModel() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialFile = urlParams.get('model');
  if (initialFile) {
    try {
      const res = await fetch(`/api/model?file=${encodeURIComponent(initialFile)}`);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        loadSTLFromBuffer(buf, initialFile.split('/').pop());
      }
    } catch {}
  }
}

async function checkPrinterConnection() {
  const ip = document.getElementById('txtPrinterIp').value.trim();
  const badge = document.getElementById('printerStatusBadge');
  const text = document.getElementById('printerStatusText');

  if (!ip) {
    badge.className = 'printer-status-badge';
    text.textContent = 'Please enter an IP address';
    return;
  }

  text.textContent = 'Pinging Creality K1...';
  try {
    const res = await fetch(`/api/printer/status?ip=${encodeURIComponent(ip)}`);
    const data = await res.json();
    if (data.connected) {
      badge.className = 'printer-status-badge connected';
      let info = `${data.message} (${data.state || 'Online'})`;
      if (data.extruderTemp !== undefined && data.bedTemp !== undefined) {
        info += ` • 🌡️ ${data.extruderTemp.toFixed(0)}°C / 🛏️ ${data.bedTemp.toFixed(0)}°C`;
      }
      text.textContent = info;
      document.getElementById('btnSliceAndPrint').disabled = false;
      startTelemetryPolling(ip);
      updateTelemetryUI(data, ip);
    } else {
      badge.className = 'printer-status-badge';
      text.textContent = data.message || 'Printer unreachable';
    }
  } catch (e) {
    badge.className = 'printer-status-badge';
    text.textContent = 'Connection error';
  }
}

// ----------------- Page Navigation & Monitoring -----------------

let currentPage = 'prepare';
let telemetryInterval = null;
let currentPrinterIp = '';
let currentLightState = false;

function setupPageNavigation() {
  const navBtnPrepare = document.getElementById('navBtnPrepare');
  const navBtnMonitor = document.getElementById('navBtnMonitor');
  const headerChip = document.getElementById('headerPrinterChip');
  const btnSwitchAfterUpload = document.getElementById('btnSwitchToMonitorAfterUpload');

  if (navBtnPrepare) {
    navBtnPrepare.onclick = () => switchPage('prepare');
  }
  if (navBtnMonitor) {
    navBtnMonitor.onclick = () => switchPage('monitor');
  }
  if (headerChip) {
    headerChip.onclick = () => switchPage('monitor');
  }
  if (btnSwitchAfterUpload) {
    btnSwitchAfterUpload.onclick = () => {
      document.getElementById('uploadProgressModal')?.classList.add('hidden');
      switchPage('monitor');
    };
  }
}

export function switchPage(page) {
  currentPage = page;
  const viewPrepare = document.getElementById('viewPrepare');
  const viewMonitor = document.getElementById('viewMonitor');
  const navBtnPrepare = document.getElementById('navBtnPrepare');
  const navBtnMonitor = document.getElementById('navBtnMonitor');

  if (page === 'prepare') {
    navBtnPrepare?.classList.add('active');
    navBtnMonitor?.classList.remove('active');
    viewPrepare?.classList.remove('hidden');
    viewMonitor?.classList.add('hidden');
    onWindowResize();
  } else {
    navBtnMonitor?.classList.add('active');
    navBtnPrepare?.classList.remove('active');
    viewMonitor?.classList.remove('hidden');
    viewPrepare?.classList.add('hidden');

    const ip = getEffectivePrinterIp();
    if (ip) {
      refreshCameraStream(ip);
      fetchPrinterTelemetry(ip);
    }
  }
}

function getEffectivePrinterIp() {
  return document.getElementById('txtPrinterIp')?.value.trim() || activeConfig?.printerIp || currentPrinterIp || '';
}

function startTelemetryPolling(ip) {
  if (!ip) return;
  currentPrinterIp = ip;
  if (telemetryInterval) clearInterval(telemetryInterval);
  fetchPrinterTelemetry(ip);
  telemetryInterval = setInterval(() => {
    fetchPrinterTelemetry(currentPrinterIp);
  }, 2500);
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0 || isNaN(seconds)) return '--:--';
  const s = Math.round(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m ${secs}s`;
}

async function fetchPrinterTelemetry(ip) {
  if (!ip) return;
  try {
    const res = await fetch(`/api/printer/status?ip=${encodeURIComponent(ip)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.connected) {
      updateTelemetryUI(data, ip);
    }
  } catch (e) {}
}

function updateTelemetryUI(data, ip) {
  // 1. Header Live Chip
  const headerChip = document.getElementById('headerPrinterChip');
  const headerText = document.getElementById('headerChipText');
  const livePulseDot = document.getElementById('navLiveDot');

  if (headerChip && headerText) {
    headerChip.classList.remove('hidden');
    const isPrinting = data.state === 'printing';
    livePulseDot?.classList.toggle('hidden', !isPrinting);

    if (isPrinting) {
      headerText.textContent = `K1: Printing (${data.printProgress || 0}%) • ${data.extruderTemp?.toFixed(0)}°C/${data.bedTemp?.toFixed(0)}°C`;
    } else if (data.state === 'paused') {
      headerText.textContent = `K1: Paused (${data.printProgress || 0}%) • ${data.extruderTemp?.toFixed(0)}°C`;
    } else {
      headerText.textContent = `K1: Ready • ${data.extruderTemp?.toFixed(0)}°C/${data.bedTemp?.toFixed(0)}°C`;
    }
  }

  // 2. Monitor Page Elements
  const statePill = document.getElementById('printJobStatePill');
  if (statePill) {
    statePill.textContent = data.state || 'Online';
    statePill.className = `state-pill ${data.state || 'idle'}`;
  }

  const monFileName = document.getElementById('monFileName');
  if (monFileName) {
    monFileName.textContent = data.printFileName || (data.state === 'printing' ? 'Active Print Job' : 'No active print');
  }

  const pct = typeof data.printProgress === 'number' ? data.printProgress : 0;
  const progressFill = document.getElementById('monProgressFill');
  const progressPct = document.getElementById('monProgressPct');
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressPct) progressPct.textContent = `${pct}%`;

  const monLayerCount = document.getElementById('monLayerCount');
  if (monLayerCount) {
    monLayerCount.textContent = `Layer ${data.currentLayer || '--'} / ${data.totalLayers || '--'}`;
  }

  const monTimeElapsed = document.getElementById('monTimeElapsed');
  if (monTimeElapsed) {
    monTimeElapsed.textContent = formatDuration(data.printJobTime);
  }

  const monTimeRemaining = document.getElementById('monTimeRemaining');
  if (monTimeRemaining) {
    monTimeRemaining.textContent = formatDuration(data.printLeftTime);
  }

  const monSpeedVal = document.getElementById('monSpeedVal');
  if (monSpeedVal) {
    monSpeedVal.textContent = data.realTimeSpeed ? `${data.realTimeSpeed} mm/s` : '-- mm/s';
  }

  // Action Buttons state
  const btnPause = document.getElementById('btnMonPause');
  const btnResume = document.getElementById('btnMonResume');
  const btnCancel = document.getElementById('btnMonCancel');

  if (data.state === 'printing') {
    if (btnPause) { btnPause.style.display = 'inline-flex'; btnPause.disabled = false; }
    if (btnResume) { btnResume.style.display = 'none'; btnResume.disabled = true; }
    if (btnCancel) { btnCancel.disabled = false; }
  } else if (data.state === 'paused') {
    if (btnPause) { btnPause.style.display = 'none'; btnPause.disabled = true; }
    if (btnResume) { btnResume.style.display = 'inline-flex'; btnResume.disabled = false; }
    if (btnCancel) { btnCancel.disabled = false; }
  } else {
    if (btnPause) { btnPause.style.display = 'inline-flex'; btnPause.disabled = true; }
    if (btnResume) { btnResume.style.display = 'none'; btnResume.disabled = true; }
    if (btnCancel) { btnCancel.disabled = true; }
  }

  // Thermal Gauges
  const monTempExtruder = document.getElementById('monTempExtruder');
  const monTargetExtruder = document.getElementById('monTargetExtruder');
  const monBarExtruder = document.getElementById('monBarExtruder');
  if (monTempExtruder) monTempExtruder.textContent = data.extruderTemp !== undefined ? data.extruderTemp.toFixed(1) : '--';
  if (monTargetExtruder) monTargetExtruder.textContent = `Target: ${data.extruderTarget !== undefined ? data.extruderTarget.toFixed(0) : '--'}°C`;
  if (monBarExtruder && data.extruderTemp !== undefined) {
    const extPct = Math.min(100, (data.extruderTemp / 300) * 100);
    monBarExtruder.style.width = `${extPct}%`;
  }

  const monTempBed = document.getElementById('monTempBed');
  const monTargetBed = document.getElementById('monTargetBed');
  const monBarBed = document.getElementById('monBarBed');
  if (monTempBed) monTempBed.textContent = data.bedTemp !== undefined ? data.bedTemp.toFixed(1) : '--';
  if (monTargetBed) monTargetBed.textContent = `Target: ${data.bedTarget !== undefined ? data.bedTarget.toFixed(0) : '--'}°C`;
  if (monBarBed && data.bedTemp !== undefined) {
    const bedPct = Math.min(100, (data.bedTemp / 110) * 100);
    monBarBed.style.width = `${bedPct}%`;
  }

  const monTempChamber = document.getElementById('monTempChamber');
  if (monTempChamber) monTempChamber.textContent = data.boxTemp !== undefined ? data.boxTemp.toFixed(1) : '--';

  // Fans & Coordinates
  const monFanModel = document.getElementById('monFanModel');
  const monFanAux = document.getElementById('monFanAux');
  const monFanCase = document.getElementById('monFanCase');
  if (monFanModel) monFanModel.textContent = `${data.fans?.model || 0}%`;
  if (monFanAux) monFanAux.textContent = `${data.fans?.auxiliary || 0}%`;
  if (monFanCase) monFanCase.textContent = `${data.fans?.case || 0}%`;

  const monToolheadPos = document.getElementById('monToolheadPos');
  if (monToolheadPos && data.curPosition) {
    monToolheadPos.textContent = data.curPosition;
  }

  // Chamber Light Toggle State
  if (data.lightOn !== undefined) {
    currentLightState = data.lightOn;
    const lightText = document.getElementById('lightBtnText');
    const lightBtn = document.getElementById('btnToggleChamberLight');
    if (lightText) lightText.textContent = currentLightState ? 'Light On' : 'Light Off';
    if (lightBtn) lightBtn.style.color = currentLightState ? '#ffa502' : 'inherit';
  }
}

function setupMonitorDashboard() {
  const btnToggleLight = document.getElementById('btnToggleChamberLight');
  const btnRefreshCam = document.getElementById('btnRefreshCamera');
  const btnFullscreen = document.getElementById('btnFullscreenCamera');
  const btnManualConnect = document.getElementById('btnConnectStreamManual');

  if (btnToggleLight) {
    btnToggleLight.onclick = async () => {
      const ip = getEffectivePrinterIp();
      if (!ip) return;
      const nextState = !currentLightState;
      try {
        await fetch('/api/printer/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip, action: 'light', value: nextState }),
        });
        currentLightState = nextState;
        const lightText = document.getElementById('lightBtnText');
        if (lightText) lightText.textContent = currentLightState ? 'Light On' : 'Light Off';
      } catch (e) {}
    };
  }

  if (btnRefreshCam) {
    btnRefreshCam.onclick = () => {
      const ip = getEffectivePrinterIp();
      if (ip) refreshCameraStream(ip);
    };
  }

  if (btnManualConnect) {
    btnManualConnect.onclick = () => {
      const ip = getEffectivePrinterIp();
      if (ip) refreshCameraStream(ip);
    };
  }

  if (btnFullscreen) {
    btnFullscreen.onclick = () => {
      const wrapper = document.getElementById('cameraStreamWrapper');
      if (wrapper) {
        if (!document.fullscreenElement) {
          wrapper.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    };
  }
}

function refreshCameraStream(ip) {
  const overlay = document.getElementById('cameraStandbyOverlay');
  const iframe = document.getElementById('k1CameraIframe');
  const wrapper = document.getElementById('cameraStreamWrapper');

  if (!ip) {
    overlay?.classList.remove('hidden');
    return;
  }

  let streamImg = document.getElementById('k1MjpegStreamImg');
  if (!streamImg) {
    streamImg = document.createElement('img');
    streamImg.id = 'k1MjpegStreamImg';
    streamImg.className = 'camera-video-elem';
    streamImg.alt = 'Creality K1 AI Camera Stream';
    wrapper.insertBefore(streamImg, overlay);
  }

  const streamUrl = `http://${ip}:8080/?action=stream`;
  streamImg.src = streamUrl;
  overlay?.classList.add('hidden');

  streamImg.onerror = () => {
    // If port 8080 fails, try WebRTC / port 8000 fallback
    streamImg.style.display = 'none';
    if (iframe) {
      iframe.src = `http://${ip}:8000/`;
      iframe.classList.remove('hidden');
    }
  };

  streamImg.onload = () => {
    streamImg.style.display = 'block';
    if (iframe) iframe.classList.add('hidden');
    overlay?.classList.add('hidden');
  };
}

function setupMonitorControls() {
  const btnPause = document.getElementById('btnMonPause');
  const btnResume = document.getElementById('btnMonResume');
  const btnCancel = document.getElementById('btnMonCancel');

  const btnPla = document.getElementById('btnQuickPla');
  const btnPetg = document.getElementById('btnQuickPetg');
  const btnCooldown = document.getElementById('btnQuickCooldown');

  const sendControl = async (action, extra = {}) => {
    const ip = getEffectivePrinterIp();
    if (!ip) {
      alert('Please connect to a printer IP first.');
      return;
    }
    try {
      await fetch('/api/printer/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, action, ...extra }),
      });
      fetchPrinterTelemetry(ip);
    } catch (e) {
      alert(`Control command failed: ${e.message}`);
    }
  };

  if (btnPause) btnPause.onclick = () => sendControl('pause');
  if (btnResume) btnResume.onclick = () => sendControl('resume');
  if (btnCancel) {
    btnCancel.onclick = () => {
      if (confirm('Are you sure you want to cancel and stop the current print job on the K1?')) {
        sendControl('cancel');
      }
    };
  }

  if (btnPla) {
    btnPla.onclick = async () => {
      await sendControl('temp', { target: 'nozzle', temp: 210 });
      await sendControl('temp', { target: 'bed', temp: 60 });
    };
  }

  if (btnPetg) {
    btnPetg.onclick = async () => {
      await sendControl('temp', { target: 'nozzle', temp: 240 });
      await sendControl('temp', { target: 'bed', temp: 75 });
    };
  }

  if (btnCooldown) {
    btnCooldown.onclick = async () => {
      await sendControl('temp', { target: 'nozzle', temp: 0 });
      await sendControl('temp', { target: 'bed', temp: 0 });
    };
  }
}

// ----------------- Slicing & Direct Network Upload Execution -----------------

async function executeSlice(sendToPrinter = false) {
  if (models.length === 0) return;

  const slicingModal = document.getElementById('slicingModal');
  const slicingModalTitle = document.getElementById('slicingModalTitle');
  const slicingModalSubtitle = document.getElementById('slicingModalSubtitle');
  const slicingLogsPre = document.getElementById('slicingLogs');
  const resultsCard = document.getElementById('sliceResultsCard');

  const uploadModal = document.getElementById('uploadProgressModal');
  const uploadFill = document.getElementById('uploadProgressFill');
  const uploadMetrics = document.getElementById('uploadBytesMetrics');
  const uploadPhaseText = document.getElementById('uploadPhaseText');
  const uploadActions = document.getElementById('uploadActionsContainer');

  const stepSlice = document.getElementById('stepSlice');
  const stepUpload = document.getElementById('stepUpload');
  const stepTrigger = document.getElementById('stepTrigger');

  const printerIp = getEffectivePrinterIp();

  if (sendToPrinter) {
    if (!printerIp) {
      alert('Please enter a Creality K1 IP address in the network printing card.');
      return;
    }
    uploadModal.classList.remove('hidden');
    uploadActions.classList.add('hidden');
    stepSlice.className = 'upload-step-item active';
    stepUpload.className = 'upload-step-item pending';
    stepTrigger.className = 'upload-step-item pending';
    uploadFill.style.width = '0%';
    uploadPhaseText.textContent = '1. Generating G-code with OrcaSlicer...';
    uploadMetrics.textContent = 'Computing kinematics and speed profiles...';
  } else {
    slicingModal.classList.remove('hidden');
    slicingModalTitle.textContent = 'Slicing for Creality K1...';
    slicingModalSubtitle.textContent = 'Generating high-speed toolpaths with input shaping...';
    slicingLogsPre.textContent = 'Starting slicing pipeline...\n';
  }

  try {
    const exporter = new STLExporter();
    const stlBlobs = [];

    for (const m of models) {
      const clone = m.clone();
      clone.applyMatrix4(m.matrixWorld);
      const stlBinary = exporter.parse(clone, { binary: true });
      stlBlobs.push(new Blob([stlBinary], { type: 'application/octet-stream' }));
    }

    const formData = new FormData();
    stlBlobs.forEach((blob, idx) => {
      formData.append('files', blob, `part_${idx + 1}.stl`);
    });

    const jobName = document.getElementById('txtJobName')?.value.trim() || models[0].userData.filename?.replace(/\.[^/.]+$/, '') || 'k1_print';
    formData.append('name', jobName);
    formData.append('preset', document.getElementById('selPreset').value);
    formData.append('material', document.getElementById('selMaterial').value);
    formData.append('infill', document.getElementById('rangeInfill').value);
    formData.append('infillPattern', document.getElementById('selInfillPattern').value);
    formData.append('walls', document.getElementById('numWalls').value);
    formData.append('brim', document.getElementById('selBrim').value);
    formData.append('supports', document.getElementById('chkSupports').checked ? 'true' : 'false');
    formData.append('supportType', document.getElementById('selSupportType').value);
    formData.append('speed', getSelectedSpeed());
    formData.append('arrange', 'false');

    if (printerIp) {
      formData.append('printerIp', printerIp);
    }
    // Slicing phase
    const res = await fetch('/api/slice', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Slicing failed');
    }

    // Update results card
    resultsCard.classList.remove('hidden');
    document.getElementById('resTime').textContent = data.stats.estimatedTimeStr;
    document.getElementById('resFilament').textContent = `${data.stats.filamentUsedMeters.toFixed(2)}m (${data.stats.filamentUsedGrams}g)`;
    document.getElementById('resLayers').textContent = data.stats.totalLayers;

    const btnDownload = document.getElementById('btnDownloadGcode');
    btnDownload.href = `/api/download?path=${encodeURIComponent(data.stats.gcodePath)}&name=${encodeURIComponent(jobName)}`;
    btnDownload.download = `${jobName}.gcode`;

    const btnSendExisting = document.getElementById('btnSendExistingGcode');
    btnSendExisting.onclick = () => {
      uploadGcodeToK1(data.stats.gcodePath, jobName, printerIp, true);
    };

    if (!sendToPrinter) {
      slicingModal.classList.add('hidden');
    } else {
      // Step 2 & 3: Upload and trigger print with progress
      await uploadGcodeToK1(data.stats.gcodePath, jobName, printerIp, true);
    }
  } catch (err) {
    if (sendToPrinter) {
      alert(`Print launch error: ${err.message}`);
      uploadModal.classList.add('hidden');
    } else {
      slicingModalTitle.textContent = 'Slicing Error';
      slicingModalSubtitle.textContent = err.message;
      slicingLogsPre.textContent += `\nError: ${err.message}`;
      setTimeout(() => {
        slicingModal.classList.add('hidden');
      }, 4000);
    }
  }
}

async function uploadGcodeToK1(gcodePath, jobName, printerIp, autoStart = true) {
  const uploadModal = document.getElementById('uploadProgressModal');
  const uploadFill = document.getElementById('uploadProgressFill');
  const uploadMetrics = document.getElementById('uploadBytesMetrics');
  const uploadPhaseText = document.getElementById('uploadPhaseText');
  const uploadActions = document.getElementById('uploadActionsContainer');

  const stepSlice = document.getElementById('stepSlice');
  const stepUpload = document.getElementById('stepUpload');
  const stepTrigger = document.getElementById('stepTrigger');

  uploadModal.classList.remove('hidden');
  stepSlice.className = 'upload-step-item completed';
  stepUpload.className = 'upload-step-item active';
  uploadPhaseText.textContent = `2. Uploading "${jobName}.gcode" to K1...`;

  // Animate progress smoothly while server sends over LAN
  let fakeProgress = 10;
  const progressTimer = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += 15;
      uploadFill.style.width = `${fakeProgress}%`;
      uploadMetrics.textContent = `Transferred ${Math.round(fakeProgress * 0.15 * 10) / 10} MB ... (${Math.round(fakeProgress)}%)`;
    }
  }, 200);

  try {
    const res = await fetch('/api/printer/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: printerIp, gcodePath, filename: jobName }),
    });
    clearInterval(progressTimer);
    uploadFill.style.width = '100%';

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Upload to K1 failed');
    }

    stepUpload.className = 'upload-step-item completed';
    stepTrigger.className = 'upload-step-item completed';
    uploadPhaseText.textContent = '✓ G-code received & Print started on K1!';
    uploadMetrics.textContent = 'Execution underway on Creality OS';
    uploadActions.classList.remove('hidden');

    startTelemetryPolling(printerIp);
  } catch (err) {
    clearInterval(progressTimer);
    alert(`Failed to send to K1: ${err.message}`);
    uploadModal.classList.add('hidden');
  }
}
