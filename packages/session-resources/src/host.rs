//! Reads from the running host: cgroup v2 files, /proc, and the systemd user hierarchy.
//!
//! Every read opens a kernel pseudo-file and closes it. Nothing here signals, traces, or writes to another process.

use crate::parse;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Where the kernel interfaces live. Tests point both at temporary trees.
#[derive(Debug, Clone)]
pub struct Roots {
    pub cgroup: PathBuf,
    pub proc: PathBuf,
}

impl Default for Roots {
    fn default() -> Self {
        Self {
            cgroup: PathBuf::from("/sys/fs/cgroup"),
            proc: PathBuf::from("/proc"),
        }
    }
}

/// What a measured cgroup is. Stored as text, so the names are part of the database format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    /// The whole machine, from /proc rather than a cgroup.
    Machine,
    /// A T3 agent scope: one provider process and everything it started.
    Agent,
    /// The T3 application itself (server and desktop main process).
    App,
    /// This sampler's own systemd service.
    Sampler,
}

impl UnitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Machine => "machine",
            Self::Agent => "agent",
            Self::App => "app",
            Self::Sampler => "sampler",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "machine" => Self::Machine,
            "agent" => Self::Agent,
            "app" => Self::App,
            "sampler" => Self::Sampler,
            _ => return None,
        })
    }
}

/// The systemd service name the installed sampler runs as. Its own cgroup is measured only under this name, so a
/// foreground run from a terminal does not record the terminal's scope as overhead.
pub const SERVICE_NAME: &str = "session-resources.service";

/// One reading of a cgroup's accounting files. Counters are cumulative since the cgroup was created.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CgroupReading {
    pub cpu_usec: Option<u64>,
    pub mem_current: Option<u64>,
    /// Highest `memory.current` since creation, kept by the kernel between our samples.
    pub mem_peak: Option<u64>,
    /// Page cache charged to the group: `memory.stat` `file` minus `shmem`. Reclaimable, so reports subtract it for
    /// resident memory. tmpfs and shared memory count in `file` but cannot be dropped, so they stay resident.
    pub mem_file: Option<u64>,
    pub pids: Option<u64>,
}

fn read_text(path: &Path) -> io::Result<String> {
    fs::read_to_string(path)
}

fn read_optional(dir: &Path, file: &str) -> Option<String> {
    read_text(&dir.join(file)).ok()
}

/// Read a cgroup's accounting files. Fails only when the group itself is gone; a missing controller leaves its
/// fields empty.
pub fn read_cgroup(dir: &Path) -> io::Result<CgroupReading> {
    let cpu = read_text(&dir.join("cpu.stat"))?;
    let memory_stat = read_optional(dir, "memory.stat");
    Ok(CgroupReading {
        cpu_usec: parse::key_values(&cpu).get("usage_usec").copied(),
        mem_current: read_optional(dir, "memory.current").and_then(|t| parse::single(&t)),
        mem_peak: read_optional(dir, "memory.peak").and_then(|t| parse::single(&t)),
        mem_file: memory_stat.and_then(|t| {
            let values = parse::key_values(&t);
            let file = values.get("file").copied()?;
            Some(file.saturating_sub(values.get("shmem").copied().unwrap_or(0)))
        }),
        pids: read_optional(dir, "pids.current").and_then(|t| parse::single(&t)),
    })
}

/// Whole-machine reading from /proc. CPU is busy time across all CPUs in microseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MachineReading {
    pub cpu_busy_usec: u64,
    pub mem_used: u64,
    pub mem_total: u64,
    pub mem_cached: u64,
}

pub fn read_machine(roots: &Roots) -> io::Result<MachineReading> {
    let invalid = |what| io::Error::new(io::ErrorKind::InvalidData, what);
    let stat = read_text(&roots.proc.join("stat"))?;
    let busy_ticks = parse::proc_stat_busy_ticks(&stat).ok_or_else(|| invalid("unreadable /proc/stat"))?;
    let memory =
        parse::meminfo(&read_text(&roots.proc.join("meminfo"))?).ok_or_else(|| invalid("unreadable /proc/meminfo"))?;
    Ok(MachineReading {
        cpu_busy_usec: busy_ticks * 1_000_000 / clock_ticks_per_second(),
        mem_used: memory.used(),
        mem_total: memory.total,
        mem_cached: memory.cached,
    })
}

