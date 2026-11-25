//! The sampling loop. Each tick reads every tracked cgroup, the machine totals, NVIDIA memory, and the sampler's own
//! cost. It hands every write to the `writer` thread, and never waits on the database after startup: unit ids are
//! assigned here, from the units recorded at startup.
//!
//! inotify on T3's slices catches a scope as it appears, and on each scope's `cgroup.events` catches its last
//! process exiting, so short scopes get a first and a final reading between ticks.

use crate::gpu::{GpuReading, Nvml};
use crate::host::{self, Roots, UnitKind};
use crate::store::{self, IdentityState, SampleRow, Store, TickRow};
use crate::writer::{Health, Write, Writer};
use std::collections::{HashMap, HashSet};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Slowest interval the sampler backs off to when its ticks get expensive, and the longest it can be configured with.
/// It stays at a third of the service's 30-second `WatchdogSec`, so a slow but healthy sampler is not restarted.
pub const MAX_INTERVAL_MS: i64 = 10_000;
/// A tick that takes more than this fraction of the interval counts as slow.
const SLOW_FRACTION: i64 = 4;
const SLOW_TICKS_BEFORE_BACKOFF: u32 = 3;
const FAST_TICKS_BEFORE_RESTORE: u32 = 30;
/// Samples in which a scope's identity is read every time; its first process may not have exec'd yet.
const IDENTITY_ATTEMPTS: u32 = 30;
/// After that, a scope with no single owner is read every this many samples, to record threads it serves later.
const SHARED_RESCAN_EVERY: u32 = 15;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[derive(Debug)]
struct Tracked {
    unit_id: i64,
    cgroup_id: u64,
    kind: UnitKind,
    class: Class,
    /// The first leader seen, by pid and start time: the process T3 started. Leaders that appear later are commands
    /// reparented after it exited, and never decide who the scope works for.
    leader: Option<(u32, u64)>,
    identity_checks: u32,
}

/// A unit recorded in this boot, kept after its cgroup stops being tracked so the same cgroup seen again reuses it.
#[derive(Debug, Clone, Copy)]
struct Known {
    unit_id: i64,
    class: Class,
    leader: Option<(u32, u64)>,
}

impl Known {
    fn recorded(unit_id: i64, identity: &IdentityState) -> Self {
        let class = match (&identity.owner, identity.shared) {
            (Some(_), _) => Class::Owned,
            (None, true) => Class::Shared,
            (None, false) => Class::Unknown,
        };
        Self {
            unit_id,
            class,
            leader: identity.leader,
        }
    }
}

/// Who an agent scope works for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// Not read yet.
    Unknown,
    /// Its leader names one thread, or the unit is not an agent scope. Settled.
    Owned,
    /// Its leader names no thread: it serves several, as Codex's app-server does.
    Shared,
}

pub struct Options {
    pub roots: Roots,
    pub db: PathBuf,
    pub interval_ms: i64,
    pub gpu: bool,
}

pub struct Sampler {
    roots: Roots,
    db: PathBuf,
    writer: Writer,
    nvml: Option<Nvml>,
    boot_id: String,
    machine_unit: i64,
    tracked: HashMap<PathBuf, Tracked>,
    /// Units of this boot by cgroup id, tracked or not.
    known: HashMap<u64, Known>,
    next_unit_id: i64,
    base_interval_ms: i64,
    interval_ms: i64,
    slow_ticks: u32,
    fast_ticks: u32,
    last_tick_ms: i64,
    /// Work done outside a tick (event samples, watch refreshes, discovery), added to the next tick's recorded duration
    /// so its cost counts toward health and backoff.
    carried_us: i64,
    vram_total_recorded: Option<u64>,
}

