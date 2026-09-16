## Technical Specification: Cadero
Status: Approved | Reference Architecture: v1.0.0 | Compiler Target: Node 20+
------------------------------
## 1. Local Daemon (@cadero/cli)
The local daemon is a Node.js-based Command Line Interface distributed via npm. It acts as an orchestrator, spawning pseudoterminals (PTYs), managing state locally, and holding outbound socket connections.
## 1.1 Process Management & Shell Emulation
To run fully interactive tools like Claude Code and OpenCode without clipping styling, character codes, or tab completions, the daemon uses native bindings instead of simple child_process.spawn.

* Core Dependency: node-pty (forked/maintained variant supporting pre-built binaries for Node 20/22+ across Windows, macOS, and Linux).
* Process Spawning Configuration:

import * as pty from 'node-pty';
const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORCE_COLOR: '3', // Forces 256-color support down downstream CLIs
    CADERO_ACTIVE: 'true'
  }
});


## 1.2 State Machine & Stream Parsing
The CLI acts as a pass-through layer, analyzing chunks of data from stdout for known interactive prompt markers before passing them up.

                  ┌──────────────────────┐
                  │  Incoming PTY Chunk  │
                  └──────────┬───────────┘
                             │
                             ▼
               /───────────────────────────\
              <  Matches Prompt Signature?  >
               \───────────────────────────/
                             │
                  ┌──────────┴──────────┐
               No │                 Yes │
                  ▼                     ▼
        ┌──────────────────┐   ┌──────────────────┐
        │ Emit Raw Stream  │   │ Intercept State  │
        │  to WebSocket    │   │  & Alert Mobile  │
        └──────────────────┘   └──────────────────┘


* Intercept Rule Definitions:
* Claude Code Intercept: Catches sequence patterns resembling confirmation text or key blocks requiring manual overrides (e.g., Execute tool? [y/N], Press Enter to continue).
   * OpenCode Intercept: Catches continuous processing cycles matching waiting parameters.
* Safe-Command Verification: A local validation matrix matches incoming calls with entries in .caderorc. If a tool triggers a system command mapped inside the user's local configuration file, the engine skips mobile confirmation entirely and safely triggers ptyProcess.write('y\n').

------------------------------
## 2. Cloud Relay Layer (@cadero/relay)
The Cloud Relay is designed for low latency, memory caching, and zero tracking data collection. It routes frames between client pairs while handling sudden connections/disconnections safely.
## 2.1 Technology & Framework Choice

* Core Framework: Fastify (chosen over Express for its performance, native TypeScript implementation, and minimal routing footprint).
* WebSocket Provider: @fastify/websocket (built on top of the performant ws package).
* Pub/Sub Broker: Redis cluster.

## 2.2 Room Lifecycle & Schema Specs
The Cloud Relay tracks rooms entirely in RAM using Redis. When a user requests a session pair, they receive a unique room_id.
## WebSocket JSON Protocol Schema## 1. Stream Terminal Buffers (CLI -> Mobile)

{
  "event": "TERMINAL_DATA",
  "meta": { "timestamp": 1714838400 },
  "payload": {
    "chunk": "\u001b[32mI will now scan the directory...\u001b[0m"
  }
}

## 2. Challenge Intercept (CLI -> Mobile)

{
  "event": "INTERCEPT_REQUIRED",
  "meta": { "session_id": "sess_91823" },
  "payload": {
    "agent": "claude",
    "reason": "EXECUTE_COMMAND",
    "command": "rm -rf ./dist && npm run build"
  }
}

## 3. Process Resolve Intent (Mobile -> CLI)

{
  "event": "RESOLVE_INTERCEPT",
  "meta": { "session_id": "sess_91823" },
  "payload": {
    "decision": "APPROVE",
    "input_payload": null
  }
}

------------------------------
## 3. Mobile Web App (@cadero/mobile)
The front-end client acts as a fast PWA using modern, framework-independent visual rendering utilities.
## 3.1 Stack Elements

* Framework: Next.js (App Router) using standard Static Site Generation (SSG) configurations for edge deployments.
* Visual Engine: Tailwind CSS.
* Terminal Engine: xterm.js + xterm-addon-fit.

## 3.2 Canvas-Based Stream Rendering
Instead of populating a simple text area with logs, a dedicated terminal canvas renders color codes, tab interfaces, dynamic menus, and interactive frames properly.

import { Terminal } from 'xterm';import { FitAddon } from 'xterm-addon-fit';
const term = new Terminal({
  cursorBlink: true,
  theme: { background: '#0f172a' }, // Tailwind slate-900
  allowProposedApi: true
});const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
// On Message Hook:
socket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.event === 'TERMINAL_DATA') {
    term.write(data.payload.chunk);
  }
};

------------------------------
## 4. End-to-End Cryptographic Handshake
To ensure absolute privacy even if the cloud relay infrastructure is compromised, Cadero uses an end-to-end (E2E) cryptographic layer.

[Local Desktop CLI]               [Cloud Relay]               [Mobile Client Browser]
         │                               │                               │
         │ 1. Generate AES-GCM Key       │                               │
         │    & Render QR with Plaintext │                               │
         ├───────────────────────────────┼───────────────────────────────┤
         │                               │                               │ Scan QR Code
         │                               │                               ├───────────────┐
         │                               │                               │ Extract Key   │
         │                               │                               │ & Room ID     │
         │                               │                               │◄──────────────┘
         │                               │                               │
         │ 2. Send Encrypted Payloads    │                               │
         ├──────────────────────────────►│ 3. Forward Encrypted Frame    │
         │    (Ciphertext Only)          ├──────────────────────────────►│
         │                               │    (No Decryption Possible)   │ 4. Decrypt via
         │                               │                               │    In-Memory Key


   1. Local Key Generation: When npx cadero runs, it generates a cryptographically secure, single-session AES-GCM 256-bit symmetric key in memory.
   2. QR Compilation: The generated symmetric key and target room_id are combined into a URL string encoded within a terminal-rendered QR code. This key never leaves the terminal.
   3. Session Handshake: Scanning the QR code passes the secret key directly into the mobile browser's local memory (window.crypto.subtle).
   4. Zero-Knowledge Transport: The local daemon encrypts payloads before transmission. The cloud relay reads only the routing header (room_id), while the encrypted block travels completely unreadable until it reaches the mobile client.


