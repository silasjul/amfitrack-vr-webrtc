import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import wrtc from "@roamhq/wrtc";
import { HIDListener } from "./HIDListener";

const { RTCPeerConnection } = wrtc;

const PORT = Number(process.env["PORT"] ?? 8080);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const CERT_DIR = path.resolve(__dirname, "../certificates");

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(CERT_DIR, "192.168.137.1.pem")),
    key: fs.readFileSync(path.join(CERT_DIR, "192.168.137.1-key.pem")),
  },
  (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", path: req.url }));
  }
);

// Active data channels to fan HID packets out to.
const channels = new Set<RTCDataChannel>();

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (signal) => {
  const pc = new RTCPeerConnection({ iceServers: [] });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signal.send(JSON.stringify({ type: "ice", candidate }));
  };

  pc.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => channels.add(channel);
    channel.onclose = () => channels.delete(channel);
    channel.onerror = () => channels.delete(channel);
  };

  signal.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "offer") {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal.send(JSON.stringify({ type: "answer", sdp: pc.localDescription }));
      } else if (msg.type === "ice" && msg.candidate) {
        await pc.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      console.error("signaling error", err);
    }
  });

  signal.on("close", () => pc.close());
});

const listener = new HIDListener((data) => {
  // node-hid prepends the HID report ID as byte 0 for devices that use one
  // (amfitrack uses different IDs per report type — e.g. 0x02 for source
  // input). Strip it so the wire format matches what the browser SDK's
  // decoder expects (it slices subarray(1, 8) for the header, which assumes
  // byte 0 is a non-packet prefix that came from a fresh, no-report-ID
  // WebHID buffer).
  const frame = data.length > 0 ? data.subarray(1) : data;
  const packet = Uint8Array.from(frame);
  for (const ch of channels) {
    if (ch.readyState === "open") ch.send(packet);
  }
});
listener.start();

server.listen(PORT, HOST, () => {
  console.log(`WebRTC signaling server listening on https://192.168.137.1:${PORT}`);
});

const shutdown = (): void => {
  listener.stop();
  for (const ch of channels) ch.close();
  wss.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
