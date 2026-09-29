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
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
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

    // Fallback: check stock web port
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
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

  /**
   * Upload G-code to printer and optionally start printing.
   */
  async uploadAndPrint(gcodeFilePath: string, startPrint: boolean = false): Promise<{ success: boolean; message: string }> {
    if (!fs.existsSync(gcodeFilePath)) {
      throw new Error(`G-code file not found: ${gcodeFilePath}`);
    }

    const filename = path.basename(gcodeFilePath);
    const fileBytes = fs.readFileSync(gcodeFilePath);

    // Try Moonraker first (port 7125)
    try {
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
      formData.append('file', blob, filename);
      if (startPrint) {
        formData.append('print', 'true');
      }

      const res = await fetch(`http://${this.ip}:${this.moonrakerPort}/server/files/upload`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        return {
          success: true,
          message: `Successfully uploaded ${filename} to Creality K1 via Moonraker.${startPrint ? ' Print started!' : ''}`,
        };
      }
    } catch (e: any) {
      // Continue to fallback
    }

    // Try Stock Creality OS port 80 upload
    try {
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
      formData.append('file', blob, filename);

      const res = await fetch(`http://${this.ip}:${this.webPort}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        return {
          success: true,
          message: `Successfully uploaded ${filename} to Creality K1 via Stock Web Interface.`,
        };
      }
    } catch (e: any) {
      // Failure
    }

    throw new Error(
      `Failed to upload to Creality K1 at ${this.ip}. Make sure Moonraker (port 7125) or Creality OS Web interface is reachable.`
    );
  }
}
