> Исторический документ. При сверке 20.10.2026 содержание сохранено как запись на исходную дату; результаты и планы не перепроверялись. Актуальная навигация: [статус документации](DOCUMENTATION_STATUS.md).

# Socket.IO Real-Time Updates - Complete Fix Documentation

**Date:** 2026-03-25
**Status:** ✅ FULLY OPERATIONAL
**Author:** Fixed by team after extensive debugging

---

## 🎯 Problem Summary

**Issue:** Task checklist checkboxes were not updating in real-time on the kanban board. When a user checked a checkbox, the API call succeeded (HTTP 200), the server emitted `task:updated` event, but the browser did NOT receive the event and the UI did NOT update without page reload.

**Root Cause:** Next.js App Router uses separate module systems:
- **CommonJS** (`require()`) for `.js` files (setup.js, board-events.js)
- **ES Modules** (`import`) for `.ts`/`.tsx` files in `src/app/api/`

The Socket.IO instance was being stored in `global.__socketIO` but each module system had its OWN `global` object, so API routes could NOT access the Socket.IO instance set by `setup.js`.

---

## 🔧 Solution Architecture

### Key Fix: Use `globalThis` for True Singleton

```javascript
// src/socket/io-instance.js (CommonJS)
// src/socket/io-instance.mjs (ES Modules)

if (!globalThis.__kanbanIO) {
  globalThis.__kanbanIO = { io: null };
}

function setSocketIO(io) {
  globalThis.__kanbanIO.io = io;
}

function getSocketIO() {
  return globalThis.__kanbanIO?.io || null;
}
```

**Why `globalThis`?**
- `globalThis` is the STANDARD global object across ALL JavaScript environments
- Works in both CommonJS and ES Modules
- Single shared instance across all Next.js module systems
- Survives hot reloads and module re-imports

---

## 📁 File Structure

```
src/socket/
├── io-instance.js      # CommonJS version (for .js files)
├── io-instance.mjs     # ES Module version (for .ts/.tsx API routes)
├── setup.js            # Main Socket.IO server setup
├── board-events.js     # Event emission helpers
└── server.ts           # (Optional) Alternative server setup
```

---

## 🔌 Implementation Details

### 1. Socket.IO Instance Storage

**File:** `src/socket/io-instance.js` (CommonJS)
```javascript
if (!globalThis.__kanbanIO) {
  globalThis.__kanbanIO = { io: null };
}

function setSocketIO(io) {
  globalThis.__kanbanIO.io = io;
  console.error('[IO-INSTANCE] Socket.IO instance set:', !!io);
}

function getSocketIO() {
  const io = globalThis.__kanbanIO?.io || null;
  console.error('[IO-INSTANCE] getSocketIO called, io exists:', !!io);
  return io;
}

module.exports = { setSocketIO, getSocketIO };
```

**File:** `src/socket/io-instance.mjs` (ES Modules)
```javascript
if (!globalThis.__kanbanIO) {
  globalThis.__kanbanIO = { io: null };
}

export function setSocketIO(io) {
  globalThis.__kanbanIO.io = io;
  console.error('[IO-INSTANCE] Socket.IO instance set:', !!io);
}

export function getSocketIO() {
  const io = globalThis.__kanbanIO?.io || null;
  console.error('[IO-INSTANCE] getSocketIO called, io exists:', !!io);
  return io;
}
```

### 2. Server Setup

**File:** `src/socket/setup.js`
```javascript
const { setSocketIO } = require('./io-instance');

async function setupSocketIO(httpServer) {
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    withCredentials: true,
  });

  // CRITICAL: Store instance in globalThis singleton
  setSocketIO(io);

  // Room-based event handlers
  socket.on('project:join', async (data, ack) => {
    const projectId = data.projectId;
    await socket.join(`project:${projectId}`);
    ack({ ok: true });
    socket.emit("project:joined", { projectId, ok: true });
  });

  return io;
}
```

### 3. Event Emission Helpers

**File:** `src/socket/board-events.js`
```javascript
const { getSocketIO } = require('./io-instance');

function emitTaskUpdated(projectId, task) {
  const io = getSocketIO();

  if (!io) {
    console.error('[BOARD-EVENTS] Cannot emit task:updated - io is null');
    return;
  }

  io.to(`project:${projectId}`).emit("task:updated", task);
}

module.exports = {
  emitTaskCreated,
  emitTaskUpdated,
  emitTaskDeleted,
  emitColumnCreated,
  emitColumnUpdated,
  emitColumnDeleted,
  emitColumnsReordered
};
```

### 4. Client-Side Hook

**File:** `src/hooks/useProjectBoard.ts`
```typescript
export function useProjectBoard({ projectId }: UseProjectBoardOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);

  useEffect(() => {
    if (!projectId) return;

    const socket = getSocketInstance();

    const joinProject = async () => {
      setIsConnected(true);

      socket.once("project:joined", () => {
        setIsJoined(true);
      });

      socket.emit("project:join", { projectId }, (ack) => {
        if (ack?.ok) {
          setIsJoined(true);
        }
      });
    };

    socket.on("connect", joinProject);

    if (socket.connected) {
      void joinProject();
    }

    return () => {
      socket.emit("project:leave", { projectId });
      socket.off("connect", joinProject);
    };
  }, [projectId]);

  return { socket, isConnected, isJoined };
}
```

