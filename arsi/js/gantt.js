/* ============================================================================
   Sistem Informasi Penjadwalan Proyek — GanttProject Web Simulator
   Berkas : js/gantt.js
   Peran  : Mesin kalender/hari kerja, kalkulasi jadwal, render Gantt Chart (DOM)
   ========================================================================== */

var GanttEngine = (function () {
  'use strict';

  var ROW_H = 34;
  var EPOCH = '2000-01-01';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var MONTHS_FULL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var WD_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  /* ------------------------------ UTILITAS TANGGAL ------------------------------ */

  function parse(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return new Date(NaN);
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function toISO(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addDays(iso, n) {
    var d = parse(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function calDiff(aIso, bIso) { /* jumlah hari kalender a->b (b-a) */
    return Math.round((parse(bIso) - parse(aIso)) / 86400000);
  }

  function weekday(iso) { return parse(iso).getDay(); }

  function fmtDate(iso, mode) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    if (mode === 'MM/DD/YYYY') return p[2] + '/' + p[1] + '/' + p[0];
    if (mode === 'YYYY-MM-DD') return iso;
    return p[2] + '/' + p[1] + '/' + p[0]; /* DD/MM/YYYY (default) */
  }

  /* ------------------------------ KALENDER KERJA ------------------------------ */

  function isWeekendDay(state, iso) {
    var wd = weekday(iso);
    var w = state.project.weekend || {};
    if (wd === 6 && w.sat) return true;
    if (wd === 0 && w.sun) return true;
    return false;
  }

  function holidayOn(state, iso) {
    var mmdd = String(iso).slice(5);
    var list = state.holidays || [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (h.recurring) {
        if (String(h.date).slice(5) === mmdd) return h;
      } else if (h.date === iso) {
        return h;
      }
    }
    return null;
  }

  function isWorkingDay(state, iso) {
    if (isWeekendDay(state, iso)) return false;
    if (holidayOn(state, iso)) return false;
    return true;
  }

  function snapForward(state, iso) {
    var cur = iso;
    var guard = 0;
    while (!isWorkingDay(state, cur) && guard++ < 2000) cur = addDays(cur, 1);
    return cur;
  }

  function addWorkingDays(state, iso, n) {
    var cur = iso;
    var step = n >= 0 ? 1 : -1;
    var left = Math.abs(Math.round(n));
    var guard = 0;
    while (left > 0 && guard++ < 400000) {
      cur = addDays(cur, step);
      if (isWorkingDay(state, cur)) left--;
    }
    return cur;
  }

  function countWeekendDays(state, aIso, bIso) { /* inclusive, a<=b */
    var w = state.project.weekend || {};
    var sat = !!w.sat, sun = !!w.sun;
    if (!sat && !sun) return 0;
    var a = parse(aIso);
    var days = calDiff(aIso, bIso) + 1;
    if (days <= 0) return 0;
    var startWd = a.getDay();
    var perWeek = (sat ? 1 : 0) + (sun ? 1 : 0);
    var full = Math.floor(days / 7);
    var count = full * perWeek;
    var rest = days - full * 7;
    for (var i = 0; i < rest; i++) {
      var wd = (startWd + i) % 7;
      if (sun && wd === 0) count++;
      if (sat && wd === 6) count++;
    }
    return count;
  }

  function countHolidayWorkdays(state, aIso, bIso) { /* libur jatuh di hari kerja non-weekend */
    var list = state.holidays || [];
    var yearA = Number(aIso.slice(0, 4));
    var yearB = Number(bIso.slice(0, 4));
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (h.recurring) {
        var mmdd = String(h.date).slice(5);
        for (var y = yearA; y <= yearB; y++) {
          var iso = y + '-' + mmdd;
          if (iso >= aIso && iso <= bIso && !isWeekendDay(state, iso)) count++;
        }
      } else if (h.date >= aIso && h.date <= bIso && !isWeekendDay(state, h.date)) {
        count++;
      }
    }
    return count;
  }

  function workingDaysBetween(state, aIso, bIso) { /* inclusive; negatif bila terbalik */
    if (!aIso || !bIso) return 0;
    if (aIso > bIso) return -workingDaysBetween(state, bIso, aIso);
    var total = calDiff(aIso, bIso) + 1;
    return total - countWeekendDays(state, aIso, bIso) - countHolidayWorkdays(state, aIso, bIso);
  }

  function wdIndex(state, iso) { /* indeks hari kerja sejak EPOCH (inklusif) */
    return workingDaysBetween(state, EPOCH, iso);
  }

  function durationEnd(state, startIso, dur) {
    if (!dur || dur <= 0) return startIso;
    return addWorkingDays(state, startIso, dur - 1);
  }

  /* --------------------------- STRUKTUR TUGAS (WBS) --------------------------- */

  function childrenOf(state, task) {
    var out = [];
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].parentId === task.id) out.push(state.tasks[i]);
    }
    return out;
  }

  function taskById(state, id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  /* Susun urutan DFS-pre-order (parent sebelum anak) — aman meski impor JSON tidak berurutan */
  function dfsOrder(state) {
    var roots = state.tasks.filter(function (t) { return t.parentId == null; });
    var placed = {};
    var out = [];
    function walk(list) {
      list.forEach(function (t) {
        if (placed[t.id]) return;
        placed[t.id] = true;
        out.push(t);
        var kids = state.tasks.filter(function (c) { return c.parentId === t.id; });
        walk(kids);
      });
    }
    walk(roots);
    /* task yatim (parentId menunjuk id tak ada) -> jadikan root */
    state.tasks.forEach(function (t) {
      if (!placed[t.id]) { placed[t.id] = true; out.push(t); }
    });
    return out;
  }

  function buildTreeIndex(state) {
    var children = {};
    var parent = {};
    state.tasks.forEach(function (t) { children[t.id] = []; });
    state.tasks.forEach(function (t) {
      if (t.parentId != null && children[t.parentId]) {
        children[t.parentId].push(t);
        parent[t.id] = t.parentId;
      } else {
        t.parentId = null;
      }
    });
    return { children: children, parent: parent };
  }

  /* Urutan topologis atas dependensi eksplisit; jika ada siklus, edge siklus diabaikan */
  function topoInfo(state) {
    var indeg = {};
    var succ = {};
    state.tasks.forEach(function (t) {
      indeg[t.id] = 0;
      succ[t.id] = [];
    });
    var validPreds = {};
    state.tasks.forEach(function (t) {
      validPreds[t.id] = [];
      (t.predecessors || []).forEach(function (p) {
        if (!taskById(state, p.taskId)) return; /* target tak ada */
        if (p.taskId === t.id) return; /* diri sendiri */
        indeg[t.id]++;
        succ[p.taskId].push(t.id);
        validPreds[t.id].push(p);
      });
    });
    var order = [];
    var queue = [];
    state.tasks.forEach(function (t) { if (indeg[t.id] === 0) queue.push(t.id); });
    var seen = {};
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true;
      order.push(id);
      succ[id].forEach(function (sid) {
        indeg[sid]--;
        if (indeg[sid] === 0) queue.push(sid);
      });
    }
    var hasCycle = order.length < state.tasks.length;
    if (hasCycle) {
      /* sisanya tetap ditambahkan di akhir agar tetap dirender (tanpa push dependensi) */
      state.tasks.forEach(function (t) { if (!seen[t.id]) { order.push(t.id); seen[t.id] = true; } });
    }
    return { order: order, hasCycle: hasCycle, validPreds: validPreds };
  }

  /* ------------------------------ KALKULASI JADWAL ------------------------------ */
  /* Model: tanggal setiap tugas dihitung ulang dari:
       - tanggal mulai manual (tugas leaf / tanpa induk)
       - batas bawah dari dependensi (FS/SS + lag) pada tugas itu sendiri
       - batas bawah turunan dari dependensi tugas induk (diwariskan ke seluruh anak)
     Tugas induk: mulai = awal anak paling awal, selesai = akhir anak paling akhir,
     durasi = akumulasi hari kerja di antaranya.                               */

  function computeSchedule(state) {
    var topo = topoInfo(state);
    var tree = buildTreeIndex(state);
    var order = dfsOrder(state); /* pre-order */
    var byId = {};
    state.tasks.forEach(function (t) { byId[t.id] = t; });

    var depth = {};
    order.forEach(function (t) {
      depth[t.id] = t.parentId != null && depth[t.parentId] != null ? depth[t.parentId] + 1 : 0;
    });
    var parentsByDepthDesc = order
      .filter(function (t) { return tree.children[t.id].length > 0; })
      .sort(function (a, b) { return depth[b.id] - depth[a.id]; });

    var es = {}, ef = {}, dur = {};
    order.forEach(function (t) {
      var kids = tree.children[t.id];
      if (kids.length) return;
      es[t.id] = snapForward(state, t.start);
      dur[t.id] = Math.max(0, parseInt(t.duration, 10) || 0);
      ef[t.id] = durationEnd(state, es[t.id], dur[t.id]);
    });

    var constrained = topo.validPreds;

    for (var iter = 0; iter < 80; iter++) {
      var changed = false;

      /* (a) batas bawah dari dependensi eksplisit */
      var c = {};
      topo.order.forEach(function (id) {
        var t = byId[id];
        if (!t) return;
        var best = null;
        (constrained[id] || []).forEach(function (p) {
          var pred = byId[p.taskId];
          if (!pred || es[pred.id] == null) return;
          var lag = parseInt(p.lag, 10) || 0;
          var r = (p.type === 'SS')
            ? addWorkingDays(state, es[pred.id], lag)
            : addWorkingDays(state, ef[pred.id], 1 + lag);
          r = snapForward(state, r);
          if (!best || r > best) best = r;
        });
        c[id] = best;
      });

      /* (b) wariskan batas bawah tugas induk ke seluruh keturunannya (pre-order) */
      var floorMap = {};
      order.forEach(function (t) {
        var f = c[t.id] || null;
        if (t.parentId != null && floorMap[t.parentId]) {
          if (!f || floorMap[t.parentId] > f) f = floorMap[t.parentId];
        }
        floorMap[t.id] = f;
      });

      /* (c) leaf: maksimum(tanggal mulai manual, batas bawah) */
      order.forEach(function (t) {
        if (tree.children[t.id].length) return;
        var start = snapForward(state, t.start);
        if (floorMap[t.id] && floorMap[t.id] > start) start = floorMap[t.id];
        var d = Math.max(0, parseInt(t.duration, 10) || 0);
        var end = durationEnd(state, start, d);
        if (es[t.id] !== start || ef[t.id] !== end) changed = true;
        es[t.id] = start;
        dur[t.id] = d;
        ef[t.id] = end;
      });

      /* (c2) induk: akumulasi dari anak (anak lebih dulu — urutan kedalaman menurun) */
      parentsByDepthDesc.forEach(function (p) {
        var kids = tree.children[p.id];
        if (!kids.length) return;
        var s = null, e = null;
        kids.forEach(function (k) {
          if (es[k.id] == null) return;
          if (!s || es[k.id] < s) s = es[k.id];
          if (!e || ef[k.id] > e) e = ef[k.id];
        });
        if (!s || !e) return;
        var d = workingDaysBetween(state, s, e);
        if (es[p.id] !== s || ef[p.id] !== e || dur[p.id] !== d) changed = true;
        es[p.id] = s;
        ef[p.id] = e;
        dur[p.id] = d;
      });

      if (!changed) break;
    }

    var dates = {};
    var min = null, max = null;
    order.forEach(function (t) {
      if (es[t.id] == null) {
        es[t.id] = snapForward(state, t.start);
        ef[t.id] = durationEnd(state, es[t.id], Math.max(0, parseInt(t.duration, 10) || 0));
        dur[t.id] = Math.max(0, parseInt(t.duration, 10) || 0);
      }
      dates[t.id] = { start: es[t.id], end: ef[t.id], duration: dur[t.id] };
      if (!min || es[t.id] < min) min = es[t.id];
      if (!max || ef[t.id] > max) max = ef[t.id];
    });

    return {
      dates: dates,
      min: min,
      max: max,
      hasCycle: topo.hasCycle,
      tree: tree,
      order: order
    };
  }

  function projectSpan(state, schedule) {
    var start = schedule.min;
    var end = schedule.max;
    var wd = start && end ? workingDaysBetween(state, start, end) : 0;
    var cal = start && end ? calDiff(start, end) + 1 : 0;
    return { start: start, end: end, workingDays: wd, calendarDays: cal };
  }

  /* ------------------------------ BARIS & NOMOR WBS ------------------------------ */

  function buildRows(state) {
    var tree = buildTreeIndex(state);
    var rows = [];
    function walk(list, depth, prefix) {
      list.forEach(function (t, i) {
        var wbs = prefix ? prefix + '.' + (i + 1) : String(i + 1);
        var kids = tree.children[t.id];
        rows.push({
          task: t,
          depth: depth,
          wbs: wbs,
          isParent: kids.length > 0,
          hasChildren: kids.length > 0
        });
        if (kids.length && !t.collapsed) walk(kids, depth + 1, wbs);
      });
    }
    walk(state.tasks.filter(function (t) { return t.parentId == null; }), 0, '');
    return rows;
  }

  /* ------------------------------ RENDER GANTT ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function render(state, container, ctx) {
    if (!container) return;
    var schedule = ctx.schedule;
    var critical = ctx.critical || {};
    var col = Math.max(12, Math.min(60, state.ui.zoom || 26));
    var mode = state.project.dateFormat;
    var today = ctx.today;

    var rows = buildRows(state);
    var showCrit = !!ctx.showCritical;

    if (!rows.length) {
      container.innerHTML =
        '<div class="empty"><b>Belum ada tugas</b>' +
        'Klik <strong>Tugas Baru</strong> pada toolbar untuk menambahkan tugas pertama proyek Anda.</div>';
      return;
    }

    /* Rentang tanggal grafik */
    var rangeStart = schedule.min;
    var rangeEnd = schedule.max;
    if (today && (!rangeStart || today < rangeStart)) rangeStart = today;
    if (today && (!rangeEnd || today > rangeEnd)) rangeEnd = today;
    if (!rangeStart || !rangeEnd) { rangeStart = today; rangeEnd = addDays(today || toISO(new Date()), 30); }
    rangeStart = addDays(rangeStart, -5);
    rangeEnd = addDays(rangeEnd, 7);
    /* rentang minimal 30 hari */
    if (calDiff(rangeStart, rangeEnd) < 30) rangeEnd = addDays(rangeStart, 30);

    var totalDays = calDiff(rangeStart, rangeEnd) + 1;
    var timelineW = totalDays * col;
    var todayIdx = today ? calDiff(rangeStart, today) : -1;

    /* ---------- HEADER KALENDER ---------- */
    var monthsHtml = '';
    var daysHtml = '';
    var shadesHtml = '';
    var i = 0;
    while (i < totalDays) {
      var iso = addDays(rangeStart, i);
      var ym = iso.slice(0, 7);
      var span = 0;
      while (i + span < totalDays && addDays(rangeStart, i + span).slice(0, 7) === ym) span++;
      var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
      monthsHtml += `<div class="g-month" style="width:${span * col}px">${MONTHS[m - 1]} ${y}</div>`;
      i += span;
    }

    var weekendMask = [];
    for (var d = 0; d < totalDays; d++) {
      var day = addDays(rangeStart, d);
      var we = isWeekendDay(state, day);
      var hol = holidayOn(state, day);
      var isToday = day === today;
      var wd = weekday(day);
      daysHtml += `<div class="g-day${we ? ' we' : ''}${hol ? ' hol' : ''}${isToday ? ' today' : ''}">` +
        `<b>${Number(day.slice(8, 10))}</b><span>${WD_SHORT[wd]}</span></div>`;
      if (we || hol) {
        shadesHtml += `<div class="g-shade${we ? ' we' : ' hol'}" style="left:${d * col}px" ` +
          `title="${hol ? esc(hol.name) : 'Non-working day'} — ${fmtDate(day, mode)}"></div>`;
      }
      weekendMask.push(we);
    }

    /* ---------- BARIS TUGAS ---------- */
    var rowsHtml = '';
    var rowIndexById = {};
    rows.forEach(function (r, idx) {
      rowIndexById[r.task.id] = idx;
    });

    rows.forEach(function (r, idx) {
      var t = r.task;
      var dt = schedule.dates[t.id];
      var sel = state.ui.selectedId === t.id ? ' is-selected' : '';
      var isCrit = showCrit && critical[t.id] ? ' is-critical' : '';
      var startOffset = calDiff(rangeStart, dt.start);
      var spanDays = calDiff(dt.start, dt.end) + 1;
      var barLeft = startOffset * col + 1;
      var barW = Math.max(col - 4, spanDays * col - 3);
      var prog = Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0));
      if (r.isParent) {
        var progKids = childrenOf(state, t);
        if (progKids.length) {
          var progSum = progKids.reduce(function (a, c) {
            return a + Math.max(0, Math.min(100, parseInt(c.progress, 10) || 0));
          }, 0);
          prog = Math.round(progSum / progKids.length);
        }
      }
      var assignee = null;
      (t.assignees || []).forEach(function (rid) {
        if (assignee) return;
        var res = state.resources.filter(function (x) { return x.id === rid; })[0];
        if (res) assignee = res;
      });

      var badgeLeft = barLeft + barW + 6;
      var maxBadgeLeft = Math.max(0, timelineW - 150);
      if (badgeLeft > maxBadgeLeft) badgeLeft = maxBadgeLeft;

      var pri = priorityInfo(t.priority);
      var barColor = isCrit ? '#ef4444' : (t.color || '#6366f1');
      var ariaLabel = `${t.name} — ${fmtDate(dt.start, mode)} s/d ${fmtDate(dt.end, mode)}, ${dt.duration} hari kerja`;

      rowsHtml += `
<div class="gantt-row${r.isParent ? ' is-parent' : ''}${sel}${isCrit}" data-id="${t.id}" title="${esc(ariaLabel)}">
  <div class="g-rowleft">
    <div class="g-c g-c-exp">
      <button type="button" class="g-exp${r.hasChildren ? '' : ' leaf'}" data-action="toggle" data-id="${t.id}" title="Buka/tutup sub-tugas">${t.collapsed && r.hasChildren ? '▸' : (r.hasChildren ? '▾' : '•')}</button>
    </div>
    <div class="g-c g-c-wbs">${r.wbs}</div>
    <div class="g-c g-c-name" style="padding-left:${6 + r.depth * 13}px">
      ${r.depth > 0 ? '<span style="color:#cbd5e1">└</span>' : ''}
      <b>${esc(t.name)}</b>
      <span class="pri ${pri.cls}">${pri.label}</span>
    </div>
    <div class="g-c g-c-start">${fmtDate(dt.start, mode)}</div>
    <div class="g-c g-c-dur">${dt.duration}h</div>
    <div class="g-c g-c-end">${fmtDate(dt.end, mode)}</div>
    <div class="g-c g-c-prog">${prog}%</div>
  </div>
  <div class="g-rowtl">
    <div class="g-bar${r.isParent ? ' is-parent' : ''}${showCrit && critical[t.id] ? ' is-critical' : ''}"
         data-action="bar" data-id="${t.id}"
         style="left:${barLeft}px;width:${barW}px;background:${barColor}">
      ${r.isParent || prog === 0 ? '' : `<div class="g-bar-prog" style="width:${prog}%"></div>`}
      ${r.isParent ? '' : `<span class="g-bar-pct">${prog}%</span>`}
    </div>
    ${assignee ? `<span class="g-badge" style="left:${badgeLeft}px" title="${esc(assignee.name)} — ${esc(assignee.role)}">👤 ${esc(assignee.name.split(',')[0])}</span>` : ''}
  </div>
</div>`;
    });

    /* ---------- PANAH DEPENDENSI ---------- */
    var defs = `<defs><marker id="gpArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 z" fill="#64748b"></path></marker>
      <marker id="gpArrowCrit" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 z" fill="#ef4444"></path></marker></defs>`;

    var links = '';
    rows.forEach(function (r) {
      var t = r.task;
      var si = rowIndexById[t.id];
      (t.predecessors || []).forEach(function (p) {
        var pi = rowIndexById[p.taskId];
        if (pi == null || si == null) return;
        var predRow = rows[pi];
        var predDt = schedule.dates[predRow.task.id];
        var succDt = schedule.dates[t.id];
        if (!predDt || !succDt) return;

        var x1 = (calDiff(rangeStart, p.type === 'SS' ? predDt.start : predDt.end) + 1) * col - 2;
        var x2 = calDiff(rangeStart, succDt.start) * col + 2;
        var y1 = pi * ROW_H + ROW_H / 2;
        var y2 = si * ROW_H + ROW_H / 2;

        var mx;
        if (x2 - x1 >= 26) mx = x1 + 12;
        else mx = (x1 + x2) / 2;
        var path = `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;

        var isCritLink = showCrit && critical[t.id] && critical[predRow.task.id];
        links += `<path class="g-link${p.type === 'SS' ? ' ss' : ''}${isCritLink ? ' crit' : ''}" d="${path}" ` +
          `marker-end="url(#${isCritLink ? 'gpArrowCrit' : 'gpArrow'})"></path>`;
      });
    });

    var bodyH = rows.length * ROW_H;

    container.innerHTML = `
<div class="gantt" style="--row-h:${ROW_H}px;--col:${col}px">
  <div class="gantt-scroll" id="ganttScroll">
    <div class="gantt-inner" style="width:calc(var(--left) + ${timelineW}px)">
      <div class="gantt-header">
        <div class="g-hleft">
          <div class="g-c top spacer-top">DAFTAR TUGAS (WBS)</div>
          <div class="g-c bottom"></div>
          <div class="g-c bottom">#</div>
          <div class="g-c bottom">Nama Tugas</div>
          <div class="g-c bottom">Mulai</div>
          <div class="g-c bottom">Dur</div>
          <div class="g-c bottom">Selesai</div>
          <div class="g-c bottom g-c-prog">%</div>
        </div>
        <div class="g-hright">
          <div class="g-months">${monthsHtml}</div>
          <div class="g-days">${daysHtml}</div>
        </div>
      </div>
      <div class="gantt-body">
        <div class="gantt-shades" style="width:${timelineW}px">
          ${shadesHtml}
          ${todayIdx >= 0 ? `<div class="g-today-line" style="left:${todayIdx * col + col / 2}px" title="Hari ini — ${fmtDate(today, mode)}"></div>` : ''}
        </div>
        <div class="gantt-rows">${rowsHtml}</div>
        <svg class="gantt-links" width="${timelineW}" height="${bodyH}">${defs}${links}</svg>
      </div>
    </div>
  </div>
  <div class="gantt-legend">
    <span class="lg-item"><span class="lg-swatch parent"></span> Tugas induk (ringkasan)</span>
    <span class="lg-item"><span class="lg-swatch" style="background:#6366f1"></span> Batang tugas + progres %</span>
    <span class="lg-item"><span class="lg-swatch crit"></span> Jalur kritis ${showCrit ? '(aktif)' : '(klik Show Critical Path)'}</span>
    <span class="lg-item"><span class="lg-swatch we"></span> Weekend</span>
    <span class="lg-item"><span class="lg-swatch hol"></span> Hari libur</span>
    <span class="lg-item"><span class="lg-line"></span> Hari ini</span>
    <span class="lg-item"><span class="lg-line dash"></span> Panah SS / FS antar tugas</span>
  </div>
</div>`;

    /* posisi scroll awal: dekat hari ini / awal proyek */
    var scroll = document.getElementById('ganttScroll');
    if (scroll && ctx.scrollToToday !== false) {
      var target = todayIdx >= 0 ? todayIdx : 0;
      scroll.scrollLeft = Math.max(0, target * col - 160);
    }
  }

  return {
    parse: parse,
    toISO: toISO,
    addDays: addDays,
    calDiff: calDiff,
    fmtDate: fmtDate,
    isWeekendDay: isWeekendDay,
    holidayOn: holidayOn,
    isWorkingDay: isWorkingDay,
    snapForward: snapForward,
    addWorkingDays: addWorkingDays,
    workingDaysBetween: workingDaysBetween,
    wdIndex: wdIndex,
    durationEnd: durationEnd,
    childrenOf: childrenOf,
    taskById: taskById,
    dfsOrder: dfsOrder,
    buildTreeIndex: buildTreeIndex,
    computeSchedule: computeSchedule,
    projectSpan: projectSpan,
    buildRows: buildRows,
    render: render,
    MONTHS_FULL: MONTHS_FULL
  };
})();
