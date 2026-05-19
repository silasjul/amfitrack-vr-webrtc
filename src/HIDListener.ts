import HID from "node-hid";
import { VENDOR_ID, PRODUCT_ID_SENSOR, PRODUCT_ID_SOURCE } from "./config";

export type HIDDataCallback = (data: Buffer, device: HID.Device) => void;

const MATCHING_PRODUCT_IDS = new Set<number>([
  PRODUCT_ID_SENSOR,
  PRODUCT_ID_SOURCE,
]);

export class HIDListener {
  private readonly callback: HIDDataCallback;
  private readonly open = new Map<string, HID.HID>();
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(callback: HIDDataCallback) {
    this.callback = callback;
  }

  start(scanIntervalMs = 1000): void {
    if (this.scanTimer !== null) return;
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const device of this.open.values()) {
      device.close();
    }
    this.open.clear();
  }

  private scan(): void {
    const devices = HID.devices().filter(
      (d) =>
        d.vendorId === VENDOR_ID &&
        d.productId !== undefined &&
        MATCHING_PRODUCT_IDS.has(d.productId),
    );

    const seenPaths = new Set<string>();
    for (const info of devices) {
      if (!info.path) continue;
      seenPaths.add(info.path);
      if (this.open.has(info.path)) continue;
      this.openDevice(info);
    }

    for (const path of [...this.open.keys()]) {
      if (!seenPaths.has(path)) {
        this.open.get(path)?.close();
        this.open.delete(path);
      }
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
      // device may have been unplugged between scan and open; ignore
    }
  }
}
