import http from "node:http";
import { WebSocketServer } from "ws";
import wrtc from "@roamhq/wrtc";
import { HIDListener } from "./HIDListener";

const { RTCPeerConnection } = wrtc;

const PORT = Number(process.env["PORT"] ?? 8080);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", path: req.url }));
});

// Active data channels to fan HID packets out to.
const channels = new Set<RTCDataChannel>();

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (signal) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

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
  console.log(data.toString("hex"));
  const packet = Uint8Array.from(data);
  for (const ch of channels) {
    if (ch.readyState === "open") ch.send(packet);
  }
});
listener.start();

server.listen(PORT, HOST, () => {
  console.log(`WebRTC signaling server listening on http://${HOST}:${PORT}`);
});

const shutdown = (): void => {
  listener.stop();
  for (const ch of channels) ch.close();
  wss.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
