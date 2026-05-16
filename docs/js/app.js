/* DAVI - main application script
 *
 * Architecture: pure vanilla JS, no build step, no framework.
 * Loads six JSONs at startup, builds in-memory indexes, wires the UI.
 *
 * Edge schema reminder (from build_jsons.py):
 *   c     - compound_id
 *   t     - target_id
 *   mode  - Agonist | Antagonist | Binding | Inhibition
 *   mech  - assay__mechanism
 *   dmech - assay__detailed_mechanism (e.g. "Gs") or null
 *   pxc50 - quantified potency
 *   max_act
 *   viab_flag
 *   freq_flag
 *   viab_pxc50 (joined, nullable)
 */

(function () {
  'use strict';

  const DATA_BASE = 'data/';

  // Visual constants
  const NODE_SIZE_FOCAL = 50;
  const NODE_SIZE_OTHER = 28;
  const EDGE_WIDTH_MIN = 1.2;
  const EDGE_WIDTH_MAX = 6.0;
  const COLOR = {
    '7TM': '#4a7ba6',
    'NR': '#b89c4a',
    'Kinase': '#8a4a7a',
    'compound': '#5a5a55',
  };

  // In-memory data store, populated on load
  const STATE = {
    build: null,
    targets: null,
    compounds: null,
    edges: null,
    weakHits: null,
    targetTarget: null,
    compoundCompound: null,
    searchIndex: null,
    searchDocs: null,

    targetById: new Map(),
    compoundById: new Map(),
    edgesByCompound: new Map(),
    edgesByTarget: new Map(),
    weakByCompound: new Map(),
    weakByTarget: new Map(),

    currentFocus: null,
    pxc50Cutoff: 6.0,
    topN: 0,  // 0 = no cap
    layoutMode: 'concentric',  // 'spring' | 'circular' | 'concentric'
    cy: null,
    coLayoutHandle: null,
  };

  // ====================================================================
  // Boot
  // ====================================================================
  async function boot() {
    try {
      setStatus('Loading data...');
      await loadAllData();
      buildIndexes();
      buildSearchIndex();
      populateBuildMeta();
      initCytoscape();
      wireSearch();
      wireChips();
      wireSidePanel();
      wireSlider();
      wireHelpModal();
      wireZoomControls();
      clearStatus();
      focusCompound('EB001170');
    } catch (err) {
      console.error('Boot failed:', err);
      setStatus('Failed to load data. See console.', 'warn');
    }
  }

  // ====================================================================
  // Data loading
  // ====================================================================
  async function loadAllData() {
    const files = [
      ['build', 'build_info.json'],
      ['targets', 'targets.json'],
      ['compounds', 'compounds.json'],
      ['edges', 'edges.json'],
      ['weakHits', 'weak_hits.json'],
      ['targetTarget', 'target_target.json'],
      ['compoundCompound', 'compound_compound.json'],
    ];
    const results = await Promise.all(
      files.map(([_, fname]) => fetchJSON(DATA_BASE + fname))
    );
    files.forEach(([key], i) => {
      STATE[key] = results[i];
    });
    STATE.searchDocs = await fetchJSON(DATA_BASE + 'search_index.json');
    console.log('[DAVI] loaded:', {
      targets: STATE.targets.length,
      compounds: STATE.compounds.length,
      edges: STATE.edges.length,
      weakHits: STATE.weakHits.length,
      tt: STATE.targetTarget.length,
      cc: STATE.compoundCompound.length,
      search: STATE.searchDocs.length,
    });
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
  }

  // ====================================================================
  // Indexes
  // ====================================================================
  function buildIndexes() {
    for (const t of STATE.targets) STATE.targetById.set(t.id, t);
    for (const c of STATE.compounds) STATE.compoundById.set(c.id, c);
    for (const e of STATE.edges) {
      pushTo(STATE.edgesByCompound, e.c, e);
      pushTo(STATE.edgesByTarget, e.t, e);
    }
    for (const w of STATE.weakHits) {
      pushTo(STATE.weakByCompound, w.c, w);
      pushTo(STATE.weakByTarget, w.t, w);
    }
  }

  function pushTo(map, key, value) {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(value);
  }

  function buildSearchIndex() {
    STATE.searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['label', 'name', 'uniprot', 'drugbank', 'cas', 'class'],
      storeFields: ['id', 'type', 'label', 'name', 'class',
                    'n_compounds', 'n_targets', 'uniprot', 'drugbank'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.15,
        boost: { label: 2 },
      },
    });
    STATE.searchIndex.addAll(STATE.searchDocs);
  }

  // ====================================================================
  // Top bar metadata
  // ====================================================================
  function populateBuildMeta() {
    const meta = document.getElementById('build-meta');
    const footerBuild = document.getElementById('footer-build');
    const b = STATE.build;
    meta.innerHTML = `EvE release ${b.latest_release} - ${b.stats.n_compounds} compounds, ${b.stats.n_targets} targets, ${b.stats.n_edges_quantified.toLocaleString()} edges - built ${b.build_date}`;
    footerBuild.textContent = `built ${b.build_date}`;
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('status-banner');
    el.textContent = msg;
    el.className = 'status-banner' + (kind === 'warn' ? ' warn' : '');
    el.hidden = false;
  }

  function clearStatus() {
    document.getElementById('status-banner').hidden = true;
  }

  // ====================================================================
  // Cytoscape init
  // ====================================================================
  function initCytoscape() {
    const container = document.getElementById('cy');
    container.innerHTML = '';
    STATE.cy = cytoscape({
      container,
      minZoom: 0.2,
      maxZoom: 3.0,
      // Touch-friendly: enable pinch-zoom and pan on mobile
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      autoungrabify: false,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'label': 'data(label)',
            'color': '#1a1a1a',
            'font-size': '11px',
            'font-family': '-apple-system, system-ui, sans-serif',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 4,
            'text-background-color': '#fafaf9',
            'text-background-opacity': 0.85,
            'text-background-padding': 2,
            'text-background-shape': 'roundrectangle',
            'width': 'data(size)',
            'height': 'data(size)',
            'border-width': 1.5,
            'border-color': '#ffffff',
          },
        },
        {
          selector: 'node[shape = "rect"]',
          style: { 'shape': 'round-rectangle' },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#2a5d8a',
          },
        },
        {
          selector: 'node.focal',
          style: {
            'border-width': 3,
            'border-color': '#1a1a1a',
            'font-size': '13px',
            'font-weight': 'bold',
          },
        },
        {
          selector: 'edge',
          style: {
            'width': 'data(width)',
            'line-color': '#7a7a75',
            'opacity': 0.65,
            'curve-style': 'straight',
          },
        },
        {
          selector: 'edge.viab',
          style: {
            'line-style': 'dashed',
            'line-dash-pattern': [4, 3],
            'line-color': '#b65c2f',
          },
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#2a5d8a',
            'opacity': 1,
          },
        },
      ],
    });

    STATE.cy.on('tap', 'node', (e) => {
      const data = e.target.data();
      if (data.kind === 'compound') focusCompound(data.eveId);
      else if (data.kind === 'target') focusTarget(data.eveId);
    });

    // Live drag-spring propagation: when a node is dragged, manually nudge
    // its neighbors toward the new position. This is the d3-force "tick"
    // mechanism, simplified - works reliably across cytoscape layouts.
    // Spring strength decreases with hop distance (1-hop only here, since
    // ego networks are mostly 1-hop from focal).
    let dragNode = null;
    let dragStartPos = null;
    STATE.cy.on('grab', 'node', (e) => {
      dragNode = e.target;
      dragStartPos = { x: dragNode.position('x'), y: dragNode.position('y') };
    });

    STATE.cy.on('drag', 'node', (e) => {
      if (!dragNode || dragNode.id() !== e.target.id()) return;
      const pos = dragNode.position();
      // Drag delta since last frame propagates softly to neighbors
      const dx = (pos.x - dragStartPos.x);
      const dy = (pos.y - dragStartPos.y);
      const SPRING = 0.15;  // 0 = no propagation, 1 = neighbors move identically
      dragNode.neighborhood('node').forEach(n => {
        if (n.id() === dragNode.id()) return;
        n.position({
          x: n.position('x') + dx * SPRING,
          y: n.position('y') + dy * SPRING,
        });
      });
      // Update reference so propagation is per-frame, not absolute
      dragStartPos = { x: pos.x, y: pos.y };
    });

    STATE.cy.on('free', 'node', () => {
      dragNode = null;
      dragStartPos = null;
      // After release: in non-spring layouts, run a brief relax pass to
      // settle nodes back via constraints. In spring layout, the live cola
      // is still running and will continue to balance.
      if (STATE.layoutMode === 'concentric' || STATE.layoutMode === 'circular') return;
      const edgeCount = STATE.cy.edges().length;
      if (edgeCount < 7) return;
      STATE.cy.layout({
        name: 'cola',
        animate: true,
        refresh: 1,
        maxSimulationTime: 600,
        ungrabifyWhileSimulating: false,
        fit: false,
        randomize: false,
        avoidOverlap: true,
        nodeSpacing: () => 14,
        edgeLength: 100,
        unconstrIter: 8,
        userConstIter: 0,
        allConstIter: 12,
        infinite: false,
      }).run();
    });
  }

  // ====================================================================
  // Edge collapsing: many rows per (compound, target) become one edge
  // ====================================================================
  function collapseEdges(edges) {
    const grouped = new Map();
    for (const e of edges) {
      const key = `${e.c}::${e.t}`;
      let g = grouped.get(key);
      if (!g) {
        g = {
          c: e.c,
          t: e.t,
          best_pxc50: e.pxc50,
          viab_flag: e.viab_flag,
          freq_flag: e.freq_flag,
          rows: [],
        };
        grouped.set(key, g);
      } else {
        if (e.pxc50 > g.best_pxc50) g.best_pxc50 = e.pxc50;
        if (e.viab_flag) g.viab_flag = true;
        if (e.freq_flag) g.freq_flag = true;
      }
      g.rows.push(e);
    }
    return Array.from(grouped.values());
  }

  function pxc50ToWidth(p) {
    const clamped = Math.max(5, Math.min(11, p));
    const t = (clamped - 5) / 6;
    return EDGE_WIDTH_MIN + t * (EDGE_WIDTH_MAX - EDGE_WIDTH_MIN);
  }

  // ====================================================================
  // Render: compound ego network
  // ====================================================================
  function renderCompoundEgo(compoundId) {
    const c = STATE.compoundById.get(compoundId);
    const rawEdges = (STATE.edgesByCompound.get(compoundId) || [])
      .filter(e => e.pxc50 >= STATE.pxc50Cutoff);
    let collapsed = collapseEdges(rawEdges);
    const totalCount = collapsed.length;

    // Sort by best pXC50 descending so Top-N keeps the most potent
    collapsed.sort((a, b) => b.best_pxc50 - a.best_pxc50);
    if (STATE.topN > 0 && collapsed.length > STATE.topN) {
      collapsed = collapsed.slice(0, STATE.topN);
    }

    if (!STATE.cy) return;
    STATE.cy.elements().remove();

    const nodes = [];
    const edges = [];

    nodes.push({
      data: {
        id: 'c:' + compoundId,
        eveId: compoundId,
        kind: 'compound',
        label: c ? (c.name || compoundId) : compoundId,
        color: COLOR.compound,
        size: NODE_SIZE_FOCAL,
        shape: 'rect',
      },
      classes: 'focal',
    });

    for (const ce of collapsed) {
      const t = STATE.targetById.get(ce.t);
      const klass = t ? t.class : 'Kinase';
      nodes.push({
        data: {
          id: 't:' + ce.t,
          eveId: ce.t,
          kind: 'target',
          label: t ? (t.gene || ce.t) : ce.t,
          color: COLOR[klass] || COLOR.compound,
          size: NODE_SIZE_OTHER,
        },
      });
      edges.push({
        data: {
          id: 'e:' + ce.c + '-' + ce.t,
          source: 'c:' + ce.c,
          target: 't:' + ce.t,
          width: pxc50ToWidth(ce.best_pxc50),
          pxc50: ce.best_pxc50,
        },
        classes: ce.viab_flag ? 'viab' : '',
      });
    }

    STATE.cy.add({ nodes, edges });
    runLayout(collapsed.length);
    updateGraphNotice(collapsed.length, totalCount);
    updateNetStats();
  }

  // ====================================================================
  // Render: target ego network
  // ====================================================================
  function renderTargetEgo(targetId) {
    const t = STATE.targetById.get(targetId);
    const rawEdges = (STATE.edgesByTarget.get(targetId) || [])
      .filter(e => e.pxc50 >= STATE.pxc50Cutoff);
    let collapsed = collapseEdges(rawEdges);
    const totalCount = collapsed.length;

    collapsed.sort((a, b) => b.best_pxc50 - a.best_pxc50);
    if (STATE.topN > 0 && collapsed.length > STATE.topN) {
      collapsed = collapsed.slice(0, STATE.topN);
    }

    if (!STATE.cy) return;
    STATE.cy.elements().remove();

    const nodes = [];
    const edges = [];

    nodes.push({
      data: {
        id: 't:' + targetId,
        eveId: targetId,
        kind: 'target',
        label: t ? (t.gene || targetId) : targetId,
        color: COLOR[t ? t.class : 'Kinase'] || COLOR.compound,
        size: NODE_SIZE_FOCAL,
      },
      classes: 'focal',
    });

    for (const ce of collapsed) {
      const c = STATE.compoundById.get(ce.c);
      nodes.push({
        data: {
          id: 'c:' + ce.c,
          eveId: ce.c,
          kind: 'compound',
          label: c ? (c.name || ce.c) : ce.c,
          color: COLOR.compound,
          size: NODE_SIZE_OTHER,
          shape: 'rect',
        },
      });
      edges.push({
        data: {
          id: 'e:' + ce.c + '-' + ce.t,
          source: 'c:' + ce.c,
          target: 't:' + ce.t,
          width: pxc50ToWidth(ce.best_pxc50),
          pxc50: ce.best_pxc50,
        },
        classes: ce.viab_flag ? 'viab' : '',
      });
    }

    STATE.cy.add({ nodes, edges });
    runLayout(collapsed.length);
    updateGraphNotice(collapsed.length, totalCount);
    updateNetStats();
  }

  function runLayout(edgeCount) {
    // Stop any previous infinite simulation cleanly before starting a new one
    if (STATE.coLayoutHandle) {
      try { STATE.coLayoutHandle.stop(); } catch (_) { /* ignore */ }
      STATE.coLayoutHandle = null;
    }

    let layout;
    if (edgeCount === 0) {
      STATE.cy.layout({ name: 'preset' }).run();
      return;
    }

    if (STATE.layoutMode === 'circular') {
      layout = makeCircularLayout(edgeCount);
    } else if (STATE.layoutMode === 'concentric') {
      layout = makeConcentricByPotency(edgeCount);
    } else {
      layout = makeSpringLayout(edgeCount);
    }

    const handle = STATE.cy.layout(layout);
    handle.run();
    // Track the cola handle for stopping later (only infinite-mode cola needs this)
    if (STATE.layoutMode === 'spring') {
      STATE.coLayoutHandle = handle;
    }
  }

  function makeSpringLayout(edgeCount) {
    // cola: spring embedder. Runs for ~4s then settles.
    // Live drag propagation is handled manually in the cy.on('drag') handler,
    // which works more reliably than cola's infinite mode in this adapter.
    const dense = edgeCount > 80;
    const veryDense = edgeCount > 150;
    return {
      name: 'cola',
      animate: true,
      refresh: 1,
      maxSimulationTime: 4000,
      ungrabifyWhileSimulating: false,
      fit: true,
      padding: 40,
      randomize: true,
      avoidOverlap: true,
      handleDisconnected: true,
      nodeSpacing: () => 16,
      edgeLength: veryDense ? 180 : (dense ? 130 : 95),
      unconstrIter: 20,
      userConstIter: 0,
      allConstIter: 30,
      infinite: false,
    };
  }

  function makeCircularLayout(edgeCount) {
    // Circle layout: focal anchored at center, peripherals on a ring.
    // We use cytoscape's built-in 'circle' but boost focal node weight
    // so it stays centered. Cytoscape's circle layout actually puts ALL
    // nodes on the ring; to anchor focal in the middle we use 'concentric'
    // with focal at level 1 and all others at level 0.
    return {
      name: 'concentric',
      concentric: (node) => node.hasClass('focal') ? 10 : 1,
      levelWidth: () => 1,
      minNodeSpacing: edgeCount > 100 ? 14 : (edgeCount > 50 ? 20 : 35),
      spacingFactor: 1.0,
      animate: true,
      animationDuration: 500,
      fit: true,
      padding: 40,
    };
  }

  function makeConcentricByPotency(edgeCount) {
    // Concentric: focal innermost, then peripherals organized by potency
    // into 3 rings: high (pxc50 >= 8), medium (6-8), low (<6).
    // Higher potency = closer to focal node.
    return {
      name: 'concentric',
      concentric: (node) => {
        if (node.hasClass('focal')) return 100;
        // Find the strongest edge touching this node
        let bestPxc50 = 5;
        node.connectedEdges().forEach(e => {
          const p = e.data('pxc50') || 5;
          if (p > bestPxc50) bestPxc50 = p;
        });
        // Map pxc50 to ring level (higher pxc50 = higher level = inner ring)
        return Math.round(bestPxc50);
      },
      levelWidth: () => 1,
      minNodeSpacing: edgeCount > 100 ? 12 : 22,
      spacingFactor: 1.1,
      animate: true,
      animationDuration: 500,
      fit: true,
      padding: 40,
    };
  }

  // ====================================================================
  // Search
  // ====================================================================
  function wireSearch() {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');
    let focusIdx = -1;

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 1) {
        results.hidden = true;
        results.innerHTML = '';
        return;
      }
      const hits = STATE.searchIndex.search(q, { combineWith: 'AND' }).slice(0, 20);
      renderSearchResults(hits, results);
      focusIdx = -1;
    });

    input.addEventListener('keydown', (e) => {
      const items = results.querySelectorAll('.search-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusIdx = Math.min(focusIdx + 1, items.length - 1);
        updateFocus(items, focusIdx);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx = Math.max(focusIdx - 1, 0);
        updateFocus(items, focusIdx);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[focusIdx] || items[0];
        if (item) item.click();
      } else if (e.key === 'Escape') {
        results.hidden = true;
        input.blur();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) {
        results.hidden = true;
      }
    });
  }

  function updateFocus(items, idx) {
    items.forEach((el, i) => el.classList.toggle('focused', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  function renderSearchResults(hits, container) {
    if (hits.length === 0) {
      container.innerHTML = '<div class="search-result"><span class="detail">No matches.</span></div>';
      container.hidden = false;
      return;
    }
    container.innerHTML = hits.map(h => {
      const typeBadge = `<span class="type-badge ${h.type}">${h.type}</span>`;
      const detail = h.type === 'compound'
        ? `${h.n_targets} target${h.n_targets === 1 ? '' : 's'}`
        : `${h.class} - ${h.n_compounds} compound${h.n_compounds === 1 ? '' : 's'}`;
      return `<div class="search-result" data-type="${h.type}" data-id="${h.id}">
        ${typeBadge}
        <span class="label">${escapeHTML(h.label)}</span>
        <span class="detail">${detail}</span>
      </div>`;
    }).join('');
    container.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const type = el.dataset.type;
        const id = el.dataset.id;
        if (type === 'compound') focusCompound(id);
        else focusTarget(id);
        container.hidden = true;
        document.getElementById('search-input').value = '';
      });
    });
    container.hidden = false;
  }

  // ====================================================================
  // Chips
  // ====================================================================
  function wireChips() {
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const pick = chip.dataset.pick;
        if (pick.startsWith('compound:')) {
          focusCompound(pick.slice('compound:'.length));
        } else if (pick.startsWith('target:gene:')) {
          const gene = pick.slice('target:gene:'.length);
          const t = STATE.targets.find(x => x.gene === gene);
          if (t) focusTarget(t.id);
        }
      });
    });
  }

  // ====================================================================
  // Side panel
  // ====================================================================
  function wireSidePanel() {
    // Docked panel - no close button. This function kept for future hooks.
  }

  function openSidePanel(type, id) {
    const panel = document.getElementById('side-panel');
    const content = document.getElementById('side-content');
    if (type === 'compound') content.innerHTML = renderCompoundPanel(id);
    else content.innerHTML = renderTargetPanel(id);
    panel.classList.remove('empty');
    content.querySelectorAll('[data-jump-target]').forEach(el => {
      el.addEventListener('click', () => focusTarget(el.dataset.jumpTarget));
    });
    content.querySelectorAll('[data-jump-compound]').forEach(el => {
      el.addEventListener('click', () => focusCompound(el.dataset.jumpCompound));
    });
  }

  function renderCompoundPanel(id) {
    const c = STATE.compoundById.get(id);
    if (!c) return `<p>Compound ${id} not found.</p>`;
    const edges = (STATE.edgesByCompound.get(id) || []).slice().sort((a, b) => b.pxc50 - a.pxc50);
    const weak = STATE.weakByCompound.get(id) || [];

    const idBlock = `
      <div class="id-block">
        <div class="id-row"><span class="label">EvE ID</span><span class="value">${c.id}</span></div>
        ${c.drugbank ? `<div class="id-row"><span class="label">DrugBank</span><span class="value"><a href="https://go.drugbank.com/drugs/${c.drugbank}" target="_blank" rel="noopener">${c.drugbank}</a></span></div>` : ''}
        ${c.cas ? `<div class="id-row"><span class="label">CAS</span><span class="value">${c.cas}</span></div>` : ''}
        ${c.unii ? `<div class="id-row"><span class="label">UNII</span><span class="value"><a href="https://precision.fda.gov/uniisearch/srs/unii/${c.unii}" target="_blank" rel="noopener">${c.unii}</a></span></div>` : ''}
        ${c.inchikey ? `<div class="id-row"><span class="label">InChIKey</span><span class="value"><a href="https://pubchem.ncbi.nlm.nih.gov/#query=${c.inchikey}" target="_blank" rel="noopener">PubChem</a></span></div>` : ''}
      </div>
    `;

    const hitList = edges.map(e => {
      const tgt = STATE.targetById.get(e.t);
      const flags = (e.viab_flag ? '<span class="flag-pill flag-viab">viab</span>' : '')
                  + (e.freq_flag ? '<span class="flag-pill flag-freq">freq</span>' : '');
      return `<li data-jump-target="${e.t}">
        <span class="hit-label">${escapeHTML(tgt ? tgt.gene : e.t)}${flags}</span>
        <span class="hit-meta">pXC50 ${e.pxc50.toFixed(1)} ${e.mode}</span>
      </li>`;
    }).join('');

    return `
      <h2>${escapeHTML(c.name || c.id)}</h2>
      <div class="subtitle">Compound - ${edges.length} active target${edges.length === 1 ? '' : 's'} (quantified), ${weak.length} weak hit${weak.length === 1 ? '' : 's'}</div>
      ${idBlock}
      <div class="side-section-title">Active targets (by potency)</div>
      <ul class="hit-list">${hitList || '<li><span class="hit-meta">No quantified actives</span></li>'}</ul>
    `;
  }

  function renderTargetPanel(id) {
    const t = STATE.targetById.get(id);
    if (!t) return `<p>Target ${id} not found.</p>`;
    const edges = (STATE.edgesByTarget.get(id) || []).slice().sort((a, b) => b.pxc50 - a.pxc50);
    const weak = STATE.weakByTarget.get(id) || [];

    const idBlock = `
      <div class="id-block">
        <div class="id-row"><span class="label">EvE ID</span><span class="value">${t.id}</span></div>
        <div class="id-row"><span class="label">Gene</span><span class="value">${t.gene || '-'}</span></div>
        ${t.uniprot ? `<div class="id-row"><span class="label">UniProt</span><span class="value"><a href="https://www.uniprot.org/uniprotkb/${t.uniprot}" target="_blank" rel="noopener">${t.uniprot}</a></span></div>` : ''}
        ${t.uniprot ? `<div class="id-row"><span class="label">AlphaFold</span><span class="value"><a href="https://alphafold.ebi.ac.uk/entry/${t.uniprot}" target="_blank" rel="noopener">structure</a></span></div>` : ''}
        <div class="id-row"><span class="label">Class</span><span class="value">${t.class}</span></div>
        ${t.is_mutant ? `<div class="id-row"><span class="label">Mutant of</span><span class="value" data-jump-target="${t.wildtype_id}"><a href="#">${t.wildtype_id}</a></span></div>` : ''}
      </div>
    `;

    const hitList = edges.map(e => {
      const c = STATE.compoundById.get(e.c);
      const flags = (e.viab_flag ? '<span class="flag-pill flag-viab">viab</span>' : '')
                  + (e.freq_flag ? '<span class="flag-pill flag-freq">freq</span>' : '');
      return `<li data-jump-compound="${e.c}">
        <span class="hit-label">${escapeHTML(c ? (c.name || c.id) : e.c)}${flags}</span>
        <span class="hit-meta">pXC50 ${e.pxc50.toFixed(1)} ${e.mode}</span>
      </li>`;
    }).join('');

    return `
      <h2>${escapeHTML(t.gene || t.id)}</h2>
      <div class="subtitle">${escapeHTML(t.name || '')}</div>
      ${idBlock}
      <div class="side-section-title">Active compounds (by potency)</div>
      <ul class="hit-list">${hitList || '<li><span class="hit-meta">No quantified actives</span></li>'}</ul>
    `;
  }

  // ====================================================================
  // Slider (debounced)
  // ====================================================================
  function wireSlider() {
    const slider = document.getElementById('pxc50-slider');
    const value = document.getElementById('pxc50-value');
    slider.value = STATE.pxc50Cutoff;
    value.textContent = STATE.pxc50Cutoff.toFixed(1);
    let lastValue = parseFloat(slider.value);
    let timer = null;

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      value.textContent = v.toFixed(1);
      if (v === lastValue) return;
      lastValue = v;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        STATE.pxc50Cutoff = v;
        rerenderCurrent();
      }, 150);
    });

    // Top-N control
    const topN = document.getElementById('topn-select');
    if (topN) {
      topN.addEventListener('change', () => {
        STATE.topN = parseInt(topN.value, 10);
        rerenderCurrent();
      });
    }

    // Layout selector
    const layoutSel = document.getElementById('layout-select');
    if (layoutSel) {
      layoutSel.addEventListener('change', () => {
        STATE.layoutMode = layoutSel.value;
        rerenderCurrent();
      });
    }
  }

  function rerenderCurrent() {
    if (!STATE.currentFocus) return;
    if (STATE.currentFocus.type === 'compound') focusCompound(STATE.currentFocus.id);
    else focusTarget(STATE.currentFocus.id);
  }

  // ====================================================================
  // Zoom / fit controls
  // ====================================================================
  function wireZoomControls() {
    const zin = document.getElementById('zoom-in');
    const zout = document.getElementById('zoom-out');
    const fit = document.getElementById('zoom-fit');
    if (zin) zin.addEventListener('click', () => {
      if (!STATE.cy) return;
      STATE.cy.zoom({
        level: STATE.cy.zoom() * 1.25,
        renderedPosition: { x: STATE.cy.width() / 2, y: STATE.cy.height() / 2 },
      });
    });
    if (zout) zout.addEventListener('click', () => {
      if (!STATE.cy) return;
      STATE.cy.zoom({
        level: STATE.cy.zoom() / 1.25,
        renderedPosition: { x: STATE.cy.width() / 2, y: STATE.cy.height() / 2 },
      });
    });
    if (fit) fit.addEventListener('click', () => {
      if (!STATE.cy) return;
      STATE.cy.fit(undefined, 40);
      STATE.cy.center();
    });
  }

  // ====================================================================
  // Network stats (current view)
  // ====================================================================
  function updateNetStats() {
    const el = document.getElementById('net-stats');
    if (!el || !STATE.cy) return;
    const nodes = STATE.cy.nodes().length;
    const edges = STATE.cy.edges().length;
    if (nodes === 0) {
      el.hidden = true;
      return;
    }
    el.textContent = `${nodes} nodes, ${edges} edges`;
    el.hidden = false;
  }

  // ====================================================================
  // Help modal
  // ====================================================================
  function wireHelpModal() {
    const modal = document.getElementById('help-modal');
    const helpLink = document.getElementById('help-link');
    if (!modal || !helpLink) return;

    const open = (e) => {
      if (e) e.preventDefault();
      modal.hidden = false;
    };
    const close = () => {
      modal.hidden = true;
    };

    helpLink.addEventListener('click', open);
    modal.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  function updateGraphNotice(shown, total) {
    const el = document.getElementById('graph-notice');
    if (!el) return;
    if (total === 0) {
      el.textContent = 'No targets at this pXC50 cutoff.';
      el.hidden = false;
      return;
    }
    if (shown < total) {
      el.textContent = `Showing top ${shown} of ${total} by potency.`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // ====================================================================
  // Focus handlers
  // ====================================================================
  function focusCompound(id) {
    STATE.currentFocus = { type: 'compound', id };
    const c = STATE.compoundById.get(id);
    const edges = (STATE.edgesByCompound.get(id) || []).filter(e => e.pxc50 >= STATE.pxc50Cutoff);
    console.log(`[DAVI] focus compound ${id} (${c ? c.name : '?'}): ${edges.length} edges at pXC50 >= ${STATE.pxc50Cutoff}`);
    renderCompoundEgo(id);
    openSidePanel('compound', id);
    document.getElementById('legend').hidden = false;
  }

  function focusTarget(id) {
    STATE.currentFocus = { type: 'target', id };
    const t = STATE.targetById.get(id);
    const edges = (STATE.edgesByTarget.get(id) || []).filter(e => e.pxc50 >= STATE.pxc50Cutoff);
    console.log(`[DAVI] focus target ${id} (${t ? t.gene : '?'}): ${edges.length} edges at pXC50 >= ${STATE.pxc50Cutoff}`);
    renderTargetEgo(id);
    openSidePanel('target', id);
    document.getElementById('legend').hidden = false;
  }

  // ====================================================================
  // Utilities
  // ====================================================================
  function escapeHTML(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ====================================================================
  // Start
  // ====================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