impl Sampler {
    /// Open the database and record the startup state directly, then hand the database to the writer thread.
    pub fn new(options: &Options) -> Result<Self, String> {
        let store = Store::open(&options.db).map_err(|e| format!("cannot open {}: {e}", options.db.display()))?;
        let nvml = if options.gpu {
            Nvml::open()
                .map_err(|reason| eprintln!("session-resources: GPU memory off: {reason}"))
                .ok()
        } else {
            None
        };
        let roots = options.roots.clone();
        let boot_id = host::boot_id(&roots);
        let now = now_ms();
        let machine_id = host::cgroup_id(&roots.cgroup).unwrap_or(1);
        let machine_unit = store
            .ensure_unit(&boot_id, machine_id, UnitKind::Machine, "/", "machine", None, None, now)
            .map_err(|e| e.to_string())?;
        store
            .set_meta("cpu_count", &host::cpu_count(&roots).to_string())
            .map_err(|e| e.to_string())?;
        if let Ok(machine) = host::read_machine(&roots) {
            store
                .set_meta("mem_total", &machine.mem_total.to_string())
                .map_err(|e| e.to_string())?;
        }
        store
            .set_meta("interval_ms", &options.interval_ms.to_string())
            .map_err(|e| e.to_string())?;
        // Who is writing, so `status` can tell a stopped sampler from one whose last commit is still pending.
        let pid = std::process::id();
        let start = host::process_start(&roots, pid).map_or_else(String::new, |s| s.to_string());
        store
            .set_meta("writer_pid", &pid.to_string())
            .and_then(|()| store.set_meta("writer_start", &start))
            .and_then(|()| store.set_meta("writer_started_ms", &now.to_string()))
            .map_err(|e| e.to_string())?;
        // Close units a previous run left open that belong to an earlier boot, or whose path is gone or now holds a
        // different cgroup.
        for open in store.open_units().map_err(|e| e.to_string())? {
            let live = open.boot_id == boot_id
                && host::cgroup_id(Path::new(&open.path))
                    .is_ok_and(|id| i64::try_from(id).unwrap_or(i64::MAX) == open.cgroup_id);
            if open.unit_id != machine_unit && !live {
                store
                    .mark_gone(open.unit_id, open.last_seen_ms)
                    .map_err(|e| e.to_string())?;
            }
        }
        let known = store
            .units_of_boot(&boot_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|unit| (unit.cgroup_id, Known::recorded(unit.unit_id, &unit.identity)))
            .collect();
        let next_unit_id = store.max_unit_id().map_err(|e| e.to_string())? + 1;
        let own_cgroup = host::own_service_cgroup(&roots);
        let writer = Writer::spawn(store, own_cgroup.clone())?;
        let mut sampler = Self {
            roots,
            db: options.db.clone(),
            writer,
            nvml,
            boot_id,
            machine_unit,
            tracked: HashMap::new(),
            known,
            next_unit_id,
            base_interval_ms: options.interval_ms,
            interval_ms: options.interval_ms,
            slow_ticks: 0,
            fast_ticks: 0,
            last_tick_ms: now,
            carried_us: 0,
            vram_total_recorded: None,
        };
        if let Some(dir) = own_cgroup {
            sampler.track(&dir, UnitKind::Sampler, host::SERVICE_NAME, None, now);
        }
        Ok(sampler)
    }

    pub fn interval_ms(&self) -> i64 {
        self.interval_ms
    }

    /// Start tracking a cgroup. A cgroup recorded earlier in this boot, by this run or one before a restart, keeps its
    /// unit, pinned leader, and classification. Returns whether it was newly tracked.
    fn track(&mut self, dir: &Path, kind: UnitKind, name: &str, provider: Option<&str>, now: i64) -> bool {
        if self.tracked.contains_key(dir) {
            return false;
        }
        let Ok(cgroup_id) = host::cgroup_id(dir) else {
            return false;
        };
        let known = match self.known.get(&cgroup_id) {
            Some(known) => *known,
            None => {
                let unit_id = self.next_unit_id;
                self.next_unit_id += 1;
                self.writer.push(Write::Unit {
                    unit_id,
                    boot_id: self.boot_id.clone(),
                    cgroup_id,
                    kind,
                    path: dir.to_string_lossy().into_owned(),
                    name: name.to_owned(),
                    provider: provider.map(str::to_owned),
                    created_ms: host::cgroup_created_ms(dir),
                    seen_ms: now,
                });
                let known = Known {
                    unit_id,
                    class: Class::Unknown,
                    leader: None,
                };
                self.known.insert(cgroup_id, known);
                known
            }
        };
        let (class, leader, identity_checks) = match (kind, known.class) {
            (UnitKind::Agent, Class::Shared) => (Class::Shared, known.leader, IDENTITY_ATTEMPTS),
            (UnitKind::Agent, class) => (class, known.leader, 0),
            _ => (Class::Owned, None, 0),
        };
        self.tracked.insert(
            dir.to_owned(),
            Tracked {
                unit_id: known.unit_id,
                cgroup_id,
                kind,
                class,
                leader,
                identity_checks,
            },
        );
        true
    }

