import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { OrcaWrapper, SliceOptions } from '../engine/orca-wrapper.js';
import { K1PrinterClient } from '../printer/k1-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(): string {
  let curr = __dirname;
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();

const upload = multer({ dest: path.join(os.tmpdir(), 'k1-uploads') });

export function createServer(initialModelPath?: string) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve Three.js vendor files from node_modules
  const threePath = path.join(projectRoot, 'node_modules/three');
  app.use('/vendor/three', express.static(threePath));

  // Serve static web app assets
  const webPath = path.join(projectRoot, 'src/web');
  app.use(express.static(webPath));

  // Serve initial model if passed via CLI
  app.get('/api/model', (req, res) => {
    const filePath = (req.query.file as string) || initialModelPath;
    if (filePath && fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      return fs.createReadStream(filePath).pipe(res);
    }
    return res.status(404).json({ error: 'File not found' });
  });

  // Check printer connection status
  app.get('/api/printer/status', async (req, res) => {
    const ip = req.query.ip as string;
    if (!ip) {
      return res.status(400).json({ error: 'Missing IP parameter' });
    }
    const client = new K1PrinterClient(ip);
    const status = await client.getStatus();
    return res.json(status);
  });

  // Slice models
  app.post('/api/slice', upload.array('files'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No 3D model files uploaded' });
      }

      const inputPaths = files.map((f) => f.path);
      const options: SliceOptions = {
        preset: req.body.preset,
        material: req.body.material,
        infill: req.body.infill ? parseInt(req.body.infill, 10) : undefined,
        infillPattern: req.body.infillPattern,
        layerHeight: req.body.layerHeight ? parseFloat(req.body.layerHeight) : undefined,
        supports: req.body.supports === 'true',
        supportType: req.body.supportType,
        brim: req.body.brim,
        walls: req.body.walls ? parseInt(req.body.walls, 10) : undefined,
        arrange: req.body.arrange === 'true',
      };

      const stats = await OrcaWrapper.slice(inputPaths, options);

      // If user requested direct print
      let printerResult = null;
      if (req.body.sendToPrinter === 'true' && req.body.printerIp) {
        const client = new K1PrinterClient(req.body.printerIp);
        printerResult = await client.uploadAndPrint(stats.gcodePath, true);
      }

      return res.json({
        success: true,
        stats,
        printerResult,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Download sliced G-code
  app.get('/api/download', (req, res) => {
    const gcodePath = req.query.path as string;
    if (gcodePath && fs.existsSync(gcodePath)) {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(gcodePath)}"`);
      return fs.createReadStream(gcodePath).pipe(res);
    }
    return res.status(404).json({ error: 'G-code file not found' });
  });

  // Upload existing G-code to printer
  app.post('/api/printer/upload', async (req, res) => {
    const { gcodePath, printerIp, startPrint } = req.body;
    if (!gcodePath || !printerIp) {
      return res.status(400).json({ error: 'Missing gcodePath or printerIp' });
    }
    try {
      const client = new K1PrinterClient(printerIp);
      const result = await client.uploadAndPrint(gcodePath, !!startPrint);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  return app;
}

export function startStudioServer(port: number = 3125, initialModelPath?: string): Promise<number> {
  return new Promise((resolve) => {
    const app = createServer(initialModelPath);
    const server = app.listen(port, () => {
      resolve(port);
    });
    server.on('error', () => {
      // Try next port if 3125 is in use
      const nextPort = port + 1;
      const fallbackServer = app.listen(nextPort, () => {
        resolve(nextPort);
      });
    });
  });
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('app.ts')) {
  startStudioServer(3125).then((port) => {
    console.log(`⚡ Creality K1 Plate Studio running at http://localhost:${port}`);
  });
}