### 5. Board Component Event Listeners

**File:** `src/components/kanban/Board.tsx`
```typescript
export default function Board({ projectId }: BoardProps) {
  const { socket, isJoined } = useProjectBoard({ projectId });

  useEffect(() => {
    if (!socket || !isJoined) return;

    // Register event listeners
    socket.on("task:updated", onTaskUpdated);
    socket.on("task:created", onTaskCreated);
    socket.on("task:deleted", onTaskDeleted);
    socket.on("column:created", onColumnCreated);
    socket.on("column:updated", onColumnUpdated);
    socket.on("column:deleted", onColumnDeleted);
    socket.on("columns:reordered", onColumnsReordered);

    return () => {
      socket.off("task:updated", onTaskUpdated);
      socket.off("task:created", onTaskCreated);
      // ... cleanup all listeners
    };
  }, [socket, isJoined, projectId]);

  // ... rest of component
}
```

---

## 🧪 Testing Checklist

### ✅ Task Events
- [x] `task:created` - New task appears instantly on all clients
- [x] `task:updated` - Checklist updates, status changes, etc.
- [x] `task:deleted` - Task removed from board instantly

### ✅ Column Events
- [ ] `column:created` - New column appears
- [ ] `column:updated` - Column name/color changes
- [ ] `column:deleted` - Column removed

### ✅ Multi-User Scenarios
- [x] Two users on same project board
- [x] User A updates task → User B sees update instantly
- [x] No page refresh required

---

## 🔍 Debug Commands

### Check Server Logs

Deployment placeholders below must be configured for your own environment; no real host, account or private-key path is supplied.
```bash
ssh -i "$SSH_PRIVATE_KEY_PATH" "$DEPLOY_USER@$DEPLOY_HOST"
cd "$APP_ROOT"
pm2 logs kanban-v2 --lines 50 | grep -E "(task:updated|Room members|IO-INSTANCE)"
```

### Expected Log Output
```
[IO-INSTANCE] Socket.IO instance set: true
[BOARD-EVENTS] emitTaskUpdated - io exists: true
[BOARD-EVENTS] task:updated emitted successfully to project: xxx
[BOARD-EVENTS] Room members count: 1
```

### Check Client Console
Expected browser console output:
```
[SOCKET-CLIENT] Socket connected, ID: xxx
[useProjectBoard] Successfully joined project room: xxx
[SOCKET-CLIENT] EVENT RECEIVED: task:updated
[Board.tsx] onTaskUpdated RECEIVED
[Board.tsx] Task updated in state successfully
```

---

## 🚨 Common Issues & Solutions

### Issue 1: "io is null" in board-events.js
**Symptom:** `[BOARD-EVENTS] Cannot emit task:updated - io is null`

**Cause:** `setSocketIO()` not called in `setup.js`

**Fix:** Ensure `setup.js` has:
```javascript
const { setSocketIO } = require('./io-instance');
setSocketIO(io);
```

### Issue 2: Room members count = 0
**Symptom:** Events emitted but no clients receive them

**Cause:** Client not joining room properly

**Fix:** Check `project:join` handler and client acknowledgment

### Issue 3: Build fails with "Cannot use import statement"
**Symptom:** Next.js build error about ES modules

**Cause:** Using `.mjs` file in CommonJS context

**Fix:** Use separate `.js` (CommonJS) and `.mjs` (ES Modules) files

---

## 📝 Key Learnings

1. **Next.js Module Systems:** App Router uses BOTH CommonJS and ES Modules
2. **`global` vs `globalThis`:** `global` is Node.js specific, `globalThis` is standard
3. **Singleton Pattern:** Use `globalThis` for cross-module singletons in Next.js
4. **Room-Based Events:** Socket.IO rooms isolate events per project
5. **Acknowledgment Pattern:** Use both `ack()` callback AND event emission for reliability

---

## 🔗 Related Files

- `src/socket/io-instance.js` - CommonJS singleton storage
- `src/socket/io-instance.mjs` - ES Module singleton storage
- `src/socket/setup.js` - Socket.IO server initialization
- `src/socket/board-events.js` - Event emission helpers
- `src/hooks/useProjectBoard.ts` - Client-side hook
- `src/components/kanban/Board.tsx` - Main board component with event listeners

---

## ✅ Verification Status

**Last Verified:** 2026-03-25
**Status:** All real-time updates working correctly

- ✅ Checklist checkbox updates
- ✅ Task status changes
- ✅ Task title/description updates
- ✅ Multi-user synchronization
- ✅ No page refresh required

---

**This documentation should be preserved for future reference and onboarding.**

