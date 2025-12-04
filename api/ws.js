export const config = {
  runtime: "edge"
};

const rooms = new Map(); // roomCode -> { adminId, participants: Set<socketId> }
const sockets = new Map(); // socketId -> { socket, roomCode, role }

function shortRoomCode() {
  return crypto.randomUUID().split("-")[0].toUpperCase();
}

function safeSend(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    console.error("Failed to send message", err);
  }
}

function sendToSocket(socketId, type, payload = {}) {
  const entry = sockets.get(socketId);
  if (!entry) return;
  safeSend(entry.socket, { type, ...payload });
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

export default function handler(request) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const { 0: client, 1: server } = new WebSocketPair();
  const socketId = crypto.randomUUID();

  sockets.set(socketId, { socket: server, roomCode: null, role: null });

  server.accept();
  safeSend(server, { type: "socket_id", socketId });

  server.addEventListener("message", (event) =>
    handleMessage(socketId, event.data)
  );
  server.addEventListener("close", () => cleanupSocket(socketId));
  server.addEventListener("error", () => cleanupSocket(socketId));

  return new Response(null, { status: 101, webSocket: client });
}

