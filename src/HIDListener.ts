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

  // Send a packet to every open Amfitrack HID device. Mirrors the read-side
  // fanout: the protocol packet (in `bytes`) carries its own routing info,
  // so we broadcast and let firmware ignore packets not addressed to it.
  // Layout matches what the browser SDK's HIDConnection produces: byte 0 is
  // the HID report ID (0x01), bytes 1..64 are the report payload.
  write(bytes: Uint8Array): void {
    const REPORT_ID = 0x01;
    const REPORT_SIZE = 64;
    const report = new Array<number>(REPORT_SIZE).fill(0);
    report[0] = REPORT_ID;
    const payloadLen = Math.min(bytes.length, REPORT_SIZE - 1);
    for (let i = 0; i < payloadLen; i++) report[i + 1] = bytes[i]!;

    for (const [path, device] of this.open) {
      try {
        device.write(report);
      } catch {
        // Device likely just unplugged — drop it; next scan will reopen.
        try { device.close(); } catch { /* ignore */ }
        this.open.delete(path);
      }
    }
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
