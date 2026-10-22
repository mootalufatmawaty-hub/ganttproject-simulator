/* ============================================================================
   Sistem Informasi Penjadwalan Proyek — GanttProject Web Simulator
   Berkas : js/pert.js
   Peran  : Mesin visualisasi PERT Chart — node kotak tugas + panah keterkaitan
   ========================================================================== */

var PertEngine = (function () {
  'use strict';

  var NODE_W = 190;
  var NODE_H = 74;
  var COL_W = 232;
  var ROW_PITCH = 104;
  var PAD = 20;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /* WBS numbering penuh (abaikan status collapse) */
  function wbsMap(state) {
    var map = {};
    function walk(list, prefix) {
      list.forEach(function (t, i) {
        var wbs = prefix ? prefix + '.' + (i + 1) : String(i + 1);
        map[t.id] = wbs;
        walk(state.tasks.filter(function (c) { return c.parentId === t.id; }), wbs);
      });
    }
    walk(state.tasks.filter(function (t) { return t.parentId == null; }), '');
    return map;
  }

  /* Urutan topologis gabungan: dependensi eksplisit + pohon induk→anak
     + pengangkatan (anak tugas induk → penerus eksplisit tugas induk) */
  function layoutRanks(state) {
    var ids = state.tasks.map(function (t) { return t.id; });
    var indeg = {};
    var adj = {};
    ids.forEach(function (id) { indeg[id] = 0; adj[id] = []; });

    var edges = []; /* {from, to, kind:'dep'|'tree', task} */

    state.tasks.forEach(function (t) {
      (t.predecessors || []).forEach(function (p) {
        if (!state.tasks.some(function (x) { return x.id === p.taskId; })) return;
        edges.push({ from: p.taskId, to: t.id, kind: 'dep', pred: t.id, link: p });
      });
      if (t.parentId != null && indeg[t.parentId] != null) {
        edges.push({ from: t.parentId, to: t.id, kind: 'tree' });
      }
    });

    /* anak tugas induk -> penerus tugas induk (agar kolom fase mengalir) */
    state.tasks.forEach(function (t) {
      if (t.parentId == null) return;
      state.tasks.forEach(function (s) {
        if (s.parentId != null) return; /* penerus berupa tugas induk/root */
        (s.predecessors || []).forEach(function (p) {
          if (p.taskId === t.parentId) {
            edges.push({ from: t.id, to: s.id, kind: 'lift' });
          }
        });
      });
    });

    edges.forEach(function (e) {
      if (indeg[e.to] == null) return;
      indeg[e.to]++;
      adj[e.from].push(e.to);
    });

    var rank = {};
    ids.forEach(function (id) { rank[id] = 0; });
    var queue = ids.filter(function (id) { return indeg[id] === 0; });
    var done = {};
    var guard = 0;
    var pending = edges.slice();
    while (queue.length && guard++ < 10000) {
      var id = queue.shift();
      if (done[id]) continue;
      done[id] = true;
      pending.forEach(function (e) {
        if (e.from !== id) return;
        if (rank[e.from] != null && rank[e.to] < rank[e.from] + 1) rank[e.to] = rank[e.from] + 1;
      });
      adj[id].forEach(function (nid) {
        indeg[nid]--;
        if (indeg[nid] === 0) queue.push(nid);
      });
    }
    /* fallback bila ada siklus: rapikan berdasarkan pohon */
    ids.forEach(function (id) {
      if (done[id]) return;
      var t = state.tasks.filter(function (x) { return x.id === id; })[0];
      rank[id] = t && t.parentId != null && rank[t.parentId] != null ? rank[t.parentId] + 1 : 0;
    });

    /* rapikan: rank anak minimal induk+1 */
    ids.forEach(function (id) {
      var t = state.tasks.filter(function (x) { return x.id === id; })[0];
      if (t && t.parentId != null && rank[t.parentId] != null && rank[id] <= rank[t.parentId]) {
        rank[id] = rank[t.parentId] + 1;
      }
    });

    return { rank: rank, edges: edges };
  }

  function render(state, container, ctx) {
    if (!container) return;
    if (!state.tasks.length) {
      container.innerHTML =
        '<div class="empty"><b>Belum ada tugas</b>Tambahkan tugas untuk melihat diagram PERT.</div>';
      return;
    }

    var schedule = ctx.schedule;
    var critical = ctx.critical || {};
    var showCritical = !!ctx.showCritical;
    var mode = state.project.dateFormat;
    var wbs = wbsMap(state);
    var lay = layoutRanks(state);

    /* Posisi node */
    var pos = {};
    var colItems = {};
    var maxRank = 0;
    state.tasks.forEach(function (t) {
      var r = lay.rank[t.id] + 1; /* +1 kolom untuk MULAI */
      if (r > maxRank) maxRank = r;
      if (!colItems[r]) colItems[r] = [];
      colItems[r].push(t);
    });
    Object.keys(colItems).forEach(function (r) {
      colItems[r].forEach(function (t, idx) {
        pos[t.id] = {
          col: Number(r),
          x: PAD + Number(r) * COL_W,
          y: PAD + 26 + idx * ROW_PITCH
        };
      });
    });

    var rowsInMax = 1;
    Object.keys(colItems).forEach(function (r) {
      if (colItems[r].length > rowsInMax) rowsInMax = colItems[r].length;
    });

    var startRank = 0;
    var endRank = maxRank + 1;
    var startY = PAD + 26 + Math.floor(Math.max(0, rowsInMax - 1) / 2) * ROW_PITCH;
    var endY = startY;
    var startPos = { x: PAD + startRank * COL_W, y: startY };
    var endPos = { x: PAD + endRank * COL_W, y: endY };

    var svgW = PAD * 2 + (endRank + 1) * COL_W;
    var svgH = Math.max(
      PAD * 2 + 40 + rowsInMax * ROW_PITCH,
      startY + NODE_H + PAD * 2
    );

    /* ---------- NODE ---------- */
    var nodesHtml = '';
    state.tasks.forEach(function (t) {
      var p = pos[t.id];
      if (!p) return;
      var dt = schedule.dates[t.id] || { start: t.start, end: t.start, duration: t.duration };
      var isCrit = showCritical && critical[t.id];
      var kids = state.tasks.filter(function (c) { return c.parentId === t.id; });
      var prog = Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0));
      if (kids.length) {
        var sum = kids.reduce(function (a, c) { return a + (parseInt(c.progress, 10) || 0); }, 0);
        prog = Math.round(sum / kids.length);
      }
      var shortD = function (iso) {
        var f = GanttEngine.fmtDate(iso, mode);
        return mode === 'YYYY-MM-DD' ? f.slice(5) : f.slice(0, 5);
      };
      var dateLabel = `${shortD(dt.start)} – ${shortD(dt.end)}`;
      var fillW = Math.round((NODE_W - 18) * prog / 100);

      nodesHtml += `
<g class="p-node${kids.length ? ' parent' : ''}${isCrit ? ' critical' : ''}" data-action="pnode" data-id="${t.id}" style="cursor:pointer">
  <rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10"></rect>
  <rect class="p-strip" x="${p.x + 8}" y="${p.y + 9}" width="4" height="14" rx="2" fill="${isCrit ? '#ef4444' : (t.color || '#6366f1')}"></rect>
  <text class="p-wbs" x="${p.x + 18}" y="${p.y + 20}">${esc(wbs[t.id] || '')}</text>
  <text class="p-title" x="${p.x + 18}" y="${p.y + 37}">${esc(clip(t.name, 24))}</text>
  <text class="p-meta" x="${p.x + 18}" y="${p.y + 53}">${dt.duration} hari kerja · ${dateLabel}</text>
  <rect class="p-prog-bg" x="${p.x + 9}" y="${p.y + 61}" width="${NODE_W - 18}" height="6" rx="3"></rect>
  <rect class="p-prog-fg" x="${p.x + 9}" y="${p.y + 61}" width="${fillW}" height="6" rx="3"></rect>
</g>`;
    });

    /* node virtual MULAI & SELESAI */
    nodesHtml += `
<g class="p-node terminal" data-action="none">
  <rect x="${startPos.x}" y="${startPos.y}" width="${NODE_W}" height="48" rx="10"></rect>
  <text class="p-title" x="${startPos.x + NODE_W / 2}" y="${startPos.y + 29}" text-anchor="middle">▶ MULAI PROYEK</text>
</g>
<g class="p-node terminal" data-action="none">
  <rect x="${endPos.x}" y="${endPos.y}" width="${NODE_W}" height="48" rx="10"></rect>
  <text class="p-title" x="${endPos.x + NODE_W / 2}" y="${endPos.y + 29}" text-anchor="middle">🏁 SELESAI</text>
</g>`;

    /* ---------- EDGE ---------- */
    function edgePath(a, b) {
      var x1 = a.x + NODE_W;
      var y1 = a.y + NODE_H / 2;
      var x2 = b.x;
      var y2 = b.y + NODE_H / 2;
      var mx = x2 - x1 >= 30 ? x1 + 15 : (x1 + x2) / 2;
      return `M ${x1} ${y1} H ${mx} V ${y2} H ${x2 - 5}`;
    }

    var edgesHtml = '';
    var markerDef = `
<defs>
  <marker id="pertArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0,0 L7,3.5 L0,7 z" fill="#94a3b8"></path>
  </marker>
  <marker id="pertArrowTree" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0,0 L7,3.5 L0,7 z" fill="#cbd5e1"></path>
  </marker>
  <marker id="pertArrowCrit" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0,0 L7,3.5 L0,7 z" fill="#ef4444"></path>
  </marker>
</defs>`;

    /* MULAI -> root tanpa dependensi */
    state.tasks.forEach(function (t) {
      if (t.parentId != null) return;
      var hasPred = (t.predecessors || []).length > 0;
      if (hasPred) return;
      edgesHtml += `<path class="p-edge" d="${edgePath(startPos, pos[t.id])}" marker-end="url(#pertArrow)"></path>`;
    });

    /* root tanpa penerus -> SELESAI */
    state.tasks.forEach(function (t) {
      if (t.parentId != null) return;
      var isSucc = state.tasks.some(function (s) {
        return (s.predecessors || []).some(function (p) { return p.taskId === t.id; });
      });
      if (isSucc) return;
      edgesHtml += `<path class="p-edge" d="${edgePath(pos[t.id], endPos)}" marker-end="url(#pertArrow)"></path>`;
    });

    /* dependensi eksplisit (label FS/SS + lag) */
    state.tasks.forEach(function (t) {
      (t.predecessors || []).forEach(function (p) {
        var a = pos[p.taskId];
        var b = pos[t.id];
        if (!a || !b) return;
        var isCrit = showCritical && critical[t.id] && critical[p.taskId];
        var label = p.type === 'SS'
          ? `SS${p.lag ? ' +' + p.lag : ''}`
          : `FS${p.lag ? ' +' + p.lag : ''}`;
        edgesHtml += `<path class="p-edge${isCrit ? ' crit' : ''}" d="${edgePath(a, b)}" ` +
          `marker-end="url(#${isCrit ? 'pertArrowCrit' : 'pertArrow'})"></path>`;
        edgesHtml += `<text class="p-edge-label${isCrit ? ' crit' : ''}" x="${(a.x + NODE_W + b.x) / 2}" y="${(a.y + b.y) / 2 + NODE_H / 2 - 6}" text-anchor="middle">${label}</text>`;
      });
    });

    /* hubungan pohon (induk → anak) */
    state.tasks.forEach(function (t) {
      if (t.parentId == null) return;
      var a = pos[t.parentId];
      var b = pos[t.id];
      if (!a || !b) return;
      edgesHtml += `<path class="p-edge tree" d="${edgePath(a, b)}" marker-end="url(#pertArrowTree)"></path>`;
    });

    container.innerHTML = `
<div class="pert-wrap">
  <div class="pert-scroll" id="pertScroll">
    <svg class="pert-svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
      ${markerDef}
      <text class="p-col-label" x="${PAD}" y="${PAD + 12}">ALUR LOGIKA: MULAI → PENGERJAAN → SELESAI</text>
      ${edgesHtml}
      ${nodesHtml}
    </svg>
  </div>
  <div class="gantt-legend">
    <span class="lg-item"><span class="lg-swatch parent"></span> Tugas induk</span>
    <span class="lg-item"><span class="lg-swatch" style="background:#6366f1"></span> Node tugas (WBS, durasi, progres)</span>
    <span class="lg-item"><span class="lg-line dash"></span> Hubungan pohon induk → anak</span>
    <span class="lg-item"><span class="lg-line" style="border-color:#94a3b8"></span> Panah dependensi FS / SS</span>
    <span class="lg-item"><span class="lg-line"></span> Jalur kritis (aktifkan Show Critical Path)</span>
    <span class="lg-item">Klik node untuk membuka Task Properties</span>
  </div>
</div>`;

    var scroll = document.getElementById('pertScroll');
    if (scroll) scroll.scrollLeft = 0;
  }

  return { render: render };
})();