fn clock_ticks_per_second() -> u64 {
    // SAFETY: sysconf has no preconditions and only reads a constant.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    u64::try_from(ticks).ok().filter(|t| *t > 0).unwrap_or(100)
}

/// Online CPUs from /proc/stat. Not `available_parallelism`, which follows this process's own cgroup quota and would
/// report one CPU under the service's `CPUQuota`.
pub fn cpu_count(roots: &Roots) -> usize {
    read_text(&roots.proc.join("stat"))
        .map(|t| parse::proc_stat_cpu_count(&t))
        .unwrap_or(0)
        .max(1)
}

/// A cgroup found by discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub kind: UnitKind,
    pub dir: PathBuf,
    pub name: String,
    pub provider: Option<String>,
}

/// The current user's systemd manager cgroup, `user.slice/user-UID.slice/user@UID.service`.
pub fn user_manager(roots: &Roots) -> PathBuf {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    roots
        .cgroup
        .join(format!("user.slice/user-{uid}.slice/user@{uid}.service"))
}

/// Directories whose entries change when T3 starts or stops agents: the user's app slice, T3's agent parent slice,
/// and every slice below it. The sampler watches these with inotify.
pub fn watch_dirs(roots: &Roots) -> Vec<PathBuf> {
    let app = user_manager(roots).join("app.slice");
    let mut dirs = vec![app.clone()];
    let mut pending = vec![app.join("app-t3code.slice")];
    while let Some(dir) = pending.pop() {
        if !dir.is_dir() {
            continue;
        }
        pending.extend(child_dirs(&dir).filter(|d| d.extension().is_some_and(|e| e == "slice")));
        dirs.push(dir);
    }
    dirs
}

fn child_dirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.path())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Every T3 agent scope below `app-t3code.slice`, at any depth, plus the T3 application's own cgroups in the user's
/// app slice.
pub fn discover(roots: &Roots) -> Vec<Found> {
    let app = user_manager(roots).join("app.slice");
    let mut found = Vec::new();
    let mut pending = vec![app.join("app-t3code.slice")];
    while let Some(dir) = pending.pop() {
        for child in child_dirs(&dir) {
            let name = file_name(&child);
            if name.ends_with(".slice") {
                pending.push(child);
            } else if name.ends_with(".scope") {
                found.push(Found {
                    kind: UnitKind::Agent,
                    provider: parse::scope_provider(&name).map(str::to_owned),
                    dir: child,
                    name,
                });
            }
        }
    }
    for child in child_dirs(&app) {
        let name = file_name(&child);
        let lower = name.to_ascii_lowercase();
        if lower.contains("t3code") && !name.ends_with(".slice") {
            found.push(Found {
                kind: UnitKind::App,
                dir: child,
                name,
                provider: None,
            });
        }
    }
    found.sort_by(|a, b| a.dir.cmp(&b.dir));
    found
}

/// The cgroup directory this process runs in, if it is the installed sampler service.
pub fn own_service_cgroup(roots: &Roots) -> Option<PathBuf> {
    let text = read_text(&roots.proc.join("self/cgroup")).ok()?;
    let path = parse::proc_cgroup_path(&text)?;
    path.ends_with(&format!("/{SERVICE_NAME}"))
        .then(|| roots.cgroup.join(path.trim_start_matches('/')))
}

/// The kernel's id for a cgroup: the inode of its directory, unique within one boot.
pub fn cgroup_id(dir: &Path) -> io::Result<u64> {
    Ok(fs::metadata(dir)?.ino())
}

/// When a cgroup directory was created, from its change time, in milliseconds since the epoch.
pub fn cgroup_created_ms(dir: &Path) -> Option<i64> {
    let meta = fs::metadata(dir).ok()?;
    Some(meta.ctime() * 1000 + meta.ctime_nsec() / 1_000_000)
}

