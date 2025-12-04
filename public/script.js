// public/script.js

const socket = createSignalingClient();
let mySocketId = null;
socket.on("socket_id", ({ socketId }) => {
  mySocketId = socketId;
});

let localStream = null;
let roomCode = null;
let isAdmin = false;

// For admin: store peerConnections per viewer
const peerConnections = {};
const pendingViewers = new Set();

// For viewer: only one peerConnection
let viewerPeer = null;
let viewerAdminId = null;
const bufferedViewerCandidates = [];

const iceServers = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

// =============================================================
// SOCKET EVENT WIRING
// =============================================================
socket.on("room_created", ({ roomCode: createdCode }) => {
  if (!isAdmin) return;
  roomCode = createdCode;

  const codeEl = document.getElementById("roomCode");
  if (codeEl) codeEl.innerText = createdCode;
});

socket.on("viewer_joined", ({ viewerId }) => {
  if (!isAdmin) return;
  if (!viewerId) return;

  if (localStream) {
    createAdminPeerConnection(viewerId);
  } else {
    pendingViewers.add(viewerId);
  }
});

socket.on("room_joined", ({ roomCode: joinedCode }) => {
  if (isAdmin || joinedCode !== roomCode) return;
  startViewerWebRTC();
});

socket.on("room_error", ({ message }) => {
  if (isAdmin) return;
  alert(message || "Unable to join room");
});

socket.on("receive_answer", ({ viewerId, answer }) => {
  if (!isAdmin) return;
  const pc = peerConnections[viewerId];
  if (!pc) return;

  pc.setRemoteDescription(answer).catch((err) => {
    console.error("Failed to set remote description:", err);
  });
});

socket.on("receive_offer", async ({ offer, adminId }) => {
  if (isAdmin) return;

  if (!viewerPeer) {
    startViewerWebRTC();
  }

  viewerAdminId = adminId;
  flushBufferedViewerCandidates();

  try {
    await viewerPeer.setRemoteDescription(offer);
    const answer = await viewerPeer.createAnswer();
    await viewerPeer.setLocalDescription(answer);

    if (mySocketId) {
      socket.emit("send_answer", {
        adminId,
        answer,
        viewerId: mySocketId
      });
    }
  } catch (err) {
    console.error("Error handling offer:", err);
  }
});

socket.on("ice_candidate", async ({ candidate, from }) => {
  if (!candidate) return;

  try {
    if (isAdmin) {
      const pc = peerConnections[from];
      if (pc) await pc.addIceCandidate(candidate);
    } else if (viewerPeer) {
      await viewerPeer.addIceCandidate(candidate);
    }
  } catch (err) {
    console.error("Error adding ICE candidate:", err);
  }
});

socket.on("room_closed", () => {
  alert("Admin left. Room is closed.");
  resetViewerPeer();
  window.location.reload();
});

// =============================================================
// ADMIN: CREATE ROOM
// =============================================================
function createRoom() {
  if (roomCode) return;
  isAdmin = true;
  socket.emit("create_room");
}

// =============================================================
// VIEWER: JOIN ROOM
// =============================================================
function joinRoom() {
  const joinInput = document.getElementById("joinCode");
  const code = joinInput ? joinInput.value.trim() : "";

  if (!code) {
    alert("Enter room code first!");
    return;
  }

  roomCode = code.toUpperCase();
  isAdmin = false;
  resetViewerPeer();

  socket.emit("join_room", { roomCode });
}

// =============================================================
// ADMIN: CREATE PeerConnection FOR EACH VIEWER
// =============================================================
async function createAdminPeerConnection(viewerId) {
  if (!localStream || !mySocketId) {
    pendingViewers.add(viewerId);
    return;
  }

  if (peerConnections[viewerId]) {
    peerConnections[viewerId].close();
  }

  const pc = new RTCPeerConnection(iceServers);
  peerConnections[viewerId] = pc;

  // Add admin’s screen tracks
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice_candidate", {
        target: viewerId,
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      pc.close();
      delete peerConnections[viewerId];
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (!mySocketId) return;

    socket.emit("send_offer", {
      viewerId,
      offer,
      adminId: mySocketId
    });
  } catch (err) {
    console.error("Error creating offer:", err);
  }

  pendingViewers.delete(viewerId);
}

// =============================================================
// ADMIN: START SCREEN SHARE
// =============================================================
async function startScreenShare() {
  if (!isAdmin || !roomCode) {
    alert("Create a room before sharing your screen.");
    return;
  }

  if (localStream) {
    alert("Screen sharing is already active.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

    const videoEl = document.getElementById("myVideo");
    if (videoEl) {
      videoEl.srcObject = localStream;
    }

    // Create connections for any viewers who joined before sharing was ready
    pendingViewers.forEach((viewerId) => createAdminPeerConnection(viewerId));
  } catch (err) {
    console.error("Screen share error:", err);
  }
}

// =============================================================
// VIEWER: WebRTC Setup
// =============================================================
function startViewerWebRTC() {
  if (viewerPeer) return;

  viewerPeer = new RTCPeerConnection(iceServers);

  viewerPeer.ontrack = (event) => {
    const videoEl = document.getElementById("viewerVideo");
    if (videoEl) {
      videoEl.srcObject = event.streams[0];
    }
  };

  viewerPeer.onicecandidate = (event) => {
    if (!event.candidate) return;

    if (viewerAdminId) {
      socket.emit("ice_candidate", {
        target: viewerAdminId,
        candidate: event.candidate
      });
    } else {
      bufferedViewerCandidates.push(event.candidate);
    }
  };
}

function flushBufferedViewerCandidates() {
  if (!viewerAdminId || !bufferedViewerCandidates.length) return;

  bufferedViewerCandidates.splice(0).forEach((candidate) => {
    socket.emit("ice_candidate", {
      target: viewerAdminId,
      candidate
    });
  });
}

function resetViewerPeer() {
  if (viewerPeer) {
    viewerPeer.ontrack = null;
    viewerPeer.onicecandidate = null;
    viewerPeer.close();
    viewerPeer = null;
  }
  viewerAdminId = null;
  bufferedViewerCandidates.length = 0;
}

// =============================================================
// FULLSCREEN
// =============================================================
function goFullScreen() {
  const video = document.getElementById("viewerVideo");
  if (video && video.requestFullscreen) {
    video.requestFullscreen();
  }
}

// =============================================================
// SIGNALING CLIENT
// =============================================================
function resolveWebSocketUrl() {
  if (window.WS_ENDPOINT) return window.WS_ENDPOINT;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/ws`;
}

function createSignalingClient() {
  const listeners = new Map();
  const queuedMessages = [];
  const ws = new WebSocket(resolveWebSocketUrl());
  let isOpen = false;

  ws.addEventListener("open", () => {
    isOpen = true;
    while (queuedMessages.length) {
      ws.send(queuedMessages.shift());
    }
  });

  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const { type, ...rest } = payload;
    const handlers = listeners.get(type);
    if (handlers) {
      handlers.forEach((handler) => handler(rest));
    }
  });

  ws.addEventListener("close", () => {
    console.warn("Signaling connection closed. Refresh to reconnect.");
  });

  ws.addEventListener("error", (err) => {
    console.error("Signaling error:", err);
  });

  function emit(type, payload = {}) {
    const message = JSON.stringify({ type, ...payload });

    if (isOpen && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      queuedMessages.push(message);
    }
  }

  function on(type, handler) {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type).add(handler);
  }

  return { emit, on };
}
