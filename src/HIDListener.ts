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

  // Default is intentionally slow: HID.devices() walks every HID endpoint on
  // the system and on Windows it can stall for hundreds of ms even via the
  // async API. Once a device is open we only need this for hot-plug, so 5s
  // is plenty. Was 1000ms — caused a periodic ~1Hz stutter in the WebRTC
  // stream because each scan briefly stole the libuv thread that handles
  // node-hid reads.
  start(scanIntervalMs = 5000): void {
    if (this.scanTimer !== null) return;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), scanIntervalMs);
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

  private scanning = false;

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const all = await HID.devicesAsync();
      const devices = all.filter(
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
      // device may have been unplugged between scan and open; ignore
    }
  }
}