pub fn boot_id(roots: &Roots) -> String {
    read_text(&roots.proc.join("sys/kernel/random/boot_id"))
        .map(|t| t.trim().to_owned())
        .unwrap_or_else(|_| "unknown-boot".to_owned())
}

pub fn group_pids(dir: &Path) -> Vec<u32> {
    read_optional(dir, "cgroup.procs")
        .map(|t| parse::pids(&t))
        .unwrap_or_default()
}

pub fn group_populated(dir: &Path) -> Option<bool> {
    read_optional(dir, "cgroup.events").and_then(|t| parse::populated(&t))
}

/// A process at the top of a scope: its parent is outside the scope. T3 starts the provider as one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leader {
    pub pid: u32,
    /// Start time in clock ticks after boot, so a reused pid is not mistaken for the same process.
    pub start: u64,
    pub thread: Option<String>,
    pub t3_home: Option<String>,
}

/// What a scope's processes say about who they work for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub leaders: Vec<Leader>,
    /// Every thread named by `T3CODE_THREAD_ID` in any process in the scope.
    pub threads: Vec<String>,
}

/// Read the leaders of a scope and the threads its processes name, from `/proc/<pid>/stat` and `environ`.
pub fn agent_identity(roots: &Roots, dir: &Path) -> Identity {
    let pids = group_pids(dir);
    let mut identity = Identity::default();
    for &pid in &pids {
        let proc_dir = roots.proc.join(pid.to_string());
        let Ok(block) = fs::read(proc_dir.join("environ")) else {
            continue;
        };
        let thread = parse::environ_var(&block, "T3CODE_THREAD_ID");
        if let Some((ppid, start)) = read_optional(&proc_dir, "stat").and_then(|t| parse::stat_ppid_start(&t))
            && !pids.contains(&ppid)
        {
            identity.leaders.push(Leader {
                pid,
                start,
                thread: thread.clone(),
                t3_home: parse::environ_var(&block, "T3CODE_HOME"),
            });
        }
        if let Some(t) = thread
            && !identity.threads.contains(&t)
        {
            identity.threads.push(t);
        }
    }
    identity
}

/// A process's start time in clock ticks after boot, or `None` when it is gone.
pub fn process_start(roots: &Roots, pid: u32) -> Option<u64> {
    read_optional(&roots.proc.join(pid.to_string()), "stat")
        .and_then(|t| parse::stat_ppid_start(&t))
        .map(|(_, start)| start)
}

/// The cgroup directory of a process, for attributing per-process GPU memory.
pub fn pid_cgroup(roots: &Roots, pid: u32) -> Option<PathBuf> {
    let text = read_text(&roots.proc.join(pid.to_string()).join("cgroup")).ok()?;
    let path = parse::proc_cgroup_path(&text)?;
    Some(roots.cgroup.join(path.trim_start_matches('/')))
}

/// This process's own cost: CPU time, resident memory, and bytes written to storage.
#[derive(Debug, Clone, Copy, Default)]
pub struct SelfReading {
    pub cpu_usec: u64,
    pub rss: u64,
    pub write_bytes: Option<u64>,
}

pub fn read_self(roots: &Roots) -> SelfReading {
    // SAFETY: getrusage writes into the zeroed struct we pass and has no other preconditions.
    let usage = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage
    };
    let micros =
        |t: libc::timeval| u64::try_from(t.tv_sec).unwrap_or(0) * 1_000_000 + u64::try_from(t.tv_usec).unwrap_or(0);
    // SAFETY: sysconf has no preconditions.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096);
    let self_dir = roots.proc.join("self");
    SelfReading {
        cpu_usec: micros(usage.ru_utime) + micros(usage.ru_stime),
        rss: read_optional(&self_dir, "statm")
            .and_then(|t| parse::statm_resident_pages(&t))
            .map_or(0, |pages| pages * page),
        write_bytes: read_optional(&self_dir, "io").and_then(|t| parse::io_write_bytes(&t)),
    }
}
