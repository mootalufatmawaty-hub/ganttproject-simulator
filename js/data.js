/* ============================================================================
   Sistem Informasi Penjadwalan Proyek — GanttProject Web Simulator
   Berkas : js/data.js
   Peran  : Konstanta aplikasi, data contoh (seed WBS), manajemen LocalStorage
   ========================================================================== */

/* ------------------------------- KONSTANTA ------------------------------- */

var STORAGE_KEY = 'gpws_state_v1';

var PALETTE = [
  '#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308',
  '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'
];

var PRIORITIES = [
  { value: 'low', label: 'Low', cls: 'pri-low' },
  { value: 'normal', label: 'Normal', cls: 'pri-normal' },
  { value: 'high', label: 'High', cls: 'pri-high' }
];

/* Role Sets GanttProject: "Default" & "Software Development" */
var ROLE_SETS = {
  default: {
    label: 'Default',
    roles: ['Project Manager', 'Team Leader', 'Team Member']
  },
  softwareDevelopment: {
    label: 'Software Development',
    roles: ['System Analyst', 'UI/UX Designer', 'Programmer', 'QA/Tester', 'Database Engineer', 'DevOps Engineer']
  }
};

var DATE_FORMATS = {
  'DD/MM/YYYY': { order: 'dmy', placeholder: 'contoh: 21/10/2026' },
  'MM/DD/YYYY': { order: 'mdy', placeholder: 'contoh: 10/21/2026' },
  'YYYY-MM-DD': { order: 'ymd', placeholder: 'contoh: 2026-10-21' }
};

var LINK_TYPES = [
  { value: 'FS', label: 'Finish-to-Start (FS)' },
  { value: 'SS', label: 'Start-to-Start (SS)' }
];

var RATE_TYPES = [
  { value: 'hour', label: 'Rate / hour (per jam)' },
  { value: 'task', label: 'Rate / task (per tugas)' }
];

/* Gabungan role set yang dicentang — dipakai pada dropdown peran SDM */
function activeRoles(state) {
  var out = [];
  var sets = (state.project && state.project.roleSets) || {};
  Object.keys(ROLE_SETS).forEach(function (key) {
    if (sets[key]) {
      ROLE_SETS[key].roles.forEach(function (r) {
        if (out.indexOf(r) < 0) out.push(r);
      });
    }
  });
  if (!out.length) out = ROLE_SETS.default.roles.slice();
  return out;
}

function priorityInfo(value) {
  for (var i = 0; i < PRIORITIES.length; i++) {
    if (PRIORITIES[i].value === value) return PRIORITIES[i];
  }
  return PRIORITIES[1];
}

/* ------------------------ UTILITAS TANGGAL (seed) ------------------------ */
/* Helper sederhana khusus membangun data contoh (hanya lewati Sabtu/Minggu).
   Mesin penjadwalan lengkap (libur custom, dsb.) ada di js/gantt.js.        */