    /// Stop tracking a cgroup and record when it went, keeping what was learned about it.
    fn untrack(&mut self, dir: &Path, ts: i64) {
        if let Some(gone) = self.tracked.remove(dir) {
            self.known.insert(
                gone.cgroup_id,
                Known {
                    unit_id: gone.unit_id,
                    class: gone.class,
                    leader: gone.leader,
                },
            );
            self.writer.push(Write::Gone {
                unit_id: gone.unit_id,
                ts_ms: ts,
            });
        }
    }

    /// Find new and vanished scopes. A path that now holds a different cgroup counts as both. Returns the newly
    /// tracked directories.
    pub fn discover(&mut self, now: i64) -> Vec<PathBuf> {
        let found = host::discover(&self.roots);
        let present: HashSet<&Path> = found.iter().map(|f| f.dir.as_path()).collect();
        let vanished: Vec<PathBuf> = self
            .tracked
            .iter()
            .filter(|(dir, t)| {
                t.kind != UnitKind::Sampler
                    && (!present.contains(dir.as_path()) || host::cgroup_id(dir).ok() != Some(t.cgroup_id))
            })
            .map(|(dir, _)| dir.clone())
            .collect();
        for dir in vanished {
            self.untrack(&dir, now);
        }
        let mut added = Vec::new();
        for unit in &found {
            if self.track(&unit.dir, unit.kind, &unit.name, unit.provider.as_deref(), now) {
                added.push(unit.dir.clone());
            }
        }
        added
    }

    fn gpu_reading(&self) -> Option<GpuReading> {
        self.nvml.as_ref().map(Nvml::read)
    }

    /// Device memory per tracked unit: each process's cgroup is matched to the tracked directory that contains it,
    /// so processes in nested cgroups below a delegated scope still count toward the scope. `None` when NVML could
    /// not list processes.
    fn vram_by_unit(&self, gpu: &GpuReading) -> Option<HashMap<i64, Option<u64>>> {
        let mut by_unit: HashMap<i64, Option<u64>> = HashMap::new();
        for (&pid, &bytes) in gpu.per_pid.as_ref()? {
            let Some(cgroup) = host::pid_cgroup(&self.roots, pid) else {
                continue;
            };
            if let Some(tracked) = cgroup.ancestors().find_map(|dir| self.tracked.get(dir)) {
                // One process whose memory NVML cannot report leaves its unit's total unknown.
                let total = by_unit.entry(tracked.unit_id).or_insert(Some(0));
                *total = total.zip(bytes).map(|(a, b)| a + b);
            }
        }
        Some(by_unit)
    }

    /// Read one tracked cgroup and record the sample. A group that has vanished is marked gone.
    fn sample_unit(&mut self, dir: &Path, ts: i64, vram: Option<u64>) {
        let Some(tracked) = self.tracked.get_mut(dir) else {
            return;
        };
        let Ok(reading) = host::read_cgroup(dir) else {
            self.untrack(dir, ts);
            return;
        };
        if tracked.class != Class::Owned {
            tracked.identity_checks += 1;
            let checks = tracked.identity_checks;
            if checks <= IDENTITY_ATTEMPTS || checks.is_multiple_of(SHARED_RESCAN_EVERY) {
                identify(&self.writer, &self.roots, dir, tracked, ts);
            }
        }
        let row = SampleRow {
            cpu_usec: reading.cpu_usec,
            mem_current: reading.mem_current,
            mem_peak: reading.mem_peak,
            mem_file: reading.mem_file,
            pids: reading.pids,
            vram,
            gpu_util: None,
            gpu_power_mw: None,
        };
        self.writer.push(Write::Sample {
            unit_id: tracked.unit_id,
            ts_ms: ts,
            row,
        });
    }

    /// Sample specific directories now, outside the timer: new scopes and scopes whose last process just exited.
    pub fn sample_now(&mut self, dirs: &[PathBuf]) {
        if dirs.is_empty() {
            return;
        }
        let started = Instant::now();
        let ts = now_ms().max(self.last_tick_ms + 1);
        for dir in dirs {
            self.sample_unit(dir, ts, None);
        }
        self.carry(started);
    }

    /// Count work done outside a tick toward the next tick's duration.
    fn carry(&mut self, started: Instant) {
        self.carried_us += i64::try_from(started.elapsed().as_micros()).unwrap_or(i64::MAX);
    }

    /// Whether the writer is keeping up with what this sampler records.
    pub fn writer_health(&self) -> Health {
        self.writer.health()
    }

