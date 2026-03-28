// ==UserScript==
// @name         Claude Branch Tree Viewer
// @namespace    http://tampermonkey.net/
// @version      0.8.2
// @description  Notion風トグル折畳・リサイズ対応・スクロール保持・キーボードショートカット対応
// @author       You
// @match        https://claude.ai/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ========================================
  // ショートカットキー設定
  // ここを編集してパネルの表示/非表示ショートカットを変更できます。
  //
  // 設定例:
  //   key:  'b'  →  実際に押すキーの文字（小文字）
  //   alt:   true / false  →  Altキーを組み合わせるか
  //   ctrl:  true / false  →  Ctrlキーを組み合わせるか
  //   shift: true / false  →  Shiftキーを組み合わせるか
  //
  // デフォルト: Alt+B
  // ========================================
  const SHORTCUT = {
    key:   'b',
    alt:   true,
    ctrl:  false,
    shift: false,
  };

  // ========================================
  // 定数
  // ========================================
  const ROOT_UUID = '00000000-0000-4000-8000-000000000000';
  const PREVIEW_LEN = 40;
  const LABELS_KEY = 'cbt_labels';
  const GEOMETRY_KEY = 'cbt_geometry';
  const COLLAPSED_KEY = 'cbt_collapsed';
  const CLICK_DELAY = 250;
  const POLL_INTERVAL = 1500;
  const INDENT_PX = 20;

  const USER_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-message-author-role="user"]',
    '.human-turn',
    '.message.user',
  ];

  // ========================================
  // モジュールスコープの状態
  // ========================================
  const state = {
    pollIntervalId: null,
    lastLeafUuid: null,
    lastMsgCount: 0,
  };

  // 折り畳み状態（会話単位で管理）
  let collapsedNodes = new Set();
  let currentConvUuid = null;

  // ブランチ切り替え検知用
  let branchObserver = null;
  let branchCheckTimer = null;

  // ========================================
  // ラベル永続化
  // ========================================
  function loadLabels() {
    try {
      return JSON.parse(GM_getValue(LABELS_KEY, '{}'));
    } catch {
      return {};
    }
  }

  function saveLabels(labels) {
    GM_setValue(LABELS_KEY, JSON.stringify(labels));
  }

  // ========================================
  // 折り畳み状態の永続化
  // ========================================
  function loadCollapsed(convUuid) {
    try {
      const all = JSON.parse(GM_getValue(COLLAPSED_KEY, '{}'));
      return new Set(all[convUuid] || []);
    } catch {
      return new Set();
    }
  }

  function saveCollapsed(convUuid, collapsed) {
    try {
      const all = JSON.parse(GM_getValue(COLLAPSED_KEY, '{}'));
      all[convUuid] = [...collapsed];
      const keys = Object.keys(all);
      if (keys.length > 50) {
        for (const k of keys.slice(0, keys.length - 50)) delete all[k];
      }
      GM_setValue(COLLAPSED_KEY, JSON.stringify(all));
    } catch {}
  }

  // ========================================
  // ジオメトリ永続化
  // ========================================
  function loadGeometry() {
    try {
      return JSON.parse(GM_getValue(GEOMETRY_KEY, '{}'));
    } catch {
      return {};
    }
  }

  let geoSaveTimer = null;
  function saveGeometryDebounced(panel) {
    if (geoSaveTimer) clearTimeout(geoSaveTimer);
    geoSaveTimer = setTimeout(() => {
      const rect = panel.getBoundingClientRect();
      GM_setValue(
        GEOMETRY_KEY,
        JSON.stringify({
          width: panel.offsetWidth,
          height: panel.offsetHeight,
          top: rect.top,
          left: rect.left,
        })
      );
    }, 400);
  }

  function restoreGeometry(panel) {
    const geo = loadGeometry();
    if (geo.width && geo.width >= 280) panel.style.width = geo.width + 'px';
    if (geo.height && geo.height >= 180) panel.style.height = geo.height + 'px';
    if (geo.top != null && geo.left != null) {
      const safeTop = Math.max(0, Math.min(geo.top, window.innerHeight - 80));
      const safeLeft = Math.max(0, Math.min(geo.left, window.innerWidth - 120));
      panel.style.top = safeTop + 'px';
      panel.style.left = safeLeft + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }

  // ========================================
  // API
  // ========================================
  let cachedOrgId = null;

  async function getOrgId() {
    if (cachedOrgId) return cachedOrgId;
    const res = await fetch('/api/organizations');
    if (!res.ok) throw new Error('organizations API failed');
    const orgs = await res.json();
    cachedOrgId = orgs[0]?.uuid;
    return cachedOrgId;
  }

  function getConvUuidFromUrl() {
    const m = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/);
    return m ? m[1] : null;
  }

  async function fetchTree(convUuid) {
    const orgId = await getOrgId();
    const url = `/api/organizations/${orgId}/chat_conversations/${convUuid}?tree=True&rendering_mode=messages&render_all_tools=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('conversation API failed');
    return res.json();
  }

  // ========================================
  // ツリー構築
  // ========================================
  function buildTree(messages) {
    const nodes = {};
    const childrenMap = {};

    messages.forEach((msg) => {
      nodes[msg.uuid] = msg;
      const parent = msg.parent_message_uuid || ROOT_UUID;
      if (!childrenMap[parent]) childrenMap[parent] = [];
      childrenMap[parent].push(msg.uuid);
    });

    for (const key in childrenMap) {
      childrenMap[key].sort(
        (a, b) => new Date(nodes[a].created_at) - new Date(nodes[b].created_at)
      );
    }

    const roots = childrenMap[ROOT_UUID] || [];
    return { nodes, childrenMap, roots };
  }

  function buildHumanOnlyTree(fullTree) {
    const { nodes, childrenMap } = fullTree;
    const humanChildren = {};
    const humanRoots = [];

    function collectHumanDescendants(uuid) {
      const children = childrenMap[uuid] || [];
      const result = [];
      for (const childUuid of children) {
        const child = nodes[childUuid];
        if (!child) continue;
        if (child.sender === 'human') {
          result.push(childUuid);
        } else {
          result.push(...collectHumanDescendants(childUuid));
        }
      }
      return result;
    }

    const rootChildren = childrenMap[ROOT_UUID] || [];
    for (const uuid of rootChildren) {
      const node = nodes[uuid];
      if (!node) continue;
      if (node.sender === 'human') {
        humanRoots.push(uuid);
      } else {
        humanRoots.push(...collectHumanDescendants(uuid));
      }
    }

    function buildRecursive(humanUuid) {
      const descendants = collectHumanDescendants(humanUuid);
      humanChildren[humanUuid] = descendants;
      for (const desc of descendants) {
        buildRecursive(desc);
      }
    }

    for (const rootUuid of humanRoots) {
      buildRecursive(rootUuid);
    }

    return { nodes, humanChildren, humanRoots };
  }

  function extractText(msg) {
    if (msg.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          return block.text.replace(/\n/g, ' ').trim();
        }
      }
    }
    if (msg.text) return msg.text.replace(/\n/g, ' ').trim();
    return '';
  }

  function preview(text, len) {
    if (!text) return '(empty)';
    let w = 0;
    let result = '';
    for (const ch of text) {
      const cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
      if (w + cw > len) return result + '…';
      result += ch;
      w += cw;
    }
    return result;
  }

  // ========================================
  // アクティブパス
  // ========================================
  function buildActivePath(nodes, currentLeafUuid) {
    const activeSet = new Set();
    if (!currentLeafUuid) return activeSet;
    let uuid = currentLeafUuid;
    while (uuid && uuid !== ROOT_UUID) {
      activeSet.add(uuid);
      const node = nodes[uuid];
      if (!node) break;
      uuid = node.parent_message_uuid;
    }
    return activeSet;
  }

  // ========================================
  // チャット上のユーザーメッセージDOM要素を収集
  // ========================================
  function collectUserMessageEls() {
    for (const sel of USER_SELECTORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const arr = Array.from(els).filter(
            (el) => el.textContent.trim().length > 0
          );
          for (const el of arr) {
            el._sortTop = el.getBoundingClientRect().top + window.scrollY;
          }
          arr.sort((a, b) => a._sortTop - b._sortTop);
          return arr;
        }
      } catch (_) {}
    }
    return [];
  }

  // ========================================
  // ダークモード判定
  // ========================================
  function isDarkMode() {
    const attrs = [
      document.documentElement.dataset.theme,
      document.documentElement.dataset.mode,
      document.body.dataset.theme,
      document.documentElement.getAttribute('data-color-scheme'),
    ].filter(Boolean);
    for (const attr of attrs) {
      if (attr.includes('dark')) return true;
      if (attr.includes('light')) return false;
    }
    if (
      document.documentElement.classList.contains('dark') ||
      document.body.classList.contains('dark')
    )
      return true;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ========================================
  // ハイライト＋スクロール
  // ========================================
  function highlightAndScroll(el) {
    if (!el) return;
    const prevBgColor = el.style.backgroundColor;
    const prevTransition = el.style.transition;
    const color = isDarkMode()
      ? 'rgba(105, 82, 220, 0.3)'
      : 'rgba(105, 82, 220, 0.15)';
    el.style.transition = 'background-color 0.4s ease';
    el.style.backgroundColor = color;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      el.style.backgroundColor = prevBgColor;
      setTimeout(() => {
        el.style.transition = prevTransition;
      }, 400);
    }, 1000);
  }

  // ========================================
  // レンダリング
  // ========================================
  function renderTree(container, fullTree, activePath) {
    const savedScroll = container.scrollTop;

    container.innerHTML = '';
    const humanTree = buildHumanOnlyTree(fullTree);
    const labels = loadLabels();
    const userMessageEls = collectUserMessageEls();

    if (humanTree.humanRoots.length === 0) {
      container.textContent = '(空の会話)';
      return;
    }

    const activeHumanOrdered = [];
    function collectActiveInOrder(uuid) {
      if (activePath.has(uuid)) activeHumanOrdered.push(uuid);
      const children = humanTree.humanChildren[uuid] || [];
      for (const childUuid of children) collectActiveInOrder(childUuid);
    }
    for (const rootUuid of humanTree.humanRoots) {
      collectActiveInOrder(rootUuid);
    }

    let clickTimer = null;

    function render(parentEl, uuid, depth, siblings, siblingIndex) {
      const node = humanTree.nodes[uuid];
      if (!node) return;

      const children = humanTree.humanChildren[uuid] || [];
      const hasChildren = children.length > 0;
      const siblingCount = siblings.length;
      const isActive = activePath.has(uuid);
      const isCollapsed = collapsedNodes.has(uuid);

      const nodeEl = document.createElement('div');
      nodeEl.className = 'cbt-node';

      const row = document.createElement('div');
      row.className = 'cbt-row' + (isActive ? ' cbt-active' : '');
      row.dataset.uuid = uuid;
      row.style.paddingLeft = (depth - 1) * INDENT_PX + 'px';

      // トグルアイコン
      const toggle = document.createElement('span');
      toggle.className = 'cbt-toggle';
      if (hasChildren) {
        toggle.textContent = isCollapsed ? '\u25B6' : '\u25BC';
        toggle.classList.add('cbt-toggle-parent');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const nowCollapsed = collapsedNodes.has(uuid);
          if (nowCollapsed) {
            collapsedNodes.delete(uuid);
          } else {
            collapsedNodes.add(uuid);
          }
          const childrenEl = nodeEl.querySelector(':scope > .cbt-children');
          if (childrenEl) {
            childrenEl.style.display = collapsedNodes.has(uuid) ? 'none' : '';
          }
          toggle.textContent = collapsedNodes.has(uuid) ? '\u25B6' : '\u25BC';
          if (currentConvUuid) saveCollapsed(currentConvUuid, collapsedNodes);
        });
      } else {
        toggle.textContent = '\u25B8';
        toggle.classList.add('cbt-toggle-leaf');
      }

      // 番号
      const numSpan = document.createElement('span');
      numSpan.className = 'cbt-number';
      const numberLabel =
        siblingCount <= 1
          ? String(depth)
          : depth + '.' + (siblingIndex + 1);
      numSpan.textContent = numberLabel;

      // 分岐マーカー
      let branchMarker = null;
      if (siblingCount > 1 && siblingIndex === 0) {
        branchMarker = document.createElement('span');
        branchMarker.className = 'cbt-branch-marker';
        branchMarker.textContent = '[' + siblingCount + ']';
      }

      // テキスト（ラベル）
      const textSpan = document.createElement('span');
      textSpan.className = 'cbt-text';
      const savedLabel = labels[uuid];
      const defaultText = preview(extractText(node), PREVIEW_LEN);
      textSpan.textContent = savedLabel || '';

      row.appendChild(toggle);
      row.appendChild(numSpan);
      if (branchMarker) row.appendChild(branchMarker);
      row.appendChild(textSpan);

      // --- イベント ---
      row.addEventListener('click', (e) => {
        if (e.target.closest('.cbt-toggle-parent')) return;
        if (row.querySelector('.cbt-edit-input')) return;
        e.stopPropagation();

        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          return;
        }

        clickTimer = setTimeout(() => {
          clickTimer = null;
          let targetUuid = null;
          if (isActive) {
            targetUuid = uuid;
          } else {
            for (const sib of siblings) {
              if (activePath.has(sib)) {
                targetUuid = sib;
                break;
              }
            }
          }
          if (targetUuid) {
            const idx = activeHumanOrdered.indexOf(targetUuid);
            if (idx >= 0 && idx < userMessageEls.length) {
              highlightAndScroll(userMessageEls[idx]);
            }
          }
        }, CLICK_DELAY);
      });

      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('.cbt-toggle')) return;
        if (row.querySelector('.cbt-edit-input')) return;
        e.stopPropagation();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        startEdit(row, uuid, textSpan, defaultText);
      });

      nodeEl.appendChild(row);

      if (hasChildren) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'cbt-children';
        if (isCollapsed) childrenEl.style.display = 'none';
        for (let i = 0; i < children.length; i++) {
          render(childrenEl, children[i], depth + 1, children, i);
        }
        nodeEl.appendChild(childrenEl);
      }

      parentEl.appendChild(nodeEl);
    }

    for (let i = 0; i < humanTree.humanRoots.length; i++) {
      render(
        container,
        humanTree.humanRoots[i],
        1,
        humanTree.humanRoots,
        i
      );
    }

    container.scrollTop = savedScroll;
  }

  // ========================================
  // インライン編集
  // ========================================
  function startEdit(row, uuid, textSpan, defaultText) {
    if (row.querySelector('.cbt-edit-input')) return;

    const labels = loadLabels();
    const currentValue = labels[uuid] || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cbt-edit-input';
    input.value = currentValue;
    input.placeholder = defaultText;

    textSpan.style.display = 'none';
    textSpan.parentNode.insertBefore(input, textSpan.nextSibling);
    input.focus();
    input.select();

    function commit() {
      const val = input.value.trim();
      const labels = loadLabels();
      if (val === '') {
        delete labels[uuid];
        textSpan.textContent = '';
      } else {
        labels[uuid] = val;
        textSpan.textContent = val;
      }
      saveLabels(labels);
      cleanup();
    }

    function cancel() {
      cleanup();
    }

    function cleanup() {
      input.remove();
      textSpan.style.display = '';
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.body.contains(input)) commit();
      }, 50);
    });
  }

  // ========================================
  // ブランチ切り替え即時検知（MutationObserver）
  // ========================================
  function ensureBranchObserver() {
    if (branchObserver) return;
    const target = document.querySelector('main');
    if (!target) return;

    branchObserver = new MutationObserver((mutations) => {
      const panel = document.getElementById('cbt-panel');
      if (!panel || !panel.classList.contains('cbt-visible')) return;

      let hasChildChange = false;
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          hasChildChange = true;
          break;
        }
      }
      if (!hasChildChange) return;

      if (branchCheckTimer) clearTimeout(branchCheckTimer);
      branchCheckTimer = setTimeout(() => quickBranchCheck(), 500);
    });

    branchObserver.observe(target, { childList: true, subtree: true });
  }

  async function quickBranchCheck() {
    const convUuid = getConvUuidFromUrl();
    if (!convUuid) return;
    try {
      const data = await fetchTree(convUuid);
      const newLeaf = data.current_leaf_message_uuid;
      const newCount = data.chat_messages ? data.chat_messages.length : 0;
      if (newLeaf === state.lastLeafUuid && newCount === state.lastMsgCount) return;

      state.lastLeafUuid = newLeaf;
      state.lastMsgCount = newCount;

      if (convUuid !== currentConvUuid) {
        currentConvUuid = convUuid;
        collapsedNodes = loadCollapsed(convUuid);
      }

      const tree = buildTree(data.chat_messages);
      const activePath = buildActivePath(tree.nodes, newLeaf);
      const body = document.getElementById('cbt-body');
      if (body) renderTree(body, tree, activePath);
    } catch (_) {}
  }

  // ========================================
  // ポーリング（バックアップ用）
  // ========================================
  function startPolling() {
    if (state.pollIntervalId) return;
    state.pollIntervalId = setInterval(async () => {
      const panel = document.getElementById('cbt-panel');
      if (!panel || !panel.classList.contains('cbt-visible')) return;

      const convUuid = getConvUuidFromUrl();
      if (!convUuid) return;

      try {
        const data = await fetchTree(convUuid);
        const newLeaf = data.current_leaf_message_uuid;
        const newMsgCount = data.chat_messages ? data.chat_messages.length : 0;

        if (newLeaf === state.lastLeafUuid && newMsgCount === state.lastMsgCount) {
          return;
        }

        state.lastLeafUuid = newLeaf;
        state.lastMsgCount = newMsgCount;

        const tree = buildTree(data.chat_messages);
        const activePath = buildActivePath(tree.nodes, newLeaf);

        const body = document.getElementById('cbt-body');
        if (body) renderTree(body, tree, activePath);
      } catch (_) {}
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
  }

  // ========================================
  // パネルの表示/非表示を切り替える共通関数
  // ========================================
  function togglePanel() {
    const panel = document.getElementById('cbt-panel');
    if (!panel) return;
    const show = !panel.classList.contains('cbt-visible');
    panel.classList.toggle('cbt-visible', show);
    if (show) {
      loadAndRender();
      startPolling();
      ensureBranchObserver();
    } else {
      stopPolling();
    }
  }

  // ========================================
  // キーボードショートカット
  // ========================================
  document.addEventListener('keydown', (e) => {
    // SHORTCUT 設定と照合
    if (
      e.key.toLowerCase() === SHORTCUT.key.toLowerCase() &&
      e.altKey   === SHORTCUT.alt   &&
      e.ctrlKey  === SHORTCUT.ctrl  &&
      e.shiftKey === SHORTCUT.shift
    ) {
      // 修飾キー（Alt / Ctrl / Shift）を一切使わない素のキーショートカットの場合のみ
      // テキスト入力中はスキップ（誤入力防止）。
      // Alt+B などの修飾キーありは入力欄でも常に動作させる。
      const hasModifier = SHORTCUT.alt || SHORTCUT.ctrl || SHORTCUT.shift;
      if (!hasModifier) {
        const tag = document.activeElement?.tagName;
        const isEditing =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          document.activeElement?.isContentEditable;
        if (isEditing) return;
      }

      e.preventDefault();
      togglePanel();
    }
  }, true); // キャプチャフェーズで登録してサイト側ハンドラより優先させる

  // ========================================
  // UI（フローティングパネル）
  // ========================================
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'cbt-panel';
    panel.innerHTML = `
      <div id="cbt-header">
        <span id="cbt-title">Branch Tree</span>
        <div id="cbt-header-btns">
          <button id="cbt-refresh" title="更新">↻</button>
          <button id="cbt-close" title="閉じる">✕</button>
        </div>
      </div>
      <div id="cbt-body">
        <div id="cbt-placeholder">チャットページで開いてください</div>
      </div>
    `;
    document.body.appendChild(panel);

    restoreGeometry(panel);
    setupDrag(panel, panel.querySelector('#cbt-header'));
    setupResize(panel);

    panel.querySelector('#cbt-close').onclick = () => {
      panel.classList.remove('cbt-visible');
      stopPolling();
    };
    panel.querySelector('#cbt-refresh').onclick = () => loadAndRender();

    return panel;
  }

  function setupDrag(panel, handle) {
    let dragging = false;
    let sx, sy, sl, st;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = panel.getBoundingClientRect();
      sl = r.left;
      st = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = sl + (e.clientX - sx) + 'px';
      panel.style.top = st + (e.clientY - sy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        saveGeometryDebounced(panel);
      }
    });
  }

  // ========================================
  // カスタムリサイズ（4辺 + 4角）
  // ========================================
  function setupResize(panel) {
    const HANDLE = 6;
    const CORNER = 14;
    const MIN_W = 260;
    const MIN_H = 180;

    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const cursors = {
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      nw: 'nwse-resize', se: 'nwse-resize',
    };

    for (const dir of dirs) {
      const h = document.createElement('div');
      h.className = 'cbt-resize-handle';
      h.dataset.dir = dir;
      h.style.position = 'absolute';
      h.style.zIndex = '10';
      h.style.cursor = cursors[dir];

      const isCorner = dir.length === 2;
      if (isCorner) {
        h.style.width = CORNER + 'px';
        h.style.height = CORNER + 'px';
        if (dir.includes('n')) h.style.top = '0';
        if (dir.includes('s')) h.style.bottom = '0';
        if (dir.includes('e')) h.style.right = '0';
        if (dir.includes('w')) h.style.left = '0';
      } else {
        switch (dir) {
          case 'n':
            h.style.top = '0'; h.style.left = CORNER + 'px';
            h.style.right = CORNER + 'px'; h.style.height = HANDLE + 'px';
            break;
          case 's':
            h.style.bottom = '0'; h.style.left = CORNER + 'px';
            h.style.right = CORNER + 'px'; h.style.height = HANDLE + 'px';
            break;
          case 'e':
            h.style.right = '0'; h.style.top = CORNER + 'px';
            h.style.bottom = CORNER + 'px'; h.style.width = HANDLE + 'px';
            break;
          case 'w':
            h.style.left = '0'; h.style.top = CORNER + 'px';
            h.style.bottom = CORNER + 'px'; h.style.width = HANDLE + 'px';
            break;
        }
      }
      panel.appendChild(h);
    }

    let resizing = false;
    let resizeDir = '';
    let startX, startY, startRect;

    panel.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.cbt-resize-handle');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      resizeDir = handle.dataset.dir;
      startX = e.clientX;
      startY = e.clientY;
      startRect = {
        top: panel.offsetTop,
        left: panel.offsetLeft,
        width: panel.offsetWidth,
        height: panel.offsetHeight,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = cursors[resizeDir];
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dir = resizeDir;

      let newW = startRect.width;
      let newH = startRect.height;
      let newTop = startRect.top;
      let newLeft = startRect.left;

      if (dir.includes('e')) newW = Math.max(MIN_W, startRect.width + dx);
      if (dir.includes('w')) {
        newW = Math.max(MIN_W, startRect.width - dx);
        newLeft = startRect.left + (startRect.width - newW);
      }
      if (dir.includes('s')) newH = Math.max(MIN_H, startRect.height + dy);
      if (dir.includes('n')) {
        newH = Math.max(MIN_H, startRect.height - dy);
        newTop = startRect.top + (startRect.height - newH);
      }

      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
      panel.style.top = newTop + 'px';
      panel.style.left = newLeft + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        saveGeometryDebounced(panel);
      }
    });
  }

  function injectToolbarButton() {
    if (document.getElementById('cbt-toolbar-btn')) return;
    const toolbar = document.querySelector(
      'div.relative.flex-1.flex.items-center.shrink.min-w-0'
    );
    if (!toolbar) return;
    const ref = toolbar.querySelector('div.flex.flex-row.items-center.min-w-0');
    if (!ref) return;

    const wrap = document.createElement('div');
    wrap.className = 'relative shrink-0';
    const btn = document.createElement('button');
    btn.id = 'cbt-toolbar-btn';
    btn.type = 'button';
    btn.title = 'Branch Tree';
    btn.className =
      'inline-flex items-center justify-center relative shrink-0 can-focus select-none ' +
      'disabled:pointer-events-none disabled:opacity-50 border border-transparent transition ' +
      'font-base duration-300 h-8 w-8 rounded-md active:scale-95 !rounded-lg ' +
      'hover:!bg-bg-200 active:!scale-100 !pointer-events-auto !outline-offset-1 text-text-300';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none"
      viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round">
      <line x1="6" y1="3" x2="6" y2="15"/>
      <circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
      <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>`;
    btn.onclick = () => togglePanel();
    wrap.appendChild(btn);
    toolbar.insertBefore(wrap, ref);
  }

  // ========================================
  // データ読み込み → 描画
  // ========================================
  async function loadAndRender() {
    const body = document.getElementById('cbt-body');
    if (!body) return;
    const convUuid = getConvUuidFromUrl();
    if (!convUuid) {
      body.innerHTML =
        '<div id="cbt-placeholder">チャットページで開いてください</div>';
      return;
    }

    if (convUuid !== currentConvUuid) {
      currentConvUuid = convUuid;
      collapsedNodes = loadCollapsed(convUuid);
    }

    body.innerHTML = '<div id="cbt-placeholder">読み込み中…</div>';
    try {
      const data = await fetchTree(convUuid);
      const tree = buildTree(data.chat_messages);

      state.lastLeafUuid = data.current_leaf_message_uuid;
      state.lastMsgCount = data.chat_messages ? data.chat_messages.length : 0;

      const activePath = buildActivePath(
        tree.nodes,
        data.current_leaf_message_uuid
      );

      renderTree(body, tree, activePath);
    } catch (e) {
      body.innerHTML = `<div id="cbt-placeholder">エラー: ${e.message}</div>`;
    }
  }

  // ========================================
  // URL変更の監視 & 起動
  // ========================================
  let lastUrl = '';

  function onPageChange() {
    const url = location.href;
    if (url === lastUrl) {
      if (!document.getElementById('cbt-toolbar-btn')) {
        injectToolbarButton();
      }
      ensureBranchObserver();
      return;
    }
    lastUrl = url;

    state.lastLeafUuid = null;
    state.lastMsgCount = 0;

    injectToolbarButton();
    ensureBranchObserver();

    const panel = document.getElementById('cbt-panel');
    if (panel && panel.classList.contains('cbt-visible')) {
      loadAndRender();
    }
  }

  if (!document.getElementById('cbt-panel')) {
    createPanel();
  }

  const obs = new MutationObserver(() => onPageChange());
  obs.observe(document.body, { childList: true, subtree: true });
  onPageChange();

  // ========================================
  // スタイル
  // ========================================
  GM_addStyle(`
    /* ============ パネル本体 ============ */
    #cbt-panel {
      position: fixed;
      top: 237px;
      left: 5px;
      width: 304px;
      height: 429px;
      min-width: 260px;
      min-height: 180px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      overflow: hidden;
      font-family: "Anthropic Sans", system-ui, "Segoe UI", sans-serif;
      font-size: 14.5px;
      line-height: 1.5;
      box-shadow: 0 8px 32px rgba(0,0,0,0.32);
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
      transition: opacity .25s, transform .25s;
    }
    #cbt-panel.cbt-visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    /* ============ ダーク ============ */
    html[data-mode="dark"] #cbt-panel,
    html:not([data-mode]) #cbt-panel {
      background: #1e1e1e;
      border: 1px solid #333;
      color: #e0e0e0;
    }
    html[data-mode="dark"] #cbt-header,
    html:not([data-mode]) #cbt-header {
      background: #252525;
      border-bottom: 1px solid #333;
    }
    html[data-mode="dark"] .cbt-number,
    html:not([data-mode]) .cbt-number { color: #81c784; }
    html[data-mode="dark"] .cbt-branch-marker,
    html:not([data-mode]) .cbt-branch-marker { color: #fbbf24; }
    html[data-mode="dark"] .cbt-toggle,
    html:not([data-mode]) .cbt-toggle { color: #888; }
    html[data-mode="dark"] .cbt-toggle-parent:hover,
    html:not([data-mode]) .cbt-toggle-parent:hover { color: #ccc; }
    /* 行ホバー（ダーク） */
    html[data-mode="dark"] .cbt-row:hover,
    html:not([data-mode]) .cbt-row:hover { background: #2a2a2a; }
    html[data-mode="dark"] .cbt-row:hover .cbt-text,
    html:not([data-mode]) .cbt-row:hover .cbt-text { color: #f0f0f0; }
    /* ヘッダーボタン（ダーク） */
    html[data-mode="dark"] #cbt-header button,
    html:not([data-mode]) #cbt-header button { color: #888; }
    html[data-mode="dark"] #cbt-header button:hover,
    html:not([data-mode]) #cbt-header button:hover { color: #ddd; background: #333; }
    /* 編集入力（ダーク） */
    html[data-mode="dark"] .cbt-edit-input,
    html:not([data-mode]) .cbt-edit-input {
      background: #2a2a2a;
      color: #eee;
      border-color: #555;
    }
    /* テキスト色（ダーク）— opacity上書きで #e0e0e0 をそのまま表示 */
    html[data-mode="dark"] .cbt-text,
    html:not([data-mode]) .cbt-text {
      color: #e0e0e0;
      opacity: 1;
    }
    /* アクティブ行（ダーク） */
    html[data-mode="dark"] .cbt-row.cbt-active,
    html:not([data-mode]) .cbt-row.cbt-active {
      background: #28304a;
    }
    html[data-mode="dark"] .cbt-row.cbt-active:hover,
    html:not([data-mode]) .cbt-row.cbt-active:hover {
      background: #313b58;
    }
    html[data-mode="dark"] .cbt-row.cbt-active .cbt-text,
    html:not([data-mode]) .cbt-row.cbt-active .cbt-text {
      color: #f0f0f0;
      opacity: 1;
    }

    /* ============ ライト ============ */
    html[data-mode="light"] #cbt-panel {
      background: #fff;
      border: 1px solid #ddd;
      color: #333;
    }
    html[data-mode="light"] #cbt-header {
      background: #f5f5f5;
      border-bottom: 1px solid #ddd;
    }
    html[data-mode="light"] .cbt-number { color: #15803d; }
    html[data-mode="light"] .cbt-branch-marker { color: #d97706; }
    html[data-mode="light"] .cbt-toggle { color: #999; }
    html[data-mode="light"] .cbt-toggle-parent:hover { color: #333; }
    html[data-mode="light"] .cbt-row:hover { background: #f0f0f0; }
    html[data-mode="light"] #cbt-header button { color: #888; }
    html[data-mode="light"] #cbt-header button:hover { color: #333; background: #e5e5e5; }
    html[data-mode="light"] .cbt-edit-input {
      background: #fff;
      color: #333;
      border-color: #bbb;
    }
    html[data-mode="light"] .cbt-row.cbt-active {
      background: #e8edf8;
    }
    html[data-mode="light"] .cbt-row.cbt-active:hover {
      background: #dce3f4;
    }
    html[data-mode="light"] .cbt-row.cbt-active .cbt-text {
      opacity: 1;
    }

    /* ============ 共通 ============ */
    #cbt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    #cbt-title {
      font-weight: 700;
      font-size: 13px;
    }
    #cbt-header-btns { display: flex; gap: 4px; }
    #cbt-header button {
      background: none;
      border: none;
      font-size: 15px;
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background .15s, color .15s;
    }

    #cbt-body {
      overflow: auto;
      padding: 8px 10px;
      flex: 1;
      min-height: 60px;
    }
    #cbt-body::-webkit-scrollbar { width: 5px; }
    #cbt-body::-webkit-scrollbar-thumb {
      background: rgba(128,128,128,.3);
      border-radius: 3px;
    }
    #cbt-placeholder {
      text-align: center;
      padding: 24px 0;
      opacity: .5;
    }

    /* ---- ノード構造 ---- */
    .cbt-node {}
    .cbt-children {}

    /* ---- 行レイアウト ---- */
    .cbt-row {
      display: flex;
      align-items: flex-start;
      padding: 2px 4px;
      border-radius: 4px;
      transition: background .12s, color .12s;
      cursor: pointer;
      white-space: normal;
    }

    /* ---- トグルアイコン（文字サイズ比で定義 — Notion相当） ---- */
    .cbt-toggle {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      font-size: 0.6em;
      line-height: 1;
      padding-top: 0.22em;
      transition: color .15s;
      user-select: none;
    }
    .cbt-toggle-parent {
      cursor: pointer;
    }
    .cbt-toggle-leaf {
      opacity: 0.35;
      font-size: 0.48em;
    }

    /* ---- 番号 ---- */
    .cbt-number {
      font-weight: 700;
      margin-right: 6px;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* ---- 分岐マーカー ---- */
    .cbt-branch-marker {
      font-size: 11.5px;
      font-weight: 600;
      margin-right: 5px;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* ---- テキスト ---- */
    .cbt-text {
      opacity: .8;
      min-width: 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-all;
      white-space: normal;
      transition: color .12s;
    }

    /* ---- 編集インプット ---- */
    .cbt-edit-input {
      flex: 1;
      min-width: 0;
      border: 1px solid;
      border-radius: 3px;
      padding: 1px 4px;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      outline: none;
    }
    .cbt-edit-input:focus {
      border-color: #5d8aee;
      box-shadow: 0 0 0 2px rgba(93,138,238,0.25);
    }

    /* ---- リサイズハンドル ---- */
    .cbt-resize-handle {
      background: transparent;
    }
  `);
})();
