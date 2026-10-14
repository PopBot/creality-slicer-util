import fs from 'node:fs';
import path from 'node:path';

export interface PrinterStatus {
  connected: boolean;
  state?: string;
  extruderTemp?: number;
  extruderTarget?: number;
  bedTemp?: number;
  bedTarget?: number;
  boxTemp?: number;
  message?: string;
  model?: string;
  printFileName?: string;
  printProgress?: number;
  currentLayer?: number;
  totalLayers?: number;
  printJobTime?: number;
  printLeftTime?: number;
  realTimeSpeed?: string;
  curPosition?: string;
  lightOn?: boolean;
  cameraActive?: boolean;
  fans?: {
    model: number;
    auxiliary: number;
    case: number;
  };
}

export class K1PrinterClient {
  private ip: string;
  private moonrakerPort: number;
  private webPort: number;
  private static telemetryCache: Map<string, Partial<any>> = new Map();

  constructor(printerIp: string, moonrakerPort: number = 7125, webPort: number = 80) {
    this.ip = printerIp.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.moonrakerPort = moonrakerPort;
    this.webPort = webPort;
  }

  /**
   * Check connection and fetch status from stock Creality OS or Moonraker.
   * Prioritizes stock Creality OS WebSocket (port 9999) which responds in <50ms.
   */
  async getStatus(): Promise<PrinterStatus> {
    // 1. Prioritize stock Creality OS WebSocket (port 9999) - instant response (~30-50ms)
    try {
      const wsStatus = await this.getStatusFromCrealityWS();
      if (wsStatus) {
        return wsStatus;
      }
    } catch {}

    // 2. Try Moonraker (port 7125) with short timeout for rooted machines
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600);
      const res = await fetch(`http://${this.ip}:${this.moonrakerPort}/printer/objects/query?print_stats&heater_bed&extruder`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data: any = await res.json();
        const status = data.result?.status;
        return {
          connected: true,
          state: status?.print_stats?.state || 'ready',
          extruderTemp: status?.extruder?.temperature,
          extruderTarget: status?.extruder?.target,
          bedTemp: status?.heater_bed?.temperature,
          bedTarget: status?.heater_bed?.target,
          message: 'Connected via Moonraker (Port 7125)',
        };
      }
    } catch {}

    // 3. Fallback: check stock web port (port 80)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://${this.ip}:${this.webPort}/`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        return {
          connected: true,
          state: 'online',
          message: 'Connected via Stock Creality OS (Port 80)',
        };
      }
    } catch {}

    return {
      connected: false,
      message: `Could not reach Creality K1 at ${this.ip}. Ensure printer is powered on and connected to your network.`,
    };
  }

  private getStatusFromCrealityWS(): Promise<PrinterStatus | null> {
    return new Promise((resolve) => {
      const WS = (globalThis as any).WebSocket;
      if (!WS) return resolve(null);

      let resolved = false;
      let ws: any;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws?.close(); } catch {}
          // If we have cached telemetry for this IP, return it instead of null
          const cached = K1PrinterClient.telemetryCache.get(this.ip);
          if (cached && (cached.nozzleTemp !== undefined || cached.bedTemp0 !== undefined)) {
            resolve(this.formatWsStatus(cached));
          } else {
            resolve(null);
          }
        }
      }, 1200);

      try {
        ws = new WS(`ws://${this.ip}:9999`);
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ method: 'get' }));
          } catch {}
        };
        ws.onmessage = (event: any) => {
          try {
            const data = JSON.parse(event.data);
            // Merge into cached state for this IP
            const currentCached = K1PrinterClient.telemetryCache.get(this.ip) || {};
            const merged = { ...currentCached, ...data };
            K1PrinterClient.telemetryCache.set(this.ip, merged);

            if (merged.nozzleTemp !== undefined || merged.bedTemp0 !== undefined) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                try { ws.close(); } catch {}
                resolve(this.formatWsStatus(merged));
              }
            }
          } catch {}
        };
        ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            const cached = K1PrinterClient.telemetryCache.get(this.ip);
            if (cached && (cached.nozzleTemp !== undefined || cached.bedTemp0 !== undefined)) {
              resolve(this.formatWsStatus(cached));
            } else {
              resolve(null);
            }
          }
        };
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  private formatWsStatus(data: any): PrinterStatus {
    let state = 'ready';
    if (data.state === 5 || data.pause === 1 || data.feedState === 4) {
      state = 'paused';
    } else if (data.state === 1 || data.state === 2 || (data.printFileName && data.printFileName !== '')) {
      state = 'printing';
    } else if (data.state === 0) {
      state = 'idle';
    }

    return {
      connected: true,
      state,
      extruderTemp: parseFloat(data.nozzleTemp || '0'),
      extruderTarget: parseFloat(data.targetNozzleTemp || '0'),
      bedTemp: parseFloat(data.bedTemp0 || '0'),
      bedTarget: parseFloat(data.targetBedTemp0 || '0'),
      boxTemp: parseFloat(data.boxTemp || '0'),
      model: data.model || 'K1',
      printFileName: data.printFileName ? path.basename(data.printFileName) : undefined,
      printProgress: typeof data.printProgress === 'number' ? data.printProgress : parseFloat(data.printProgress || '0'),
      currentLayer: data.layer,
      totalLayers: data.TotalLayer,
      printJobTime: data.printJobTime,
      printLeftTime: data.printLeftTime,
      realTimeSpeed: data.realTimeSpeed ? parseFloat(data.realTimeSpeed).toFixed(0) : undefined,
      curPosition: data.curPosition,
      lightOn: data.lightSw === 1,
      cameraActive: data.video === 1,
      fans: {
        model: data.modelFanPct || 0,
        auxiliary: data.auxiliaryFanPct || 0,
        case: data.caseFanPct || 0,
      },
      message: `Connected to Creality ${data.model || 'K1'} (Port 80/9999)`,
    };
  }

  /**
   * Upload G-code to printer and optionally start printing.
   */
  async uploadAndPrint(gcodeFilePath: string, startPrint: boolean = false): Promise<{ success: boolean; message: string }> {
    if (!fs.existsSync(gcodeFilePath)) {
      throw new Error(`G-code file not found: ${gcodeFilePath}`);
    }

    const filename = path.basename(gcodeFilePath);
    const fileBytes = fs.readFileSync(gcodeFilePath);

    // 1. Try Moonraker first (port 7125) with short timeout
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
      formData.append('file', blob, filename);
      if (startPrint) {
        formData.append('print', 'true');
      }

      const res = await fetch(`http://${this.ip}:${this.moonrakerPort}/server/files/upload`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        return {
          success: true,
          message: `Successfully uploaded ${filename} to Creality K1 via Moonraker.${startPrint ? ' Print started!' : ''}`,
        };
      }
    } catch {}

    // 2. Try Stock Creality OS port 80 upload + port 9999 print start
    try {
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
      formData.append('file', blob, filename);

      const uploadUrl = `http://${this.ip}:${this.webPort}/upload/${encodeURIComponent(filename)}`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        if (startPrint) {
          await this.startPrintCrealityOS(filename);
        }

        return {
          success: true,
          message: `Successfully uploaded ${filename} to Creality K1.${startPrint ? ' Print started on machine!' : ''}`,
        };
      }
    } catch (e: any) {
      // Continue to error throw
    }

    throw new Error(
      `Failed to upload to Creality K1 at ${this.ip}. Make sure Moonraker (port 7125) or Creality OS Web interface is reachable.`
    );
  }

  private startPrintCrealityOS(filename: string): Promise<void> {
    return new Promise((resolve) => {
      const WS = (globalThis as any).WebSocket;
      if (!WS) return resolve();

      const ws = new WS(`ws://${this.ip}:9999`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve();
      }, 3000);

      ws.onopen = () => {
        const msg = {
          method: 'set',
          params: {
            opGcodeFile: `printprt:/usr/data/printer_data/gcodes/${filename}`,
          },
        };
        ws.send(JSON.stringify(msg));

        // Allow K1 1000ms to register the start print job
        setTimeout(() => {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve();
        }, 1000);
      };

      ws.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Send a general JSON command to Creality OS over WebSocket port 9999.
   */
  async sendCommand(payload: Record<string, any>): Promise<boolean> {
    return new Promise((resolve) => {
      const WS = (globalThis as any).WebSocket;
      if (!WS) return resolve(false);

      const ws = new WS(`ws://${this.ip}:9999`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(false);
      }, 2500);

      ws.onopen = () => {
        const msg = {
          method: 'set',
          params: payload,
          ...payload,
        };
        ws.send(JSON.stringify(msg));
        setTimeout(() => {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(true);
        }, 300);
      };

      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /**
   * Toggle the interior LED chamber light.
   */
  async toggleLight(turnOn: boolean): Promise<boolean> {
    return this.sendCommand({ lightSw: turnOn ? 1 : 0 });
  }

  /**
   * Pause the active print job.
   */
  async pausePrint(): Promise<boolean> {
    return this.sendCommand({ pause: 1, reqGcode: 'PAUSE' });
  }

  /**
   * Resume a paused print job.
   */
  async resumePrint(): Promise<boolean> {
    return this.sendCommand({ pause: 0, reqGcode: 'RESUME' });
  }

  /**
   * Cancel/stop the active print job.
   */
  async cancelPrint(): Promise<boolean> {
    return this.sendCommand({ stop: 1, reqGcode: 'CANCEL_PRINT' });
  }

  /**
   * Set target temperatures for nozzle or bed.
   */
  async setTargetTemp(target: 'nozzle' | 'bed', temp: number): Promise<boolean> {
    if (target === 'nozzle') {
      return this.sendCommand({ targetNozzleTemp: temp });
    } else {
      return this.sendCommand({ targetBedTemp0: temp });
    }
  }
}
