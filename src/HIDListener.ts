import HID from "node-hid";
import { VENDOR_ID, PRODUCT_ID_SENSOR, PRODUCT_ID_SOURCE } from "./config";

export type HIDDataCallback = (data: Buffer, device: HID.Device) => void;

const MATCHING_PRODUCT_IDS = new Set<number>([
  PRODUCT_ID_SENSOR,
  PRODUCT_ID_SOURCE,
]);
const REPORT_ID = 0x01;
const REPORT_SIZE = 64;

export class HIDListener {
  private readonly callback: HIDDataCallback;
  private readonly open = new Map<string, HID.HID>();
  private scanTimer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(callback: HIDDataCallback) {
    this.callback = callback;
  }

  // Slow default (5s): once a device is open we only need scans for hot-plug.
  // HID.devices() can stall hundreds of ms on Windows and steals the libuv
  // thread that handles node-hid reads — at 1s it caused a ~1Hz stream stutter.
  start(scanIntervalMs = 5000): void {
    if (this.scanTimer) return;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const device of this.open.values()) device.close();
    this.open.clear();
  }

  // Broadcast to every open Amfitrack HID device. Wire layout matches the
  // browser SDK's HIDConnection: byte 0 = report ID, bytes 1..64 = payload.
  write(bytes: Uint8Array): void {
    const report = new Array<number>(REPORT_SIZE).fill(0);
    report[0] = REPORT_ID;
    const len = Math.min(bytes.length, REPORT_SIZE - 1);
    for (let i = 0; i < len; i++) report[i + 1] = bytes[i]!;

    for (const [path, device] of this.open) {
      try {
        device.write(report);
      } catch {
        try { device.close(); } catch { /* ignore */ }
        this.open.delete(path);
      }
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const all = await HID.devicesAsync();
      const matching = all.filter(
        (d) =>
          d.vendorId === VENDOR_ID &&
          d.productId !== undefined &&
          MATCHING_PRODUCT_IDS.has(d.productId),
      );

      const seen = new Set<string>();
      for (const info of matching) {
        if (!info.path) continue;
        seen.add(info.path);
        if (!this.open.has(info.path)) this.openDevice(info);
      }

      for (const path of [...this.open.keys()]) {
        if (!seen.has(path)) {
          this.open.get(path)?.close();
          this.open.delete(path);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private openDevice(info: HID.Device): void {
    if (!info.path) return;
    const path = info.path;
    try {
      const device = new HID.HID(path);
      device.on("data", (data: Buffer) => this.callback(data, info));
      device.on("error", () => {
        device.close();
        this.open.delete(path);
      });
      this.open.set(path, device);
    } catch {
      // device may have been unplugged between scan and open
    }
  }
}
