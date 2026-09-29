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
let models = [];
let selectedModel = null;
let layFlatMode = false;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

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

  // Canvas Click for Raycasting (Selection & Lay-Flat)
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
      issues.push(`Extends past X boundary (0–220mm)`);
    }
    if (box.min.y < 0 || box.max.y > BED_SIZE_Y) {
      modelValid = false;
      issues.push(`Extends past Y boundary (0–220mm)`);
    }

    // Check Z grounding & max height
    if (box.min.z < -0.1) {
      modelValid = false;
      issues.push(`Penetrates below bed surface (${box.min.z.toFixed(1)}mm)`);
    } else if (box.min.z > 0.5) {
      modelValid = false;
      issues.push(`Floating above bed (${box.min.z.toFixed(1)}mm)`);
    }

    if (box.max.z > MAX_HEIGHT_Z) {
      modelValid = false;
      issues.push(`Exceeds max Z height of 250mm`);
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
    bannerText.textContent = 'Model placed within K1 build envelope (220×220×250 mm)';
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
        printerIp: document.getElementById('txtPrinterIp').value.trim(),
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

  // Load persistent user config
  loadSavedConfig();
}

async function loadSavedConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
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
      if (cfg.printerIp) {
        document.getElementById('txtPrinterIp').value = cfg.printerIp;
        checkPrinterConnection();
      }
    }
  } catch {}
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
    item.textContent = m.userData.filename || `Model #${idx + 1}`;
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
      text.textContent = `${data.message} (${data.state || 'Online'})`;
      document.getElementById('btnSliceAndPrint').disabled = false;
    } else {
      badge.className = 'printer-status-badge';
      text.textContent = data.message || 'Printer unreachable';
    }
  } catch (e) {
    badge.className = 'printer-status-badge';
    text.textContent = 'Connection error';
  }
}

// ----------------- Slicing Execution -----------------

async function executeSlice(sendToPrinter = false) {
  if (models.length === 0) return;

  const modal = document.getElementById('slicingModal');
  const modalTitle = document.getElementById('slicingModalTitle');
  const modalSubtitle = document.getElementById('slicingModalSubtitle');
  const logsPre = document.getElementById('slicingLogs');
  const resultsCard = document.getElementById('sliceResultsCard');

  modal.classList.remove('hidden');
  modalTitle.textContent = sendToPrinter ? 'Slicing & Uploading to Creality K1...' : 'Slicing for Creality K1...';
  modalSubtitle.textContent = 'Generating high-speed toolpaths with input shaping...';
  logsPre.textContent = 'Starting slicing pipeline...\n';

  try {
    // Export current placed meshes with all rotations, scales, translations baked in
    const exporter = new STLExporter();
    const stlBlobs = [];

    for (const m of models) {
      // Clone mesh to bake world transforms
      const clone = m.clone();
      clone.applyMatrix4(m.matrixWorld);
      const stlBinary = exporter.parse(clone, { binary: true });
      stlBlobs.push(new Blob([stlBinary], { type: 'application/octet-stream' }));
    }

    const formData = new FormData();
    stlBlobs.forEach((blob, idx) => {
      formData.append('files', blob, `part_${idx + 1}.stl`);
    });

    // Form settings
    formData.append('preset', document.getElementById('selPreset').value);
    formData.append('material', document.getElementById('selMaterial').value);
    formData.append('infill', document.getElementById('rangeInfill').value);
    formData.append('infillPattern', document.getElementById('selInfillPattern').value);
    formData.append('walls', document.getElementById('numWalls').value);
    formData.append('brim', document.getElementById('selBrim').value);
    formData.append('supports', document.getElementById('chkSupports').checked ? 'true' : 'false');
    formData.append('supportType', document.getElementById('selSupportType').value);
    formData.append('arrange', 'false'); // Preserve user's exact positions on bed!

    const printerIp = document.getElementById('txtPrinterIp').value.trim();
    if (printerIp) {
      formData.append('printerIp', printerIp);
    }
    if (sendToPrinter) {
      formData.append('sendToPrinter', 'true');
    }

    const res = await fetch('/api/slice', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Slicing failed');
    }

    modal.classList.add('hidden');
    resultsCard.classList.remove('hidden');

    document.getElementById('resTime').textContent = data.stats.estimatedTimeStr;
    document.getElementById('resFilament').textContent = `${data.stats.filamentUsedMeters.toFixed(2)}m (${data.stats.filamentUsedGrams}g)`;
    document.getElementById('resLayers').textContent = data.stats.totalLayers;

    const btnDownload = document.getElementById('btnDownloadGcode');
    btnDownload.href = `/api/download?path=${encodeURIComponent(data.stats.gcodePath)}`;
    btnDownload.download = `${models[0].userData.filename?.replace(/\.[^/.]+$/, '') || 'k1_print'}.gcode`;

    const btnSendExisting = document.getElementById('btnSendExistingGcode');
    btnSendExisting.onclick = async () => {
      if (!printerIp) {
        alert('Please enter a Printer IP address first.');
        return;
      }
      btnSendExisting.textContent = 'Uploading...';
      try {
        const upRes = await fetch('/api/printer/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gcodePath: data.stats.gcodePath, printerIp }),
        });
        const upData = await upRes.json();
        alert(upData.message || 'Uploaded successfully!');
      } catch (e) {
        alert(`Failed to send to printer: ${e.message}`);
      } finally {
        btnSendExisting.textContent = '📡 Send to Printer';
      }
    };

    if (sendToPrinter) {
      alert(`Print file generated and sent to K1 at ${printerIp}!`);
    }
  } catch (err) {
    modalTitle.textContent = 'Slicing Error';
    modalSubtitle.textContent = err.message;
    logsPre.textContent += `\nError: ${err.message}`;
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 4000);
  }
}
