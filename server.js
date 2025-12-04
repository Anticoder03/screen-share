// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { v4: uuid } = require("uuid");
const WebSocket = require("ws");

const { WebSocketServer } = WebSocket;

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const rooms = new Map(); // roomCode -> { adminId, participants: Set<socketId> }
const sockets = new Map(); // socketId -> { ws, roomCode, role }

function shortRoomCode() {
  return uuid().split("-")[0].toUpperCase();
}

function safeSend(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function sendToSocket(socketId, type, payload = {}) {
  const entry = sockets.get(socketId);
  if (!entry) return;
  safeSend(entry.ws, { type, ...payload });
}

function cleanupSocket(socketId) {
  const entry = sockets.get(socketId);
  if (!entry) return;

  const { roomCode } = entry;

  if (roomCode && rooms.has(roomCode)) {
    const room = rooms.get(roomCode);

    if (room.adminId === socketId) {
      room.participants.forEach((participantId) => {
        sendToSocket(participantId, "room_closed");
        const participant = sockets.get(participantId);
        if (participant) {
          participant.roomCode = null;
          participant.role = null;
        }
      });
      rooms.delete(roomCode);
    } else {
      room.participants.delete(socketId);
    }
  }

  sockets.delete(socketId);
}

function handleCreateRoom(socketId) {
  const entry = sockets.get(socketId);
  if (!entry) return;

  const roomCode = shortRoomCode();
  rooms.set(roomCode, {
    adminId: socketId,
    participants: new Set()
  });

  entry.roomCode = roomCode;
  entry.role = "admin";

  sendToSocket(socketId, "room_created", { roomCode });
  console.log("Room created:", roomCode);
}

function handleJoinRoom(socketId, payload) {
  const entry = sockets.get(socketId);
  if (!entry) return;

  const requestedCode = (payload?.roomCode || "").trim().toUpperCase();
  if (!requestedCode || !rooms.has(requestedCode)) {
    sendToSocket(socketId, "room_error", { message: "Room does not exist" });
    return;
  }

  const room = rooms.get(requestedCode);
  room.participants.add(socketId);

  entry.roomCode = requestedCode;
  entry.role = "viewer";

  sendToSocket(socketId, "room_joined", { roomCode: requestedCode });
  sendToSocket(room.adminId, "viewer_joined", { viewerId: socketId });
  console.log(`Viewer ${socketId} joined room ${requestedCode}`);
}

function handleOffer(socketId, payload) {
  const entry = sockets.get(socketId);
  if (!entry || entry.role !== "admin") return;

  const { viewerId, offer } = payload || {};
  if (!viewerId || !offer) return;

  const room = rooms.get(entry.roomCode);
  if (!room || !room.participants.has(viewerId)) return;

  sendToSocket(viewerId, "receive_offer", { offer, adminId: socketId });
}

function handleAnswer(socketId, payload) {
  const { adminId, answer } = payload || {};
  if (!adminId || !answer) return;

  sendToSocket(adminId, "receive_answer", {
    viewerId: socketId,
    answer
  });
}

function handleIceCandidate(socketId, payload) {
  const { target, candidate } = payload || {};
  if (!target || !candidate) return;

  sendToSocket(target, "ice_candidate", { candidate, from: socketId });
}

function handleMessage(socketId, data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  const { type, ...rest } = parsed;

  switch (type) {
    case "create_room":
      handleCreateRoom(socketId);
      break;
    case "join_room":
      handleJoinRoom(socketId, rest);
      break;
    case "send_offer":
      handleOffer(socketId, rest);
      break;
    case "send_answer":
      handleAnswer(socketId, rest);
      break;
    case "ice_candidate":
      handleIceCandidate(socketId, rest);
      break;
    default:
      break;
  }
}

wss.on("connection", (ws) => {
  const socketId = uuid();
  sockets.set(socketId, { ws, roomCode: null, role: null });

  safeSend(ws, { type: "socket_id", socketId });
  console.log("WebSocket connected:", socketId);

  ws.on("message", (message) => handleMessage(socketId, message.toString()));
  ws.on("close", () => {
    cleanupSocket(socketId);
    console.log("WebSocket disconnected:", socketId);
  });
  ws.on("error", () => cleanupSocket(socketId));
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/api/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