    /// Commit everything recorded and stop the writer.
    pub fn finish(&mut self) -> Result<(), String> {
        self.writer.finish()
    }

    /// One timed sample of everything. `lag_ms` is how late the tick started.
    pub fn tick(&mut self, ts: i64, lag_ms: i64) {
        let started = Instant::now();
        self.tick_inner(ts);
        self.last_tick_ms = ts;
        let duration_us =
            i64::try_from(started.elapsed().as_micros()).unwrap_or(i64::MAX) + std::mem::take(&mut self.carried_us);
        let me = host::read_self(&self.roots);
        self.writer.push(Write::Tick(TickRow {
            ts_ms: ts,
            interval_ms: self.interval_ms,
            lag_ms,
            duration_us,
            self_cpu_usec: me.cpu_usec,
            self_rss: me.rss,
            self_write_bytes: me.write_bytes,
            db_bytes: store::disk_bytes(&self.db),
            units: self.tracked.len(),
        }));
        self.adapt_interval(duration_us);
    }

    fn tick_inner(&mut self, ts: i64) {
        self.discover(ts);
        let gpu = self.gpu_reading();
        let vram = gpu.as_ref().and_then(|g| self.vram_by_unit(g));
        let dirs: Vec<(PathBuf, i64)> = self.tracked.iter().map(|(d, t)| (d.clone(), t.unit_id)).collect();
        for (dir, unit_id) in dirs {
            // Zero only when NVML listed processes and none of this unit's used GPU memory.
            let unit_vram = vram.as_ref().and_then(|v| v.get(&unit_id).copied().unwrap_or(Some(0)));
            self.sample_unit(&dir, ts, unit_vram);
        }
        if let Ok(machine) = host::read_machine(&self.roots) {
            let row = SampleRow {
                cpu_usec: Some(machine.cpu_busy_usec),
                mem_current: Some(machine.mem_used),
                mem_peak: None,
                mem_file: None,
                pids: None,
                vram: gpu.as_ref().map(|g| g.vram_used),
                gpu_util: gpu.as_ref().and_then(|g| g.util_percent),
                gpu_power_mw: gpu.as_ref().and_then(|g| g.power_mw),
            };
            self.writer.push(Write::Sample {
                unit_id: self.machine_unit,
                ts_ms: ts,
                row,
            });
            if let Some(g) = &gpu
                && self.vram_total_recorded != Some(g.vram_total)
            {
                self.writer.push(Write::Meta {
                    key: "vram_total",
                    value: g.vram_total.to_string(),
                });
                self.vram_total_recorded = Some(g.vram_total);
            }
        }
    }

    /// Back off when ticks get expensive relative to the interval, and return to the configured interval once they
    /// are cheap again. The interval in use is recorded with every tick.
    fn adapt_interval(&mut self, duration_us: i64) {
        let interval_us = self.interval_ms * 1000;
        if duration_us * SLOW_FRACTION > interval_us {
            self.slow_ticks += 1;
            self.fast_ticks = 0;
        } else {
            self.slow_ticks = 0;
            if duration_us * SLOW_FRACTION * 4 < self.base_interval_ms * 1000 {
                self.fast_ticks += 1;
            }
        }
        if self.slow_ticks >= SLOW_TICKS_BEFORE_BACKOFF && self.interval_ms < MAX_INTERVAL_MS {
            self.interval_ms = (self.interval_ms * 2).min(MAX_INTERVAL_MS);
            self.slow_ticks = 0;
            eprintln!(
                "session-resources: ticks took {duration_us} us; sampling every {} ms",
                self.interval_ms
            );
        } else if self.fast_ticks >= FAST_TICKS_BEFORE_RESTORE && self.interval_ms > self.base_interval_ms {
            self.interval_ms = (self.interval_ms / 2).max(self.base_interval_ms);
            self.fast_ticks = 0;
            eprintln!("session-resources: sampling every {} ms again", self.interval_ms);
        }
    }
}

