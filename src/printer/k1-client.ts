import fs from 'node:fs';
import path from 'node:path';

export interface PrinterStatus {
  connected: boolean;
  state?: string;
  extruderTemp?: number;
  extruderTarget?: number;
  bedTemp?: number;
  bedTarget?: number;
  message?: string;
  model?: string;
  printFileName?: string;
  printProgress?: number;
}

export class K1PrinterClient {
  private ip: string;
  private moonrakerPort: number;
  private webPort: number;

  constructor(printerIp: string, moonrakerPort: number = 7125, webPort: number = 80) {
    this.ip = printerIp.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.moonrakerPort = moonrakerPort;
    this.webPort = webPort;
  }

  /**
   * Check connection and fetch status from Moonraker or stock Creality OS.
   */
  async getStatus(): Promise<PrinterStatus> {
    // 1. Try Moonraker (port 7125) with short timeout
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 800);
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

    // 2. Try Creality OS WebSocket (port 9999) for real-time telemetry
    try {
      const wsStatus = await this.getStatusFromCrealityWS();
      if (wsStatus) {
        return wsStatus;
      }
    } catch {}

    // 3. Fallback: check stock web port (port 80)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
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
          resolve(null);
        }
      }, 1500);

      try {
        ws = new WS(`ws://${this.ip}:9999`);
        ws.onmessage = (event: any) => {
          try {
            const data = JSON.parse(event.data);
            if (data.nozzleTemp !== undefined || data.bedTemp0 !== undefined) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                try { ws.close(); } catch {}

                let state = 'ready';
                if (data.state === 2 || (data.printFileName && data.printFileName !== '')) {
                  state = 'printing';
                }

                resolve({
                  connected: true,
                  state,
                  extruderTemp: parseFloat(data.nozzleTemp || '0'),
                  bedTemp: parseFloat(data.bedTemp0 || '0'),
                  model: data.model || 'K1',
                  printFileName: data.printFileName ? path.basename(data.printFileName) : undefined,
                  printProgress: data.printProgress,
                  message: `Connected to Creality ${data.model || 'K1'} (Port 80/9999)`,
                });
              }
            }
          } catch {}
        };
        ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(null);
          }
        };
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
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
}
