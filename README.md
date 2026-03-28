# Claude Branch Tree Viewer

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green.svg)
![Claude.ai](https://img.shields.io/badge/Claude.ai-userscript-purple.svg)

**[日本語はこちら / Japanese](README.ja.md)**

> A Tampermonkey userscript that visualizes Claude.ai conversation branches as an interactive tree — jump to any message, collapse subtrees, label nodes, and navigate complex conversations with ease.

Claude.ai supports conversation branching (editing a previous message creates a new branch), but there is no built-in way to see the full branch structure at a glance. This script adds a floating tree panel that maps out every branch, so you always know where you are and can jump anywhere instantly.

<img width="746" height="541" alt="Branch Tree Viewer screenshot" src="https://github.com/user-attachments/assets/1584c0bb-23bc-40ca-8274-9dda28ebbc01" />

## Features

### 🌳 Tree View

Extracts user messages from the conversation and displays them as a hierarchical tree. The currently active branch is highlighted so you can see exactly which path you're on.

<!-- ![tree view](screenshots/tree-view.png) -->

### 🎯 Node Jump

Click any node in the tree to scroll directly to that message in the chat. The target message briefly highlights to help you spot it. Navigating long conversations with dozens of branches becomes effortless.

<!-- ![node jump](screenshots/node-jump.gif) -->

### 📂 Collapsible Branches

Click the ▼ icon to collapse a subtree, just like Notion's toggle blocks. Collapse state is saved per conversation in your browser, so it persists across page reloads.

### 🔢 Branch Count Markers

When a node has multiple child branches, a marker like `[3]` appears to show how many branches diverge from that point.

### 🏷️ Custom Labels

Double-click any node to rename it. By default, nodes show the first ~40 characters of the message, but you can replace this with your own label — for example, "Approach A", "Final version", or "Dead end". Labels are stored permanently in your browser.

### ⌨️ Keyboard Shortcut

Press **Alt + B** to toggle the panel. You can customize this by editing the `SHORTCUT` object at the top of the script:

```javascript
const SHORTCUT = {
  key:   'b',     // the key to press
  alt:   true,    // require Alt?
  ctrl:  false,   // require Ctrl?
  shift: false,   // require Shift?
};
```

### 🔄 Live Updates

The tree updates automatically when you send new messages, receive responses, or switch branches — no manual refresh needed. Uses both a MutationObserver (for instant detection) and a background poll (as a fallback).

### 🖱️ Draggable & Resizable Panel

Drag the header to move the panel anywhere on screen. Resize from any edge or corner. Position and size are saved and restored on next visit.

### 🌙 Dark / Light Mode

Automatically matches Claude.ai's theme. Works in both dark mode and light mode.

## Installation

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** for your browser (Chrome, Firefox, Edge, etc.)
2. **[Click here to install the script](https://raw.githubusercontent.com/Sc5N6A9L/claude-branch-tree-viewer/main/branch-tree-viewer.user.js)**
3. Click **"Install"** on the Tampermonkey dialog that appears
4. Open [claude.ai](https://claude.ai) — a branch icon (⎇) appears in the top toolbar

> Also available on **[Greasy Fork](https://greasyfork.org/en/scripts/571332-claude-branch-tree-viewer)**

## Usage

1. Open any conversation on [claude.ai](https://claude.ai)
2. Click the **branch icon** in the toolbar (or press **Alt + B**)
3. The tree panel opens showing your conversation structure
4. **Single-click** a node → scrolls to that message in the chat
5. **Double-click** a node → edit its label
6. **Click ▼** → collapse/expand a subtree
7. **Drag the header** → reposition the panel
8. **Drag any edge/corner** → resize the panel

## Compatibility

| | Supported |
|---|---|
| **Browsers** | Chrome, Firefox, Edge (any browser that supports Tampermonkey) |
| **Script Managers** | Tampermonkey, Violentmonkey, Greasemonkey |
| **Tested on** | Claude.ai (March 2026) |

> **Note:** Claude.ai's internal DOM and API structure may change without notice.

## How It Works

The script calls Claude.ai's internal conversation API (`/api/organizations/.../chat_conversations/...?tree=True`) to retrieve the full message tree, including all branches. It then filters for human (user) messages, builds a hierarchical tree structure, and renders it in a floating panel. The active branch is determined by `current_leaf_message_uuid` from the API response.

No data is sent to any external server. Everything runs locally in your browser.

## Known Issues / Limitations

- **Branch switching by arrow buttons:** When you use Claude.ai's built-in branch-switching arrows (◀ ▶), the tree updates within ~1.5 seconds (polling interval). The MutationObserver catches most changes faster, but some edge cases rely on the poll.
- **Very large conversations:** Conversations with hundreds of branches may cause slight rendering delays.
- **DOM changes:** If Anthropic updates Claude.ai's frontend structure, the toolbar button injection or message detection may break. The core tree logic (API-based) is more resilient.

## License

[MIT](LICENSE)
