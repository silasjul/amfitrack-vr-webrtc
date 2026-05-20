import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import wrtc from "@roamhq/wrtc";
import { HIDListener } from "./HIDListener";

const { RTCPeerConnection } = wrtc;

const PORT = 8080;
const HOST = "192.168.137.1";
const CERT_DIR = path.resolve(__dirname, "../certificates");

// HID -> data channels: every open channel gets every HID frame. The protocol
// packet carries its own routing info so we broadcast and let the SDK filter.
// Strip byte 0 (node-hid prepends the HID report ID) so the wire format
// matches what the browser SDK's decoder expects from a WebHID buffer.
const channels = new Set<RTCDataChannel>();
const listener = new HIDListener((data) => {
  if (data.length === 0) return;
  const packet = Uint8Array.from(data.subarray(1));
  for (const ch of channels) {
    if (ch.readyState === "open") ch.send(packet);
  }
});

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(CERT_DIR, "192.168.137.1.pem")),
    key: fs.readFileSync(path.join(CERT_DIR, "192.168.137.1-key.pem")),
  },
  (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  },
);

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (signal) => {
  const pc = new RTCPeerConnection({ iceServers: [] });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && signal.readyState === signal.OPEN) {
      signal.send(JSON.stringify({ type: "ice", candidate }));
    }
  };

  pc.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => channels.add(channel);
    channel.onclose = () => channels.delete(channel);
    channel.onerror = () => channels.delete(channel);
    channel.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      if (bytes.length > 0) listener.write(bytes);
    };
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

listener.start();
server.listen(PORT, HOST, () => {
  console.log(`WebRTC signaling server listening on https://${HOST}:${PORT}`);
});

const shutdown = (): void => {
  listener.stop();
  for (const ch of channels) ch.close();
  wss.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
