## Product Requirement Document (PRD)## Project: Cadero
Status: Draft | Author: AI Collaborator | Target Launch: Q4 2026
------------------------------
## 1. Executive Summary & Value Proposition
Cadero is an open-source, self-hostable meta-harness and remote orchestrator for local AI coding agents (such as Claude Code and OpenCode). It bridges the gap between terminal-bound local AI power and mobile convenience, allowing software engineers to monitor, prompt, and approve agent actions on their local development machines from a secure mobile web interface while away from their desks.
## Core Philosophy

* Zero-Knowledge Cloud: No user code, repository files, or AI API keys ever touch or reside on Cadero cloud servers.
* Local Final Veto: The local terminal daemon always maintains absolute command execution authority over incoming mobile requests.
* Effortless Deployment: Up and running via a single CLI command on the desktop and a responsive web client for mobile.

------------------------------
## 2. System Architecture Overview
The system relies on a three-tier architecture to securely bridge local execution with remote control without requiring complex network configuration.

┌─────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│      Cadero CLI        │       │  Cadero Cloud Relay   │       │   Cadero Mobile App   │
│   (User's Local PC)     │       │     (Multi-Tenant)     │       │    (Responsive PWA)    │
├─────────────────────────┤       ├────────────────────────┤       ├────────────────────────┤
│ • Local Node-PTY        │ ◄───► │ • Room-based Router    │ ◄───► │ • xterm.js Streamer    │
│ • Local Auth State      │  WSS  │ • GitHub OAuth Portal  │  WSS  │ • Intent Dispatcher    │
│ • Intent Validation     │       │ • Redis Pub/Sub        │       │ • Interactive Prompter │
└─────────────────────────┘       └────────────────────────┘       └────────────────────────┘

------------------------------
## 3. Detailed Feature Requirements## 3.1 Cadero CLI (Local Desktop Daemon)
The local component runs inside the user's terminal, interfacing with the local codebase and AI tool configurations.

* Outbound WebSocket Client: Initiates an encrypted outbound connection (wss://) to the Cloud Relay. This eliminates the need for users to configure home router port forwarding or firewalls.
* Dynamic Process Management (node-pty): Spawns terminal processes for native agents (claude, opencode) via pseudo-terminals to preserve text formatting and interactive workflows.
* Local Intercept Engine: Parses incoming tool streams. When an agent requests a confirmation (e.g., Execute command? (y/n)), the CLI pauses the stream and dispatches a standard schema structured event to the cloud room.
* Command Safelist Config: Reads a local .caderorc configuration file allowing users to define safe commands (e.g., npm test, git status) that can bypass explicit mobile confirmation.

## 3.2 Cadero Cloud Relay (The Router)
A thin orchestration layer designed for multi-tenancy and data isolation.

* GitHub OAuth Authentication: Authenticates users and generates unique, transient pairing channels.
* Isolated Multi-Tenant Session Rooms: Utilizes a Redis-backed Pub/Sub architecture to ensure data from User_A_Mobile can exclusively pass to User_A_Desktop.
* Zero-Retention Pipeline: The relay behaves as a network pipe. Messages are streamed linearly and never persisted to a database disk, ensuring zero log footprint.

## 3.3 Cadero Mobile Interface (Responsive Web Portal / PWA)
A mobile-optimized web application structured for real-time visibility.

* Real-time Terminal Stream: Renders agent progress dynamically using an active terminal canvas component (xterm.js).
* Intent-Driven Input UI: Allows the user to type unstructured natural language prompts which are wrapped into explicit EXECUTE_AGENT_PROMPT actions before dispatching.
* Binary Overlay Triggers: Displays distinct UI overlay states (Action Required) with prominent visual green/red interactive confirmation items whenever the local terminal catches an agent prompt blocker.

------------------------------
## 4. Security & Isolation Specification
Security is the primary barrier to user adoption for this project. The following boundaries are non-negotiable:

| Scenario | Risk | Mitigation Strategy |
|---|---|---|
| Relay Compromise | Malicious actor breaks into the central cloud relay server. | Intent Isolation: The mobile client cannot emit raw Bash commands. It only triggers abstract high-level intents. The local daemon validates all strings against an internal strict parsing engine before appending them to the engine subshell. |
| API Key Leakage | Exposure of high-cost Anthropic or OpenAI API keys. | Local-Only Secret Storage: Cadero servers do not collect or request user credentials. The CLI relies natively on pre-authenticated active environment keys or machine sessions established via claude auth login. |
| Man-In-The-Middle | Network interception of source code strings. | Forced Transport Encryption: Strict enforcement of TLS/HTTPS protocols (wss://). The architecture supports complete end-to-end payload encryption keys generated locally during terminal pairing. |

------------------------------
## 5. User Experience & Sequence Flow

[Mobile Interface]                 [Cloud Relay]                  [Local Desktop CLI]
        │                                │                                │
        │ 1. Connects to Room (Auth)     │                                │
        ├───────────────────────────────►│                                │
        │                                │ 2. Connects & Pairs to Room    │
        │                                │◄───────────────────────────────┤
        │                                │                                │
        │ 3. Dispatches Agent Prompt     │                                │
        ├───────────────────────────────►│                                │
        │                                │ 4. Relays JSON Intent          │
        │                                ├───────────────────────────────►│
        │                                │                                │ 5. Local Runner Executes
        │                                │                                │    Agent Tool Subprocess
        │                                │                                │
        │                                │ 6. Streams Live stdout Buffers │
        │                                │◄───────────────────────────────┤
        │ 7. Renders Terminal Feed       │                                │
        │◄───────────────────────────────┤                                │

------------------------------
## 6. Release & Distribution Strategy
To drive organic open-source adoption, the onboarding path is split into two straightforward profiles:
## Open-Source Self-Host Configuration
For security teams or enthusiasts who refuse to connect to a third-party relay:

* Provide a clean docker-compose.yml that stands up the Web UI, Node WebSocket server, and a local Redis container in one click.
* Custom environment configuration handles alternative root domains: CADERO_RELAY_URL=https://my-private-server.com.

## Cadero Public Multi-Tenant Cloud
For developers who want an immediate, turn-key configuration setup:

   1. Run npx cadero-cli login on their development machine (authenticates with Github and configures the environment).
   2. Scan the generated terminal QR code with a smartphone to link securely to the running session room.