/// Read an agent scope's identity and record it. The pinned leader decides: a thread in its environment makes the
/// scope that thread's, and none makes it shared. Within the first `IDENTITY_ATTEMPTS` checks a shared scope can still
/// become owned, because the leader may not have exec'd into the provider yet. After that, and once the pinned leader
/// is gone, the classification stands.
fn identify(writer: &Writer, roots: &Roots, dir: &Path, tracked: &mut Tracked, ts: i64) {
    let identity = host::agent_identity(roots, dir);
    if tracked.leader.is_none() {
        tracked.leader = identity
            .leaders
            .iter()
            .min_by_key(|l| (l.start, l.pid))
            .map(|l| (l.pid, l.start));
        if let Some((pid, start)) = tracked.leader {
            writer.push(Write::Leader {
                unit_id: tracked.unit_id,
                pid,
                start,
            });
        }
    }
    let pinned = tracked
        .leader
        .and_then(|(pid, start)| identity.leaders.iter().find(|l| l.pid == pid && l.start == start));
    if let Some(leader) = pinned {
        let home = leader.t3_home.as_deref();
        match &leader.thread {
            Some(owner) if tracked.class == Class::Unknown || tracked.identity_checks <= IDENTITY_ATTEMPTS => {
                tracked.class = Class::Owned;
                writer.push(Write::Identity {
                    unit_id: tracked.unit_id,
                    owner: Some(owner.clone()),
                    shared: false,
                    t3_home: home.map(str::to_owned),
                });
            }
            None if tracked.class == Class::Unknown => {
                tracked.class = Class::Shared;
                writer.push(Write::Identity {
                    unit_id: tracked.unit_id,
                    owner: None,
                    shared: true,
                    t3_home: home.map(str::to_owned),
                });
            }
            _ => {}
        }
    }
    if tracked.class == Class::Shared {
        writer.push(Write::Threads {
            unit_id: tracked.unit_id,
            threads: identity.threads,
            ts_ms: ts,
        });
    }
}

/// Set by SIGTERM or SIGINT; the loop commits and exits.
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn request_stop(_signal: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

fn handle_stop_signals() {
    let handler = request_stop as extern "C" fn(libc::c_int);
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, handler as libc::sighandler_t);
        libc::signal(libc::SIGINT, handler as libc::sighandler_t);
    }
}

/// Minimal inotify wrapper over libc: directory watches for scope creation and removal, and `cgroup.events` watches
/// for a scope emptying.
struct Watcher {
    fd: i32,
    dirs: HashMap<i32, PathBuf>,
    events: HashMap<i32, PathBuf>,
    watched: HashSet<PathBuf>,
}

#[derive(Default)]
struct Changes {
    rediscover: bool,
    emptied: Vec<PathBuf>,
}