function seedToISO(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function seedFromISO(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function seedAddDays(iso, n) {
  var d = seedFromISO(iso);
  d.setDate(d.getDate() + n);
  return seedToISO(d);
}
function seedAddWorkdays(iso, n) {
  var cur = iso;
  var step = n >= 0 ? 1 : -1;
  var left = Math.abs(n);
  while (left > 0) {
    cur = seedAddDays(cur, step);
    var wd = seedFromISO(cur).getDay(); /* 6 = Sabtu, 0 = Minggu */
    if (wd !== 6 && wd !== 0) left--;
  }
  return cur;
}
function seedNextMonday(fromISO) {
  var d = seedFromISO(fromISO || seedToISO(new Date()));
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== 1);
  return seedToISO(d);
}
function seedIsWeekend(iso) {
  var wd = seedFromISO(iso).getDay();
  return wd === 6 || wd === 0;
}

/* ------------------------------- DATA CONTOH ------------------------------- */
/* WBS pengembangan software: Analisis → Desain → Coding → Testing → Deployment.
   Tanggal mulai relatif terhadap Senin terdekat agar grafik selalu hidup.     */

function buildSeedState() {
  var anchor = seedNextMonday();           /* Senin terdekat */
  var nowISO = seedToISO(new Date());

  var phases = [
    {
      name: 'Analisis Kebutuhan', color: '#6366f1', priority: 'high', offset: 0,
      subs: [
        { name: 'Pengumpulan & analisis kebutuhan fungsional', dur: 3, start: 0, progress: 100, assignees: [2] },
        { name: 'Wawancara stakeholder & studi literatur', dur: 3, start: 3, progress: 100, assignees: [2, 1] },
        { name: 'Penyusunan dokumen spesifikasi (SRS)', dur: 4, start: 6, progress: 100, assignees: [2] }
      ],
      links: []
    },
    {
      name: 'Desain Sistem', color: '#0ea5e9', priority: 'high', offset: 12,
      subs: [
        { name: 'Desain UI/UX: wireframe & mockup', dur: 4, start: 0, progress: 100, assignees: [3] },
        { name: 'Desain arsitektur sistem & ERD database', dur: 3, start: 5, progress: 60, assignees: [3] },
        { name: 'Desain API & alur data antar modul', dur: 3, start: 2, progress: 20, assignees: [4] }
      ],
      links: [
        { from: 1, to: 2, type: 'FS', lag: 0 },
        { from: 0, to: 2, type: 'SS', lag: 2 }
      ]
    },
    {
      name: 'Coding / Pengembangan', color: '#f97316', priority: 'high', offset: 24,
      subs: [
        { name: 'Pengembangan modul frontend (SPA)', dur: 5, start: 0, progress: 20, assignees: [4] },
        { name: 'Pengembangan backend & REST API', dur: 5, start: 2, progress: 10, assignees: [4] },
        { name: 'Integrasi modul & autentikasi', dur: 4, start: 7, progress: 0, assignees: [4, 1] }
      ],
      links: [
        { from: 0, to: 1, type: 'SS', lag: 2 },
        { from: 1, to: 2, type: 'FS', lag: 0 }
      ]
    },
    {
      name: 'Testing & QA', color: '#22c55e', priority: 'normal', offset: 38,
      subs: [
        { name: 'Unit test & code review', dur: 3, start: 0, progress: 0, assignees: [5] },
        { name: 'UAT bersama pengguna & perbaikan bug', dur: 4, start: 4, progress: 0, assignees: [5, 4] }
      ],
      links: [
        { from: 0, to: 1, type: 'FS', lag: 0 }
      ]
    },
    {
      name: 'Deployment', color: '#ec4899', priority: 'normal', offset: 48,
      subs: [
        { name: 'Persiapan server, domain & migrasi data', dur: 2, start: 0, progress: 0, assignees: [4] },
        { name: 'Go-Live, monitoring & serah terima', dur: 3, start: 3, progress: 0, assignees: [1, 5] }
      ],
      links: [
        { from: 0, to: 1, type: 'FS', lag: 0 }
      ]
    }
  ];

  var tasks = [];
  var nextId = 1;
  var prevPhaseId = null;

  phases.forEach(function (ph) {
    var parentId = nextId++;
    var phaseStart = seedAddWorkdays(anchor, ph.offset);
    tasks.push({
      id: parentId,
      name: ph.name,
      parentId: null,
      start: phaseStart,
      duration: 1,
      priority: ph.priority,
      color: ph.color,
      progress: 0,
      predecessors: prevPhaseId ? [{ taskId: prevPhaseId, type: 'FS', lag: 0 }] : [],
      assignees: [],
      collapsed: false
    });

    var childIds = [];
    ph.subs.forEach(function (sub) {
      var id = nextId++;
      childIds.push(id);
      tasks.push({
        id: id,
        name: sub.name,
        parentId: parentId,
        start: seedAddWorkdays(phaseStart, sub.start),
        duration: sub.dur,
        priority: ph.priority === 'high' && sub.progress > 0 ? 'high' : 'normal',
        color: ph.color,
        progress: sub.progress,
        predecessors: [],
        assignees: sub.assignees.slice(),
        collapsed: false
      });
    });

    /* dependensi internal antar sub-tugas */
    ph.links.forEach(function (l) {
      var t = tasks.filter(function (x) { return x.id === childIds[l.to]; })[0];
      if (t) {
        t.predecessors.push({ taskId: childIds[l.from], type: l.type, lag: l.lag });
      }
    });

    prevPhaseId = parentId;
  });

  var resources = [
    { id: 1, name: 'Rahmat Hidayat, S.Kom.', email: 'rahmat.hidayat@nusantaradigital.id', phone: '0812-1000-1101', role: 'Project Manager', rate: 200000, rateType: 'hour' },
    { id: 2, name: 'Nur Aisyah, S.T.', email: 'nur.aisyah@nusantaradigital.id', phone: '0813-2000-1102', role: 'System Analyst', rate: 150000, rateType: 'hour' },
    { id: 3, name: 'Dinda Pratiwi, S.Ds.', email: 'dinda.pratiwi@nusantaradigital.id', phone: '0812-3000-1103', role: 'UI/UX Designer', rate: 130000, rateType: 'hour' },
    { id: 4, name: 'Fajar Nugroho, S.Kom.', email: 'fajar.nugroho@nusantaradigital.id', phone: '0857-4000-1104', role: 'Programmer', rate: 160000, rateType: 'hour' },
    { id: 5, name: 'Salsabila Putri, A.Md.', email: 'salsabila.putri@nusantaradigital.id', phone: '0856-5000-1105', role: 'QA/Tester', rate: 950000, rateType: 'task' }
  ];

  /* Hari libur: 1 recurring, 1 one-off (jatuh pada hari kerja) */
  var oneOff = seedAddDays(anchor, 21);
  while (seedIsWeekend(oneOff)) oneOff = seedAddDays(oneOff, 1);
  var year = new Date().getFullYear();

  var holidays = [
    { id: 1, name: 'Hari Kemerdekaan RI', date: year + '-08-17', recurring: true },
    { id: 2, name: 'Tahun Baru Masehi', date: year + '-01-01', recurring: true },
    { id: 3, name: 'Libur Nasional (contoh satu kali)', date: oneOff, recurring: false }
  ];

  return {
    project: {
      name: 'Pengembangan Sistem Informasi Penjadwalan Proyek',
      company: 'PT Nusantara Digital Teknologi',
      description: 'Simulasi penjadwalan proyek pengembangan software: WBS Analisis, Desain, Coding, Testing, ' +
        'sampai Deployment dengan dependensi FS/SS, kalender kerja, alokasi SDM, dan analisis jalur kritis.',
      dateFormat: 'DD/MM/YYYY',
      roleSets: { default: true, softwareDevelopment: true },
      weekend: { sat: true, sun: true }
    },
    holidays: holidays,
    resources: resources,
    tasks: tasks,
    ui: { view: 'gantt', zoom: 26, showCritical: false, selectedId: null },
    meta: {
      nextTaskId: nextId,
      nextResourceId: resources.length + 1,
      nextHolidayId: holidays.length + 1,
      seedAnchor: anchor,
      createdAt: new Date().toISOString(),
      storage: 'localStorage'
    }
  };
}

/* --------------------------- LAPISAN PENYIMPANAN --------------------------- */

var DataStore = {
  memory: {},
  hasLS: (function () {
    try {
      window.localStorage.setItem('__gpws_probe__', '1');
      window.localStorage.removeItem('__gpws_probe__');
      return true;
    } catch (e) { return false; }
  })(),

  get: function (k) {
    if (this.hasLS) return window.localStorage.getItem(k);
    return Object.prototype.hasOwnProperty.call(this.memory, k) ? this.memory[k] : null;
  },
  set: function (k, v) {
    if (this.hasLS) { try { window.localStorage.setItem(k, v); } catch (e) { /* kuota penuh */ } }
    else { this.memory[k] = v; }
  },
  remove: function (k) {
    if (this.hasLS) { try { window.localStorage.removeItem(k); } catch (e) { /* abaikan */ } }
    else { delete this.memory[k]; }
  },

  isValid: function (s) {
    return !!(s && s.project && Array.isArray(s.tasks) && Array.isArray(s.resources) &&
      Array.isArray(s.holidays) && s.ui && s.meta);
  },

  load: function () {
    var raw = this.get(STORAGE_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (this.isValid(parsed)) {
          /* lengkapi field lama agar aman terhadap perubahan skema */
          parsed.project.roleSets = parsed.project.roleSets || { default: true, softwareDevelopment: true };
          parsed.project.weekend = parsed.project.weekend || { sat: true, sun: true };
          parsed.project.dateFormat = parsed.project.dateFormat || 'DD/MM/YYYY';
          return parsed;
        }
      } catch (e) { /* data rusak -> seed ulang */ }
    }
    var seed = buildSeedState();
    this.save(seed);
    return seed;
  },

  save: function (state) {
    if (!state) return;
    state.meta.storage = this.hasLS ? 'localStorage' : 'memori (sesi ini saja)';
    this.set(STORAGE_KEY, JSON.stringify(state));
  },

  reset: function () {
    var seed = buildSeedState();
    this.save(seed);
    return seed;
  },

  clear: function () {
    this.remove(STORAGE_KEY);
  },

  exportJSON: function (state) {
    return JSON.stringify(state, null, 2);
  },

  importJSON: function (text) {
    var parsed = JSON.parse(text);
    if (!this.isValid(parsed)) {
      throw new Error('Struktur JSON tidak dikenali sebagai berkas proyek GanttProject Web Simulator.');
    }
    parsed.project.roleSets = parsed.project.roleSets || { default: true, softwareDevelopment: true };
    parsed.project.weekend = parsed.project.weekend || { sat: true, sun: true };
    parsed.ui = parsed.ui || { view: 'gantt', zoom: 26, showCritical: false, selectedId: null };
    return parsed;
  },

  nextTaskId: function (state) { return state.meta.nextTaskId++; },
  nextResourceId: function (state) { return state.meta.nextResourceId++; },
  nextHolidayId: function (state) { return state.meta.nextHolidayId++; }
};
