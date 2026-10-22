/* ============================================================================
   Sistem Informasi Penjadwalan Proyek — GanttProject Web Simulator
   Berkas : js/app.js
   Peran  : Event handler, form modal, perhitungan Critical Path (CPM),
            ekspor/impor berkas, dan orkestrasi render seluruh tampilan
   ========================================================================== */

var App = (function () {
  'use strict';

  var state = null;
  var schedule = null;
  var critical = {};
  var criticalCount = 0;
  var today = null;
  var lastCycleWarned = false;

  /* ------------------------------ UTILITAS DOM ------------------------------ */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, tipe) {
    var host = document.getElementById('toastHost');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (tipe || 'info');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 400);
    }, 3400);
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) m.classList.add('is-open');
  }
  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) m.classList.remove('is-open');
  }
  function closeAllModals() {
    $$('.modal.is-open').forEach(function (m) { m.classList.remove('is-open'); });
  }

  function fmtDate(iso) { return GanttEngine.fmtDate(iso, state.project.dateFormat); }

  function fmtRate(res) {
    var n = 'Rp' + Number(res.rate || 0).toLocaleString('id-ID');
    return n + (res.rateType === 'task' ? ' /tugas' : ' /jam');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function slug(s) {
    return String(s || 'proyek')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'proyek';
  }

  function save() { DataStore.save(state); }

  /* --------------------------- PEMBANTU STRUKTUR --------------------------- */

  function taskById(id) { return GanttEngine.taskById(state, id); }

  function selectedTask() {
    return state.ui.selectedId != null ? taskById(state.ui.selectedId) : null;
  }

  function childrenOf(task) { return GanttEngine.childrenOf(state, task); }

  function subtreeOf(task) {
    var out = [];
    (function walk(t) {
      out.push(t);
      childrenOf(t).forEach(walk);
    })(task);
    return out;
  }

  function descendantIds(task) {
    return subtreeOf(task).map(function (t) { return t.id; }).filter(function (id) { return id !== task.id; });
  }

  function siblingsOf(task) {
    return state.tasks.filter(function (t) { return t.parentId === task.parentId; });
  }

  function wbsPath(task) {
    var parts = [];
    var cur = task;
    var guard = 0;
    while (cur && guard++ < 100) {
      var sibs = siblingsOf(cur);
      parts.unshift(String(sibs.indexOf(cur) + 1));
      cur = cur.parentId != null ? taskById(cur.parentId) : null;
    }
    return parts.join('.');
  }

  /* ============================ CRITICAL PATH (CPM) ============================ */
  /* Backward pass pada indeks hari kerja:
     - EF = ES + dur - 1 (satuan hari kerja)
     - LS = LF - dur + 1
     - FS: LF(p) <= LS(s) - 1 - lag
     - SS: LF(p) <= LS(s) - lag + dur(p) - 1
     - Anak tugas induk: LF(anak) <= LF(induk)  (rollup)
     Float = LS - ES; float 0 -> jalur kritis.                                */

  function computeCritical(sch) {
    var set = {};
    var count = 0;
    if (!state.tasks.length) return { set: set, count: 0 };

    var byId = {};
    state.tasks.forEach(function (t) { byId[t.id] = t; });

    var ES = {}, EF = {}, DUR = {};
    state.tasks.forEach(function (t) {
      var d = sch.dates[t.id];
      if (!d) return;
      ES[t.id] = GanttEngine.wdIndex(state, d.start);
      EF[t.id] = GanttEngine.wdIndex(d.end);
      DUR[t.id] = Math.max(0, parseInt(d.duration, 10) || 0);
    });

    var F = 0;
    state.tasks.forEach(function (t) {
      if (EF[t.id] != null && EF[t.id] > F) F = EF[t.id];
    });

    /* daftar penerus: dependensi eksplisit + rollup anak -> induk */
    var succ = {};
    state.tasks.forEach(function (t) { succ[t.id] = []; });
    state.tasks.forEach(function (t) {
      (t.predecessors || []).forEach(function (p) {
        if (!byId[p.taskId] || p.taskId === t.id) return;
        succ[p.taskId].push({ id: t.id, type: p.type === 'SS' ? 'SS' : 'FS', lag: parseInt(p.lag, 10) || 0 });
      });
      if (t.parentId != null && byId[t.parentId]) {
        succ[t.id].push({ id: t.parentId, type: 'ROLLUP', lag: 0 });
      }
    });

    var LF = {};
    state.tasks.forEach(function (t) { LF[t.id] = F; });

    function lateStart(id) {
      return LF[id] - Math.max((DUR[id] || 0) - 1, 0);
    }

    for (var iter = 0; iter <= state.tasks.length * 8 + 40; iter++) {
      var changed = false;
      state.tasks.forEach(function (t) {
        var best = null;
        succ[t.id].forEach(function (s) {
          if (LF[s.id] == null) return;
          var ls = lateStart(s.id);
          var cand;
          if (s.type === 'ROLLUP') {
            cand = LF[s.id];
          } else if (s.type === 'SS') {
            cand = ls - s.lag + Math.max((DUR[t.id] || 0) - 1, 0);
          } else {
            cand = ls - 1 - s.lag + Math.max((DUR[t.id] || 0) - 1, 0);
          }
          if (best == null || cand < best) best = cand;
        });
        if (best != null && best < LF[t.id]) { LF[t.id] = best; changed = true; }
      });
      if (!changed) break;
    }

    state.tasks.forEach(function (t) {
      if (ES[t.id] == null || LF[t.id] == null) return;
      var ls = lateStart(t.id);
      var float = ls - ES[t.id];
      if (float <= 0) { set[t.id] = true; count++; }
    });

    /* tugas induk dianggap kritis bila salah satu anaknya kritis */
    state.tasks.forEach(function (t) {
      if (set[t.id]) return;
      var kids = childrenOf(t);
      if (kids.some(function (k) { return set[k.id]; })) { set[t.id] = true; count++; }
    });

    return { set: set, count: count };
  }

  /* ============================ RENDER ORKESTRASI ============================ */

  function renderHeader() {
    var t = document.getElementById('projTitle');
    var s = document.getElementById('projSub');
    if (t) t.textContent = state.project.name || 'Proyek Tanpa Nama';
    if (s) {
      s.textContent = (state.project.company || 'Organisasi belum diisi') +
        ' · Format ' + state.project.dateFormat;
    }
    var st = document.getElementById('storageInfo');
    if (st) {
      st.innerHTML = '<i></i>' + (DataStore.hasLS ? 'LocalStorage aktif' : 'Mode memori (tanpa LocalStorage)');
      st.className = 'storage-dot' + (DataStore.hasLS ? '' : ' warn');
    }
  }

  function renderStats() {
    function set(id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val;
    }
    var span = GanttEngine.projectSpan(state, schedule);
    var leafCount = state.tasks.filter(function (t) { return childrenOf(t).length === 0; }).length;
    var parentCount = state.tasks.length - leafCount;

    set('statTugas', state.tasks.length + ' tugas');
    var tugasSub = document.getElementById('statTugasSub');
    if (tugasSub) tugasSub.textContent = parentCount + ' induk · ' + leafCount + ' sub-tugas';
    set('statMulai', span.start ? fmtDate(span.start) : '—');
    set('statSelesai', span.end ? fmtDate(span.end) : '—');
    set('statDurasi', span.workingDays + ' hari kerja');
    var durSub = document.getElementById('statDurasiSub');
    if (durSub) durSub.textContent = span.calendarDays + ' hari kalender';

    var kritis = document.getElementById('statKritis');
    if (kritis) {
      if (state.ui.showCritical) {
        kritis.textContent = criticalCount + ' tugas kritis';
        kritis.classList.add('crit');
      } else {
        kritis.textContent = 'Belum diaktifkan';
        kritis.classList.remove('crit');
      }
    }
    set('statSdm', state.resources.length + ' SDM');
    var sdmSub = document.getElementById('statSdmSub');
    if (sdmSub) sdmSub.textContent = state.holidays.length + ' hari libur terdaftar';
  }

  function updateToolbar() {
    var sel = selectedTask();
    function dis(action, off) {
      $$('[data-action="' + action + '"]').forEach(function (b) { b.disabled = !!off; });
    }
    dis('task-props', !sel);
    dis('delete-task', !sel);
    dis('indent', !sel || siblingsOf(sel).indexOf(sel) <= 0);
    dis('outdent', !sel || sel.parentId == null);
    var sibs = sel ? siblingsOf(sel) : [];
    var idx = sel ? sibs.indexOf(sel) : -1;
    dis('move-up', idx <= 0);
    dis('move-down', idx < 0 || idx >= sibs.length - 1);
    $$('[data-action="toggle-critical"]').forEach(function (b) {
      b.classList.toggle('is-active', !!state.ui.showCritical);
    });
    $$('.tab-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === state.ui.view);
    });
    $$('.panel').forEach(function (p) {
      p.classList.toggle('is-active', p.id === 'panel-' + state.ui.view);
    });
  }

  function renderActiveView(opts) {
    opts = opts || {};
    if (state.ui.view === 'pert') {
      PertEngine.render(state, document.getElementById('pertHost'), {
        schedule: schedule,
        critical: critical,
        showCritical: state.ui.showCritical,
        today: today
      });
    } else if (state.ui.view === 'resources') {
      renderResources();
    } else {
      GanttEngine.render(state, document.getElementById('ganttHost'), {
        schedule: schedule,
        critical: critical,
        showCritical: state.ui.showCritical,
        today: today,
        scrollToToday: opts.scrollToToday
      });
    }
  }

  function refresh(opts) {
    opts = opts || {};
    var prevG = document.getElementById('ganttScroll');
    var prevP = document.getElementById('pertScroll');
    var keep = (!opts.scrollToToday && prevG) ? { gl: prevG.scrollLeft, gt: prevG.scrollTop, pl: prevP ? prevP.scrollLeft : 0 } : null;

    schedule = GanttEngine.computeSchedule(state);
    var cp = computeCritical(schedule);
    critical = cp.set;
    criticalCount = cp.count;

    if (schedule.hasCycle && !lastCycleWarned) {
      toast('Terdeteksi siklus dependensi antar tugas — keterkaitan pada siklus diabaikan agar jadwal tetap terhitung.', 'peringatan');
      lastCycleWarned = true;
    }
    if (!schedule.hasCycle) lastCycleWarned = false;

    renderHeader();
    renderStats();
    renderActiveView(opts);
    updateToolbar();

    if (keep) {
      var g = document.getElementById('ganttScroll');
      if (g) { g.scrollLeft = keep.gl; g.scrollTop = keep.gt; }
      var p = document.getElementById('pertScroll');
      if (p) p.scrollLeft = keep.pl;
    }
  }

  function setView(view) {
    state.ui.view = view;
    save();
    refresh();
  }

  /* ============================ SUMBER DAYA (SDM) ============================ */

  function renderResources() {
    var body = document.getElementById('resTableBody');
    var count = document.getElementById('resCount');
    if (count) count.textContent = state.resources.length + ' SDM terdaftar';
    if (!body) return;

    if (!state.resources.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty"><b>Belum ada SDM</b>' +
        'Klik tombol <strong>Tambah SDM</strong> untuk menambahkan sumber daya proyek.</div></td></tr>';
      return;
    }

    body.innerHTML = state.resources.map(function (r, i) {
      var tugas = [];
      state.tasks.forEach(function (t) {
        if ((t.assignees || []).indexOf(r.id) >= 0) tugas.push(t.name);
      });
      var chips = tugas.length
        ? tugas.map(function (n) { return '<span class="chip">' + esc(n) + '</span>'; }).join('')
        : '<span class="cell-sub">Belum ditugaskan</span>';
      var roleTag = r.rateType === 'task' ? 'tag orange' : 'tag green';
      return `<tr>
        <td>${i + 1}</td>
        <td>
          <div class="cell-main">${esc(r.name)}</div>
          <div class="cell-sub">${esc(r.email || '—')}</div>
        </td>
        <td><span class="tag">${esc(r.role)}</span></td>
        <td><div class="cell-main" style="font-weight:600">${esc(r.phone || '—')}</div></td>
        <td><span class="${roleTag}">${fmtRate(r)}</span></td>
        <td>
          <div class="chips">${chips}</div>
          <div class="cell-sub">${tugas.length} tugas</div>
        </td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-sm" data-action="edit-res" data-id="${r.id}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="del-res" data-id="${r.id}">Hapus</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ============================ MODAL TUGAS ============================ */

  var taskModalMode = { mode: 'create', id: null, parentId: null };

  function renderSwatches(current) {
    var host = document.getElementById('colorSwatches');
    if (!host) return;
    host.innerHTML = PALETTE.map(function (c) {
      return `<button type="button" class="swatch${c === current ? ' is-active' : ''}" ` +
        `data-action="pick-color" data-color="${c}" style="background:${c}" title="${c}"></button>`;
    }).join('');
    var hid = document.getElementById('fTaskColor');
    if (hid) hid.value = current;
  }

  function renderPredRows(preds, selfId) {
    var host = document.getElementById('predList');
    if (!host) return;
    var exclude = {};
    exclude[selfId] = true;
    var selfTask = taskById(selfId);
    if (selfTask) descendantIds(selfTask).forEach(function (id) { exclude[id] = true; });

    var options = state.tasks.filter(function (t) { return !exclude[t.id]; });
    if (!preds.length) {
      host.innerHTML = '<div class="cell-sub">Belum ada pendahulu — tugas ini dimulai sesuai tanggal mulai manualnya.</div>';
      return;
    }
    host.innerHTML = preds.map(function (p, i) {
      var opts = options.map(function (t) {
        return `<option value="${t.id}"${t.id === p.taskId ? ' selected' : ''}>${esc(wbsPath(t))}. ${esc(t.name)}</option>`;
      }).join('');
      var typeOpts = LINK_TYPES.map(function (lt) {
        return `<option value="${lt.value}"${lt.value === (p.type || 'FS') ? ' selected' : ''}>${lt.label}</option>`;
      }).join('');
      return `<div class="pred-item">
        <span class="pred-name">Tugas penerus ini didahului oleh:</span>
        <select data-field="taskId">${opts}</select>
        <select data-field="type">${typeOpts}</select>
        <label>lag <input type="number" data-field="lag" min="-30" max="60" value="${parseInt(p.lag, 10) || 0}"> hr</label>
        <button type="button" class="pred-del" data-action="pred-del" data-idx="${i}" title="Hapus keterkaitan">×</button>
      </div>`;
    }).join('');
  }

  function renderAssignGrid(checked) {
    var host = document.getElementById('assignGrid');
    if (!host) return;
    if (!state.resources.length) {
      host.innerHTML = '<div class="cell-sub">Belum ada SDM. Tambahkan lewat tab <strong>Resources</strong>.</div>';
      return;
    }
    host.innerHTML = state.resources.map(function (r) {
      var on = (checked || []).indexOf(r.id) >= 0;
      return `<label class="assign-box">
        <input type="checkbox" value="${r.id}"${on ? ' checked' : ''}>
        <span><b>${esc(r.name.split(',')[0])}</b><span class="ab-role">${esc(r.role)} · ${fmtRate(r)}</span></span>
      </label>`;
    }).join('');
  }

  function openTaskModal(mode, task) {
    taskModalMode = mode;
    var title = document.getElementById('taskModalTitle');
    var sub = document.getElementById('taskModalSub');
    var parentNote = '';
    var isParent = false;

    if (mode.mode === 'edit' && task) {
      isParent = childrenOf(task).length > 0;
      if (title) title.textContent = 'Task Properties — ' + wbsPath(task);
      if (sub) sub.textContent = isParent
        ? 'Tugas induk: tanggal, durasi, dan progres dihitung otomatis dari sub-tugas.'
        : 'Ubah atribut tugas, keterkaitan (predecessors), dan alokasi SDM.';
      $('#fTaskName').value = task.name;
      $('#fTaskStart').value = task.start;
      $('#fTaskDuration').value = task.duration;
      $('#fTaskPriority').value = task.priority;
      $('#fTaskProgress').value = task.progress;
      renderSwatches(task.color);
      renderPredRows((task.predecessors || []).slice(), task.id);
      renderAssignGrid(task.assignees || []);
      parentNote = task.parentId != null && taskById(task.parentId)
        ? 'Induk: ' + esc(taskById(task.parentId).name)
        : 'Tugas tingkat atas (root)';
    } else {
      if (title) title.textContent = 'Tugas Baru';
      if (sub) sub.textContent = 'Isi identitas tugas baru' +
        (mode.parentId != null ? ' sebagai sub-tugas dari induk terpilih.' : '.');
      $('#fTaskName').value = '';
      $('#fTaskStart').value = today;
      $('#fTaskDuration').value = 3;
      $('#fTaskPriority').value = 'normal';
      $('#fTaskProgress').value = 0;
      var parentTask = mode.parentId != null ? taskById(mode.parentId) : null;
      renderSwatches(parentTask ? parentTask.color : PALETTE[0]);
      renderPredRows([], null);
      renderAssignGrid([]);
      parentNote = parentTask ? 'Induk: ' + esc(parentTask.name) : 'Tugas tingkat atas (root)';
    }

    var startEl = $('#fTaskStart'), durEl = $('#fTaskDuration'), progEl = $('#fTaskProgress');
    startEl.disabled = isParent;
    durEl.disabled = isParent;
    progEl.disabled = isParent;
    var startHint = $('#startDurHint');
    if (startHint) startHint.textContent = isParent
      ? 'Tanggal & durasi tugas induk terhitung otomatis dari sub-tugas (gunakan Indent/Outdent untuk struktur).'
      : 'Durasi dihitung dalam hari kerja (melewati weekend & hari libur).';
    var progHint = $('#progressHint');
    if (progHint) progHint.textContent = isParent
      ? 'Progres induk = rata-rata progres sub-tugas.'
      : 'Progres 0–100% ditampilkan pada batang Gantt.';
    var parentEl = $('#taskParentInfo');
    if (parentEl) parentEl.innerHTML = parentNote;

    openModal('taskModal');
    setTimeout(function () { $('#fTaskName').focus(); }, 60);
  }

  function collectPredRows() {
    var rows = $$('#predList .pred-item');
    var out = [];
    rows.forEach(function (row) {
      var taskId = Number($('[data-field="taskId"]', row).value);
      var type = $('[data-field="type"]', row).value;
      var lag = parseInt($('[data-field="lag"]', row).value, 10) || 0;
      if (taskId) out.push({ taskId: taskId, type: type === 'SS' ? 'SS' : 'FS', lag: lag });
    });
    return out;
  }

  function submitTaskForm(e) {
    e.preventDefault();
    var name = $('#fTaskName').value.trim();
    if (!name) { toast('Nama tugas wajib diisi.', 'gagal'); return; }

    var duration = Math.max(0, parseInt($('#fTaskDuration').value, 10) || 0);
    var progress = Math.max(0, Math.min(100, parseInt($('#fTaskProgress').value, 10) || 0));
    var preds = collectPredRows();
    var assignees = $$('#assignGrid input:checked').map(function (i) { return Number(i.value); });

    if (taskModalMode.mode === 'edit') {
      var t = taskById(taskModalMode.id);
      if (!t) { closeModal('taskModal'); return; }
      var isParent = childrenOf(t).length > 0;
      t.name = name;
      if (!isParent) {
        t.start = $('#fTaskStart').value || t.start;
        t.duration = duration;
        t.progress = progress;
      }
      t.priority = $('#fTaskPriority').value;
      t.color = $('#fTaskColor').value || t.color;
      t.predecessors = preds;
      t.assignees = assignees;
      toast('Tugas "' + t.name + '" diperbarui.', 'sukses');
    } else {
      var id = DataStore.nextTaskId(state);
      var parentId = taskModalMode.parentId != null ? taskModalMode.parentId : null;
      var newTask = {
        id: id,
        name: name,
        parentId: parentId,
        start: $('#fTaskStart').value || today,
        duration: duration,
        priority: $('#fTaskPriority').value,
        color: $('#fTaskColor').value || PALETTE[0],
        progress: progress,
        predecessors: preds,
        assignees: assignees,
        collapsed: false
      };
      /* sisipkan setelah seluruh subtree induk agar urutan DFS tetap rapi */
      var insAt = state.tasks.length;
      if (parentId != null) {
        var parent = taskById(parentId);
        if (parent) {
          parent.collapsed = false;
          var psub = subtreeOf(parent);
          insAt = state.tasks.indexOf(psub[psub.length - 1]) + 1;
        }
      }
      state.tasks.splice(insAt, 0, newTask);
      state.ui.selectedId = id;
      toast('Tugas "' + name + '" ditambahkan.', 'sukses');
    }

    closeModal('taskModal');
    save();
    refresh();
  }

  /* ============================ MODAL PROYEK ============================ */

  var projectModalMode = 'edit';

  function renderHolidayList() {
    var host = document.getElementById('holidayList');
    if (!host) return;
    if (!state.holidays.length) {
      host.innerHTML = '<div class="cell-sub">Belum ada hari libur custom.</div>';
      return;
    }
    host.innerHTML = state.holidays.map(function (h) {
      return `<div class="holiday-item">
        <span class="h-name">${esc(h.name)}</span>
        <span class="h-date">${fmtDate(h.date)}${h.recurring ? ' · tiap tahun' : ' · satu kali'}</span>
        <button type="button" class="pred-del" data-action="del-holiday" data-id="${h.id}" title="Hapus libur">×</button>
      </div>`;
    }).join('');
  }

  function renderRolePreview() {
    var host = document.getElementById('rolePreview');
    if (!host) return;
    var roles = activeRoles(state);
    host.innerHTML = '<div class="chips">' +
      roles.map(function (r) { return '<span class="chip">' + esc(r) + '</span>'; }).join('') +
      '</div><div class="cell-sub" style="margin-top:6px">Total ' + roles.length +
      ' peran tersedia untuk dropdown Peran SDM.</div>';
  }

  function openProjectModal(mode) {
    projectModalMode = mode;
    var warn = document.getElementById('newProjectWarn');
    var title = document.getElementById('projModalTitle');
    var submit = document.getElementById('projSubmit');

    if (mode === 'new') {
      if (title) title.textContent = 'Project → New (Proyek Baru)';
      if (warn) warn.style.display = '';
      if (submit) submit.textContent = 'Buat Proyek Baru';
      $('#fProjName').value = '';
      $('#fProjCompany').value = '';
      $('#fProjDesc').value = '';
      $('#fProjFormat').value = state.project.dateFormat;
      $('#chkRoleDefault').checked = true;
      $('#chkRoleSD').checked = true;
      $('#chkSat').checked = true;
      $('#chkSun').checked = true;
    } else {
      if (title) title.textContent = 'Properti Proyek';
      if (warn) warn.style.display = 'none';
      if (submit) submit.textContent = 'Simpan Perubahan';
      $('#fProjName').value = state.project.name || '';
      $('#fProjCompany').value = state.project.company || '';
      $('#fProjDesc').value = state.project.description || '';
      $('#fProjFormat').value = state.project.dateFormat;
      $('#chkRoleDefault').checked = !!state.project.roleSets.default;
      $('#chkRoleSD').checked = !!state.project.roleSets.softwareDevelopment;
      $('#chkSat').checked = !!state.project.weekend.sat;
      $('#chkSun').checked = !!state.project.weekend.sun;
    }
    renderHolidayList();
    renderRolePreview();
    openModal('projectModal');
    setTimeout(function () { $('#fProjName').focus(); }, 60);
  }

  function readProjectForm() {
    return {
      name: $('#fProjName').value.trim() || 'Proyek Tanpa Nama',
      company: $('#fProjCompany').value.trim(),
      description: $('#fProjDesc').value.trim(),
      dateFormat: $('#fProjFormat').value,
      roleSets: {
        default: $('#chkRoleDefault').checked,
        softwareDevelopment: $('#chkRoleSD').checked
      },
      weekend: { sat: $('#chkSat').checked, sun: $('#chkSun').checked }
    };
  }

  function submitProjectForm(e) {
    e.preventDefault();
    var form = readProjectForm();

    if (projectModalMode === 'new') {
      if (!window.confirm('Membuat proyek BARU akan mengosongkan seluruh tugas, SDM, dan hari libur. Lanjutkan?')) return;
      state.project = form;
      state.tasks = [];
      state.resources = [];
      state.holidays = [];
      state.ui.selectedId = null;
      state.meta.nextTaskId = 1;
      state.meta.nextResourceId = 1;
      state.meta.nextHolidayId = 1;
      state.meta.createdAt = new Date().toISOString();
      toast('Proyek baru "' + form.name + '" dibuat. Mulai tambahkan tugas.', 'sukses');
    } else {
      state.project = form;
      toast('Properti proyek disimpan — jadwal dihitung ulang dengan kalender terbaru.', 'sukses');
    }

    closeModal('projectModal');
    save();
    refresh();
  }

  function addHoliday() {
    var name = $('#fHolidayName').value.trim();
    var date = $('#fHolidayDate').value;
    var recurring = $('#fHolidayRecurring').checked;
    if (!name) { toast('Nama hari libur wajib diisi.', 'gagal'); return; }
    if (!date) { toast('Tanggal hari libur wajib dipilih.', 'gagal'); return; }
    state.holidays.push({
      id: DataStore.nextHolidayId(state),
      name: name,
      date: date,
      recurring: !!recurring
    });
    $('#fHolidayName').value = '';
    $('#fHolidayDate').value = '';
    $('#fHolidayRecurring').checked = false;
    save();
    renderHolidayList();
    refresh();
    toast('Hari libur "' + name + '" ditambahkan ke kalender kerja.', 'sukses');
  }

  function deleteHoliday(id) {
    state.holidays = state.holidays.filter(function (h) { return h.id !== id; });
    save();
    renderHolidayList();
    refresh();
    toast('Hari libur dihapus dari kalender.', 'info');
  }

  /* ============================ MODAL SDM ============================ */

  var resModalMode = { mode: 'create', id: null };

  function fillRoleSelect(current) {
    var sel = $('#fResRole');
    if (!sel) return;
    var roles = activeRoles(state);
    if (current && roles.indexOf(current) < 0) roles = roles.concat([current]);
    sel.innerHTML = roles.map(function (r) {
      return `<option value="${esc(r)}"${r === current ? ' selected' : ''}>${esc(r)}</option>`;
    }).join('');
  }

  function openResourceModal(mode, res) {
    resModalMode = mode;
    var title = document.getElementById('resModalTitle');
    if (mode.mode === 'edit' && res) {
      if (title) title.textContent = 'Edit SDM';
      $('#fResName').value = res.name;
      $('#fResEmail').value = res.email || '';
      $('#fResPhone').value = res.phone || '';
      fillRoleSelect(res.role);
      $('#fResRate').value = res.rate;
      $('#fResRateType').value = res.rateType || 'hour';
    } else {
      if (title) title.textContent = 'Tambah SDM';
      $('#fResName').value = '';
      $('#fResEmail').value = '';
      $('#fResPhone').value = '';
      fillRoleSelect(activeRoles(state)[0]);
      $('#fResRate').value = 150000;
      $('#fResRateType').value = 'hour';
    }
    openModal('resourceModal');
    setTimeout(function () { $('#fResName').focus(); }, 60);
  }

  function submitResourceForm(e) {
    e.preventDefault();
    var name = $('#fResName').value.trim();
    if (!name) { toast('Nama SDM wajib diisi.', 'gagal'); return; }

    var payload = {
      name: name,
      email: $('#fResEmail').value.trim(),
      phone: $('#fResPhone').value.trim(),
      role: $('#fResRole').value,
      rate: Math.max(0, parseInt($('#fResRate').value, 10) || 0),
      rateType: $('#fResRateType').value
    };

    if (resModalMode.mode === 'edit') {
      var r = state.resources.filter(function (x) { return x.id === resModalMode.id; })[0];
      if (r) Object.keys(payload).forEach(function (k) { r[k] = payload[k]; });
      toast('Data SDM "' + name + '" diperbarui.', 'sukses');
    } else {
      payload.id = DataStore.nextResourceId(state);
      state.resources.push(payload);
      toast('SDM "' + name + '" ditambahkan.', 'sukses');
    }
    closeModal('resourceModal');
    save();
    refresh();
  }

  function deleteResource(id) {
    var r = state.resources.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    if (!window.confirm('Hapus SDM "' + r.name + '"? Nama yang terpasang pada batang tugas juga akan dilepas.')) return;
    state.resources = state.resources.filter(function (x) { return x.id !== id; });
    state.tasks.forEach(function (t) {
      t.assignees = (t.assignees || []).filter(function (a) { return a !== id; });
    });
    save();
    refresh();
    toast('SDM dihapus beserta alokasinya.', 'info');
  }

  /* ============================ OPERASI STRUKTUR TUGAS ============================ */

  function selectTask(id) {
    state.ui.selectedId = id;
    $$('.gantt-row').forEach(function (r) {
      r.classList.toggle('is-selected', Number(r.getAttribute('data-id')) === id);
    });
    updateToolbar();
  }

  function indentTask() {
    var t = selectedTask();
    if (!t) return;
    var sibs = siblingsOf(t);
    var idx = sibs.indexOf(t);
    if (idx <= 0) { toast('Indent butuh tugas sebelumnya sebagai induk baru.', 'peringatan'); return; }
    var newParent = sibs[idx - 1];
    var sub = subtreeOf(t);
    var arr = state.tasks;
    var at = arr.indexOf(t);
    arr.splice(at, sub.length);
    sub.forEach(function (x) { if (x === t) x.parentId = newParent.id; });
    var ins = arr.indexOf(newParent) + 1;
    arr.splice.apply(arr, [ins, 0].concat(sub));
    newParent.collapsed = false;
    save();
    refresh();
    toast('"' + t.name + '" menjadi sub-tugas dari "' + newParent.name + '".', 'sukses');
  }

  function outdentTask() {
    var t = selectedTask();
    if (!t || t.parentId == null) return;
    var parent = taskById(t.parentId);
    if (!parent) { t.parentId = null; save(); refresh(); return; }
    var sub = subtreeOf(t);
    var arr = state.tasks;
    var at = arr.indexOf(t);
    arr.splice(at, sub.length);
    t.parentId = parent.parentId;
    /* induk yang kehilangan seluruh anak mempertahankan durasi hasil rollup terakhir */
    if (childrenOf(parent).length === 0 && schedule && schedule.dates[parent.id]) {
      parent.duration = schedule.dates[parent.id].duration;
    }
    var psub = subtreeOf(parent);
    var ins = arr.indexOf(psub[psub.length - 1]) + 1;
    arr.splice.apply(arr, [ins, 0].concat(sub));
    save();
    refresh();
    toast('"' + t.name + '" keluar dari struktur induk.', 'sukses');
  }

  function moveTask(dir) {
    var t = selectedTask();
    if (!t) return;
    var sibs = siblingsOf(t);
    var idx = sibs.indexOf(t);
    var other = dir < 0 ? sibs[idx - 1] : sibs[idx + 1];
    if (!other) { toast('Tidak ada tugas untuk ditukar.', 'peringatan'); return; }

    var subT = subtreeOf(t);
    var subO = subtreeOf(other);
    var arr = state.tasks;
    var iT = arr.indexOf(t);
    var iO = arr.indexOf(other);
    var lo = Math.min(iT, iO);
    var hi = Math.max(iT + subT.length, iO + subO.length);
    var chunk = arr.splice(lo, hi - lo);
    var order = dir < 0 ? subT.concat(subO) : subO.concat(subT);
    arr.splice.apply(arr, [lo, 0].concat(order));
    save();
    refresh();
  }

  function deleteTask() {
    var t = selectedTask();
    if (!t) return;
    var n = subtreeOf(t).length;
    var msg = n > 1
      ? 'Hapus "' + t.name + '" beserta ' + (n - 1) + ' sub-tugas di dalamnya?'
      : 'Hapus tugas "' + t.name + '"?';
    if (!window.confirm(msg)) return;
    var ids = {};
    subtreeOf(t).forEach(function (x) { ids[x.id] = true; });
    state.tasks = state.tasks.filter(function (x) { return !ids[x.id]; });
    state.tasks.forEach(function (x) {
      x.predecessors = (x.predecessors || []).filter(function (p) { return !ids[p.taskId]; });
    });
    state.ui.selectedId = null;
    save();
    refresh();
    toast('Tugas dihapus.', 'info');
  }

  /* ============================ EKSPOR / IMPOR ============================ */

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function cdata(s) {
    return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
  }

  function buildGanXml() {
    var roles = activeRoles(state);
    state.resources.forEach(function (r) {
      if (r.role && roles.indexOf(r.role) < 0) roles.push(r.role);
    });

    var span = GanttEngine.projectSpan(state, schedule);
    var startYear = span.start ? Number(span.start.slice(0, 4)) : new Date().getFullYear();
    var endYear = span.end ? Number(span.end.slice(0, 4)) : startYear;

    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push(`<project name="${xmlEsc(state.project.name)}" company="${xmlEsc(state.project.company)}" ` +
      `view-date="${span.start || today}" view-index="0" gantt-divider-location="700" ` +
      `resource-divider-location="320" version="3.3.3309" locale="en">`);
    out.push('<description>' + cdata(
      (state.project.description || '') +
      ' — diekspor dari GanttProject Web Simulator (' + new Date().toISOString().slice(0, 10) + ').'
    ) + '</description>');
    out.push('<view zooming-state="default:6" id="gantt-chart">' +
      '<field id="tpd3" name="Name" width="260" order="0"/>' +
      '<field id="tpd4" name="Begin date" width="130" order="1"/>' +
      '<field id="tpd5" name="End date" width="130" order="2"/>' +
      '<field id="tpd12" name="Cost" width="70" order="3"/>' +
      '<field id="tpc0" name="Is done" width="88" order="4"/>' +
      '<option id="taskLabelRight" value="name"/></view>');
    out.push('<view id="resource-table">' +
      '<field id="0" name="Name" width="170" order="0"/>' +
      '<field id="1" name="Default role" width="160" order="1"/></view>');

    /* kalender kerja */
    var w = state.project.weekend;
    out.push('<calendars><day-types><day-type id="0"/><day-type id="1"/>' +
      `<default-week id="1" name="default" sun="${w.sun ? 1 : 0}" mon="0" ` +
      `tue="0" wed="0" thu="0" fri="0" sat="${w.sat ? 1 : 0}"/>` +
      '<only-show-weekends value="false"/><overriden-day-types/><days/></day-types>');
    state.holidays.forEach(function (h) {
      var y = Number(String(h.date).slice(0, 4));
      var md = String(h.date).slice(5);
      if (h.recurring) {
        for (var yy = Math.min(startYear, y) - 1; yy <= Math.max(endYear, y) + 1; yy++) {
          out.push(`<date year="${yy}" month="${Number(md.slice(0, 2))}" date="${Number(md.slice(3))}" type="HOLIDAY"/>`);
        }
      } else {
        out.push(`<date year="${y}" month="${Number(md.slice(0, 2))}" date="${Number(md.slice(3))}" type="HOLIDAY"/>`);
      }
    });
    out.push('</calendars>');

    /* tugas */
    out.push('<tasks empty-milestones="true"><taskproperties>' +
      '<taskproperty id="tpd0" name="type" type="default" valuetype="icon"/>' +
      '<taskproperty id="tpd1" name="priority" type="default" valuetype="icon"/>' +
      '<taskproperty id="tpd3" name="name" type="default" valuetype="text"/>' +
      '<taskproperty id="tpd4" name="begindate" type="default" valuetype="date"/>' +
      '<taskproperty id="tpd5" name="enddate" type="default" valuetype="date"/>' +
      '<taskproperty id="tpd6" name="duration" type="default" valuetype="int"/>' +
      '<taskproperty id="tpd7" name="completion" type="default" valuetype="int"/>' +
      '<taskproperty id="tpc0" name="Is done" type="custom" valuetype="boolean" defaultvalue="false">' +
      '<simple-select select="completion=100"/></taskproperty></taskproperties>');

    function taskProgress(t) {
      var kids = childrenOf(t);
      if (!kids.length) return Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0));
      var sum = kids.reduce(function (a, c) { return a + (parseInt(c.progress, 10) || 0); }, 0);
      return Math.round(sum / kids.length);
    }

    function emitTask(t) {
      var d = schedule.dates[t.id] || { start: t.start, end: t.start, duration: t.duration };
      var kids = childrenOf(t);
      var head = `<task id="${t.id}" name="${xmlEsc(t.name)}" color="${t.color || '#6366f1'}" ` +
        `meeting="false" start="${d.start}" duration="${d.duration}" complete="${taskProgress(t)}" ` +
        `expand="${t.collapsed ? 'false' : 'true'}" cost-manual-value="0" cost-calculated="false">`;
      var body = '';
      (t.predecessors || []).forEach(function (p) {
        if (!taskById(p.taskId)) return;
        var type = p.type === 'SS' ? 0 : 2; /* 2 = finish-to-start, 0 = start-to-start */
        body += `<depend id="${p.taskId}" type="${type}" difference="${parseInt(p.lag, 10) || 0}" hardness="Strong"/>`;
      });
      if (!kids.length) {
        body += `<customproperty taskproperty-id="tpc0" value="${taskProgress(t) >= 100 ? 'true' : 'false'}"/>`;
        out.push(head + body + '</task>');
        return;
      }
      out.push(head + body);
      kids.forEach(emitTask);
      out.push(`<customproperty taskproperty-id="tpc0" value="${taskProgress(t) >= 100 ? 'true' : 'false'}"/>`);
      out.push('</task>');
    }
    state.tasks.filter(function (t) { return t.parentId == null; }).forEach(emitTask);
    out.push('</tasks>');

    /* sumber daya + alokasi */
    out.push('<resources>');
    state.resources.forEach(function (r) {
      var fn = Math.max(0, roles.indexOf(r.role));
      out.push(`<resource id="${r.id}" name="${xmlEsc(r.name)}" function="${fn}" ` +
        `contacts="${xmlEsc(r.email || '')}" phone="${xmlEsc(r.phone || '')}">` +
        `<rate name="standard" value="${Number(r.rate || 0)}"/></resource>`);
    });
    out.push('</resources>');

    out.push('<allocations>');
    state.tasks.forEach(function (t) {
      (t.assignees || []).forEach(function (rid, i) {
        if (!state.resources.some(function (r) { return r.id === rid; })) return;
        out.push(`<allocation task-id="${t.id}" resource-id="${rid}" ` +
          `function="${Math.max(0, roles.indexOf((state.resources.filter(function (r) { return r.id === rid; })[0] || {}).role))}" ` +
          `responsible="${i === 0 ? 'true' : 'false'}" load="100.0"/>`);
      });
    });
    out.push('</allocations>');

    out.push('<vacations/><previous/>');
    out.push('<roles roleset-name="' +
      (state.project.roleSets.softwareDevelopment && !state.project.roleSets.default
        ? 'Software Development Roles' : 'Default') + '"/>');
    out.push('<roles>');
    roles.forEach(function (r, i) { out.push(`<role id="${i}" name="${xmlEsc(r)}"/>`); });
    out.push('</roles>');
    out.push('</project>');
    return out.join('\n');
  }

  function exportGan() {
    if (!state.tasks.length) { toast('Tidak ada tugas untuk diekspor.', 'peringatan'); return; }
    download(slug(state.project.name) + '.gan', buildGanXml(), 'application/xml;charset=utf-8');
    toast('Berkas .gan (XML GanttProject) berhasil diunduh.', 'sukses');
  }

  function exportJson() {
    download(slug(state.project.name) + '-backup.json', DataStore.exportJSON(state), 'application/json;charset=utf-8');
    toast('Backup JSON proyek berhasil diunduh.', 'sukses');
  }

  function importJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var parsed = DataStore.importJSON(String(ev.target.result || ''));
        state = parsed;
        state.ui.view = state.ui.view || 'gantt';
        save();
        refresh({ scrollToToday: true });
        toast('Proyek berhasil dimuat dari berkas JSON.', 'sukses');
      } catch (err) {
        toast('Impor gagal: ' + err.message, 'gagal');
      }
    };
    reader.onerror = function () { toast('Berkas tidak dapat dibaca.', 'gagal'); };
    reader.readAsText(file);
  }

  /* ============================ AKSI TOOLBAR ============================ */

  function handleAction(action, el, e) {
    var id = el.getAttribute('data-id');
    switch (action) {
      case 'tab':
        setView(el.getAttribute('data-view'));
        break;
      case 'close-modal':
        closeAllModals();
        break;
      case 'zoom-in':
        state.ui.zoom = Math.min(60, (state.ui.zoom || 26) + 4); save(); refresh(); break;
      case 'zoom-out':
        state.ui.zoom = Math.max(12, (state.ui.zoom || 26) - 4); save(); refresh(); break;
      case 'goto-today':
        refresh({ scrollToToday: true }); break;
      case 'toggle-critical':
        state.ui.showCritical = !state.ui.showCritical;
        save(); refresh();
        toast(state.ui.showCritical
          ? 'Jalur kritis ditandai merah (' + criticalCount + ' tugas dengan float 0).'
          : 'Penanda jalur kritis disembunyikan.', 'info');
        break;
      case 'new-project':
        openProjectModal('new'); break;
      case 'project-settings':
        openProjectModal('edit'); break;
      case 'new-task': {
        var selT = selectedTask();
        var newParentId = null;
        if (selT) newParentId = childrenOf(selT).length > 0 ? selT.id : selT.parentId;
        openTaskModal({ mode: 'create', parentId: newParentId });
        break;
      }
      case 'task-props':
        openTaskModal({ mode: 'edit', id: state.ui.selectedId }, selectedTask());
        break;
      case 'indent': indentTask(); break;
      case 'outdent': outdentTask(); break;
      case 'move-up': moveTask(-1); break;
      case 'move-down': moveTask(1); break;
      case 'delete-task': deleteTask(); break;
      case 'export-gan': exportGan(); break;
      case 'export-json': exportJson(); break;
      case 'import-json':
        var fi = document.getElementById('importFile');
        if (fi) { fi.value = ''; fi.click(); }
        break;
      case 'reset-seed':
        if (window.confirm('Kembalikan seluruh data ke contoh proyek awal? Perubahan Anda akan hilang.')) {
          state = DataStore.reset();
          lastCycleWarned = false;
          refresh({ scrollToToday: true });
          toast('Data contoh proyek dimuat ulang.', 'sukses');
        }
        break;
      case 'toggle': {
        var t = taskById(Number(id));
        if (t) { t.collapsed = !t.collapsed; save(); refresh(); }
        break;
      }
      case 'bar': {
        var tid = Number(id);
        selectTask(tid);
        openTaskModal({ mode: 'edit', id: tid }, taskById(tid));
        break;
      }
      case 'pnode': {
        var pid = Number(id);
        state.ui.selectedId = pid;
        openTaskModal({ mode: 'edit', id: pid }, taskById(pid));
        break;
      }
      case 'pick-color': {
        var c = el.getAttribute('data-color');
        var hid = document.getElementById('fTaskColor');
        if (hid) hid.value = c;
        $$('.swatch').forEach(function (s) {
          s.classList.toggle('is-active', s.getAttribute('data-color') === c);
        });
        break;
      }
      case 'add-pred': {
        var selfId = taskModalMode.mode === 'edit' ? taskModalMode.id : null;
        var current = collectPredRows();
        var exclude = {};
        if (selfId != null) {
          exclude[selfId] = true;
          var st = taskById(selfId);
          if (st) descendantIds(st).forEach(function (x) { exclude[x] = true; });
        }
        var candidate = state.tasks.filter(function (x) { return !exclude[x.id]; })[0];
        if (!candidate) { toast('Belum ada tugas lain yang bisa dijadikan pendahulu.', 'peringatan'); break; }
        current.push({ taskId: candidate.id, type: 'FS', lag: 0 });
        renderPredRows(current, selfId);
        break;
      }
      case 'pred-del': {
        var rowsNow = collectPredRows();
        rowsNow.splice(Number(el.getAttribute('data-idx')), 1);
        renderPredRows(rowsNow, taskModalMode.mode === 'edit' ? taskModalMode.id : null);
        break;
      }
      case 'add-holiday': addHoliday(); break;
      case 'del-holiday': deleteHoliday(Number(id)); break;
      case 'new-res': openResourceModal({ mode: 'create' }); break;
      case 'edit-res':
        openResourceModal({ mode: 'edit', id: Number(id) },
          state.resources.filter(function (r) { return r.id === Number(id); })[0]);
        break;
      case 'del-res': deleteResource(Number(id)); break;
      case 'none':
      default:
        break;
    }
    void e;
  }

  /* ============================ BINDING ============================ */

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var overlay = e.target.classList && e.target.classList.contains('modal');
      if (overlay) { e.target.classList.remove('is-open'); return; }

      var actEl = e.target.closest ? e.target.closest('[data-action]') : null;
      if (actEl) {
        var action = actEl.getAttribute('data-action');
        if (action === 'toggle' || action === 'bar') e.stopPropagation();
        handleAction(action, actEl, e);
        return;
      }

      var row = e.target.closest ? e.target.closest('.gantt-row') : null;
      if (row) { selectTask(Number(row.getAttribute('data-id'))); }
    });

    document.addEventListener('dblclick', function (e) {
      var row = e.target.closest ? e.target.closest('.gantt-row') : null;
      if (row) {
        var id = Number(row.getAttribute('data-id'));
        selectTask(id);
        openTaskModal({ mode: 'edit', id: id }, taskById(id));
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllModals();
    });

    var taskForm = document.getElementById('taskForm');
    if (taskForm) taskForm.addEventListener('submit', submitTaskForm);

    var projForm = document.getElementById('projectForm');
    if (projForm) projForm.addEventListener('submit', submitProjectForm);

    var resForm = document.getElementById('resourceForm');
    if (resForm) resForm.addEventListener('submit', submitResourceForm);

    ['chkRoleDefault', 'chkRoleSD'].forEach(function (idn) {
      var el = document.getElementById(idn);
      if (el) el.addEventListener('change', function () {
        /* peran aktif dibaca langsung dari form agar preview selalu up-to-date */
        var bak = state.project.roleSets;
        state.project.roleSets = {
          default: document.getElementById('chkRoleDefault').checked,
          softwareDevelopment: document.getElementById('chkRoleSD').checked
        };
        renderRolePreview();
        fillRoleSelect($('#fResRole') ? $('#fResRole').value : null);
        state.project.roleSets = bak;
      });
    });

    var importFile = document.getElementById('importFile');
    if (importFile) importFile.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importJsonFile(f);
    });
  }

  function init() {
    today = GanttEngine.toISO(new Date());
    state = DataStore.load();
    bindEvents();
    refresh({ scrollToToday: true });
    if (!DataStore.hasLS) {
      toast('Browser memblokir LocalStorage — perubahan hanya bertahan selama tab terbuka.', 'peringatan');
    }
  }

  return { init: init, refresh: refresh };
})();

document.addEventListener('DOMContentLoaded', function () { App.init(); });