impl Watcher {
    fn new() -> Option<Self> {
        // SAFETY: inotify_init1 takes flags only and returns a new descriptor or -1.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        (fd >= 0).then(|| Self {
            fd,
            dirs: HashMap::new(),
            events: HashMap::new(),
            watched: HashSet::new(),
        })
    }

    fn add(&mut self, path: &Path, mask: u32) -> Option<i32> {
        if self.watched.contains(path) {
            return None;
        }
        let mut bytes = path.as_os_str().as_bytes().to_vec();
        bytes.push(0);
        // SAFETY: `bytes` is a NUL-terminated path that outlives the call.
        let wd = unsafe { libc::inotify_add_watch(self.fd, bytes.as_ptr().cast(), mask) };
        (wd >= 0).then(|| {
            self.watched.insert(path.to_owned());
            wd
        })
    }

    fn watch_dir(&mut self, dir: &Path) {
        if let Some(wd) = self.add(dir, libc::IN_CREATE | libc::IN_DELETE | libc::IN_ONLYDIR) {
            self.dirs.insert(wd, dir.to_owned());
        }
    }

    fn watch_events(&mut self, scope: &Path) {
        if let Some(wd) = self.add(&scope.join("cgroup.events"), libc::IN_MODIFY) {
            self.events.insert(wd, scope.to_owned());
        }
    }

    /// Wait up to `timeout` for changes.
    fn wait(&mut self, timeout: Duration) -> Changes {
        let mut poll = libc::pollfd {
            fd: self.fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: one valid pollfd for the duration of the call.
        let ready = unsafe { libc::poll(&mut poll, 1, millis) };
        let mut changes = Changes::default();
        if ready <= 0 {
            return changes;
        }
        let mut buffer = [0_u8; 8192];
        loop {
            // SAFETY: reads at most buffer.len() bytes into the buffer.
            let read = unsafe { libc::read(self.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            let Ok(read) = usize::try_from(read) else {
                break;
            };
            if read == 0 {
                break;
            }
            let mut offset = 0;
            let header = std::mem::size_of::<libc::inotify_event>();
            while offset + header <= read {
                // SAFETY: the kernel writes whole events; read_unaligned copes with the byte buffer's alignment.
                let event: libc::inotify_event =
                    unsafe { std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast()) };
                if event.mask & libc::IN_IGNORED != 0 {
                    // Forget the path the watch was added for: the directory, or the scope's `cgroup.events`.
                    if let Some(dir) = self.dirs.remove(&event.wd) {
                        self.watched.remove(&dir);
                    } else if let Some(scope) = self.events.remove(&event.wd) {
                        self.watched.remove(&scope.join("cgroup.events"));
                    }
                } else if self.dirs.contains_key(&event.wd) {
                    changes.rediscover = true;
                } else if let Some(scope) = self.events.get(&event.wd)
                    && host::group_populated(scope) == Some(false)
                {
                    changes.emptied.push(scope.clone());
                }
                offset += header + event.len as usize;
            }
        }
        changes
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: closes the descriptor this watcher owns.
        unsafe {
            libc::close(self.fd);
        }
    }
}

/// Tell systemd about readiness and liveness when run as a `Type=notify` service with a watchdog.
fn sd_notify(message: &str) {
    use std::os::unix::net::UnixDatagram;
    let Some(socket) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    let Ok(datagram) = UnixDatagram::unbound() else {
        return;
    };
    let bytes = socket.as_bytes();
    let result = if let Some(name) = bytes.strip_prefix(b"@") {
        use std::os::linux::net::SocketAddrExt;
        std::os::unix::net::SocketAddr::from_abstract_name(name)
            .and_then(|addr| datagram.send_to_addr(message.as_bytes(), &addr))
    } else {
        datagram.send_to(message.as_bytes(), Path::new(&socket))
    };
    let _ = result;
}

/// Run until killed.
pub fn run(options: &Options) -> Result<(), String> {
    handle_stop_signals();
    let mut sampler = Sampler::new(options)?;
    let mut watcher = Watcher::new();
    let refresh_watches = |watcher: &mut Option<Watcher>, sampler: &mut Sampler| {
        let started = Instant::now();
        if let Some(w) = watcher {
            for dir in host::watch_dirs(&sampler.roots) {
                w.watch_dir(&dir);
            }
            for (dir, tracked) in &sampler.tracked {
                if tracked.kind == UnitKind::Agent {
                    w.watch_events(dir);
                }
            }
        }
        sampler.carry(started);
    };
    sampler.discover(now_ms());
    refresh_watches(&mut watcher, &mut sampler);
    sd_notify("READY=1");
    let mut next = Instant::now();
    let mut stuck_reported = false;
    loop {
        if STOP.load(Ordering::Relaxed) {
            sd_notify("STOPPING=1");
            return sampler.finish();
        }
        let wait = next.saturating_duration_since(Instant::now());
        let changes = match &mut watcher {
            Some(w) => w.wait(wait),
            None => {
                std::thread::sleep(wait);
                Changes::default()
            }
        };
        let mut immediate = changes.emptied;
        if changes.rediscover {
            let started = Instant::now();
            let added = sampler.discover(now_ms());
            sampler.carry(started);
            immediate.extend(added);
            refresh_watches(&mut watcher, &mut sampler);
        }
        sampler.sample_now(&immediate);
        let now = Instant::now();
        if now >= next {
            let lag = i64::try_from(now.duration_since(next).as_millis()).unwrap_or(i64::MAX);
            sampler.tick(now_ms(), lag);
            // The ping says the sampler is sampling and its writer is getting the samples to disk. A slow commit
            // delays the writer without stopping the ping; a writer stuck past its limit withholds it, so systemd
            // restarts a sampler that looks alive and records nothing. A failed commit rolled back unit rows this
            // sampler tracks, so it exits to restart with fresh state.
            match sampler.writer_health() {
                Health::Ok => {
                    stuck_reported = false;
                    sd_notify("WATCHDOG=1");
                }
                Health::Stuck(busy) => {
                    if !stuck_reported {
                        eprintln!(
                            "session-resources: the writer has been stuck for {} s; withholding the watchdog ping",
                            busy.as_secs()
                        );
                        stuck_reported = true;
                    }
                }
                Health::Failed(error) => {
                    return Err(format!(
                        "the writer failed: {error}; exiting to restart with fresh state"
                    ));
                }
            }
            refresh_watches(&mut watcher, &mut sampler);
            let interval = Duration::from_millis(u64::try_from(sampler.interval_ms()).unwrap_or(2000));
            next += interval;
            if next <= Instant::now() {
                next = Instant::now() + interval;
            }
        }
    }
}
