//! The database writer: a thread that owns the store and commits what the sampling loop records.
//!
//! Sampling and committing run apart, so a slow commit cannot hold up a tick or the watchdog ping. Under host memory,
//! CPU, or IO pressure a commit has taken 26 seconds, and when the loop committed inline, longer ones made systemd kill
//! the sampler for missing its 30-second watchdog. Now the loop queues each write in memory. Every `FLUSH_EVERY_MS` the
//! writer commits the queue in one transaction, and every hour it runs the rollup. While a commit is slow the queue
//! grows. Past `MAX_QUEUED` writes, new samples and ticks are dropped, and the unit records later samples refer to are
//! kept.

use crate::host::{self, Pressure, UnitKind};
use crate::sampler::now_ms;
use crate::store::{FLUSH_EVERY_MS, SampleRow, Store, TickRow};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Queued writes kept while the writer falls behind: at the default interval, many minutes of samples for dozens of
/// cgroups, in a few megabytes.
const MAX_QUEUED: usize = 50_000;
/// How long one commit or rollup may run before the writer counts as stuck. The sampler then stops pinging the
/// watchdog, so systemd restarts it.
pub const STALL_LIMIT: Duration = Duration::from_secs(600);
/// The first rollup runs this long after start, not at start, when the database is least likely to be cached.
const ROLLUP_EVERY: Duration = Duration::from_secs(3600);
/// A commit or rollup slower than this is logged with how long the service waited on each resource meanwhile.
const SLOW_WORK: Duration = Duration::from_secs(5);

/// One change to the database, recorded by the sampling loop and applied by the writer.
pub enum Write {
    Unit {
        unit_id: i64,
        boot_id: String,
        cgroup_id: u64,
        kind: UnitKind,
        path: String,
        name: String,
        provider: Option<String>,
        created_ms: Option<i64>,
        seen_ms: i64,
    },
    Leader {
        unit_id: i64,
        pid: u32,
        start: u64,
    },
    Identity {
        unit_id: i64,
        owner: Option<String>,
        shared: bool,
        t3_home: Option<String>,
    },
    Threads {
        unit_id: i64,
        threads: Vec<String>,
        ts_ms: i64,
    },
    Gone {
        unit_id: i64,
        ts_ms: i64,
    },
    Sample {
        unit_id: i64,
        ts_ms: i64,
        row: SampleRow,
    },
    Tick(TickRow),
    Meta {
        key: &'static str,
        value: String,
    },
}

impl Write {
    /// Readings the writer may drop when it falls behind. Unit records stay: later samples refer to them.
    fn droppable(&self) -> bool {
        matches!(self, Self::Sample { .. } | Self::Tick(_))
    }

    fn apply(self, store: &Store) -> rusqlite::Result<()> {
        match self {
            Self::Unit {
                unit_id,
                boot_id,
                cgroup_id,
                kind,
                path,
                name,
                provider,
                created_ms,
                seen_ms,
            } => store.insert_unit(
                unit_id,
                &boot_id,
                cgroup_id,
                kind,
                &path,
                &name,
                provider.as_deref(),
                created_ms,
                seen_ms,
            ),
            Self::Leader { unit_id, pid, start } => store.set_leader(unit_id, pid, start),
            Self::Identity {
                unit_id,
                owner,
                shared,
                t3_home,
            } => store.set_identity(unit_id, owner.as_deref(), shared, t3_home.as_deref()),
            Self::Threads {
                unit_id,
                threads,
                ts_ms,
            } => store.saw_threads(unit_id, &threads, ts_ms),
            Self::Gone { unit_id, ts_ms } => store.mark_gone(unit_id, ts_ms),
            Self::Sample { unit_id, ts_ms, row } => store.insert_sample(unit_id, ts_ms, &row),
            Self::Tick(tick) => store.insert_tick(&tick),
            Self::Meta { key, value } => store.set_meta(key, &value),
        }
    }
}

/// Whether the writer is keeping up, as the sampling loop sees it.
pub enum Health {
    Ok,
    /// One commit or rollup has run longer than `STALL_LIMIT`.
    Stuck(Duration),
    /// A commit failed and its batch was rolled back, or the thread ended. The unit rows the sampler tracks may not
    /// exist, so it must restart with fresh state.
    Failed(String),
}

#[derive(Default)]
struct Queue {
    writes: Vec<Write>,
    dropped: u64,
    stop: bool,
}

#[derive(Default)]
struct Status {
    busy_since: Option<Instant>,
    failed: Option<String>,
}

#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    /// Separate from the queue, so the loop can read it while a commit holds the writer.
    status: Mutex<Status>,
}

/// A panic on the other thread does not leave these structures half-updated, so a poisoned lock is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Writer {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Writer {
    /// Start the writer thread. `pressure_dir` is the service's own cgroup, read when work is slow.
    pub fn spawn(store: Store, pressure_dir: Option<PathBuf>) -> Result<Self, String> {
        let shared = Arc::new(Shared::default());
        let thread = std::thread::Builder::new()
            .name("writer".to_owned())
            .spawn({
                let shared = Arc::clone(&shared);
                move || write_loop(&store, &shared, pressure_dir)
            })
            .map_err(|e| format!("cannot start the writer thread: {e}"))?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    pub fn push(&self, write: Write) {
        let mut queue = lock(&self.shared.queue);
        if queue.writes.len() >= MAX_QUEUED && write.droppable() {
            queue.dropped += 1;
        } else {
            queue.writes.push(write);
        }
    }

    pub fn health(&self) -> Health {
        let status = lock(&self.shared.status);
        if let Some(error) = &status.failed {
            return Health::Failed(error.clone());
        }
        if let Some(busy) = status.busy_since.map(|since| since.elapsed())
            && busy >= STALL_LIMIT
        {
            return Health::Stuck(busy);
        }
        if self.thread.as_ref().is_none_or(JoinHandle::is_finished) {
            return Health::Failed("the writer thread ended".to_owned());
        }
        Health::Ok
    }

    /// Commit everything queued and stop the thread. Returns the writer's failure, if it had one.
    pub fn finish(&mut self) -> Result<(), String> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        lock(&self.shared.queue).stop = true;
        self.shared.wake.notify_one();
        if thread.join().is_err() {
            return Err("the writer thread panicked".to_owned());
        }
        lock(&self.shared.status).failed.clone().map_or(Ok(()), Err)
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("session-resources: final commit failed: {error}");
        }
    }
}

fn write_loop(store: &Store, shared: &Shared, pressure_dir: Option<PathBuf>) {
    let flush_every = Duration::from_millis(FLUSH_EVERY_MS.unsigned_abs());
    let mut last_commit = Instant::now();
    let mut last_rollup = Instant::now();
    loop {
        let (writes, dropped, stop) = {
            let mut queue = lock(&shared.queue);
            let deadline = last_commit + flush_every;
            while !queue.stop {
                let Some(left) = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) else {
                    break;
                };
                queue = shared
                    .wake
                    .wait_timeout(queue, left)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
            (
                std::mem::take(&mut queue.writes),
                std::mem::take(&mut queue.dropped),
                queue.stop,
            )
        };
        if dropped > 0 {
            eprintln!("session-resources: the writer fell behind; dropped {dropped} samples and ticks");
        }
        let committed = timed(shared, pressure_dir.as_ref(), "a commit", || {
            if writes.is_empty() {
                return Ok(());
            }
            store.in_transaction(|store| writes.into_iter().try_for_each(|write| write.apply(store)))
        });
        last_commit = Instant::now();
        if let Err(error) = committed {
            lock(&shared.status).failed = Some(error.to_string());
            return;
        }
        if stop {
            return;
        }
        if last_rollup.elapsed() >= ROLLUP_EVERY {
            last_rollup = Instant::now();
            if let Err(error) = timed(shared, pressure_dir.as_ref(), "a rollup", || store.roll_up(now_ms())) {
                eprintln!("session-resources: rollup failed: {error}");
            }
        }
    }
}

/// Run database work, marking the writer busy so the sampling loop can tell a stuck writer from an idle one. Work
/// slower than `SLOW_WORK` is logged with the service's resource waits over the same time.
fn timed<T>(
    shared: &Shared,
    pressure_dir: Option<&PathBuf>,
    what: &str,
    work: impl FnOnce() -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    let before = pressure_dir.map(|dir| host::read_pressure(dir));
    let started = Instant::now();
    lock(&shared.status).busy_since = Some(started);
    let result = work();
    lock(&shared.status).busy_since = None;
    let took = started.elapsed();
    if took >= SLOW_WORK {
        let after = pressure_dir.map(|dir| host::read_pressure(dir));
        eprintln!("session-resources: {}", slow_message(what, took, before.zip(after)));
    }
    result
}

fn slow_message(what: &str, took: Duration, pressure: Option<(Pressure, Pressure)>) -> String {
    let mut message = format!("{what} took {:.1} s", took.as_secs_f64());
    if let Some((before, after)) = pressure {
        let waited = |b: Option<u64>, a: Option<u64>| {
            b.zip(a).map_or_else(
                || "unknown".to_owned(),
                |(b, a)| format!("{:.1} s", a.saturating_sub(b) as f64 / 1e6),
            )
        };
        message.push_str(&format!(
            "; meanwhile this service waited {} on CPU, {} on memory, and {} on IO",
            waited(before.cpu, after.cpu),
            waited(before.memory, after.memory),
            waited(before.io, after.io),
        ));
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_resource_a_slow_commit_waited_on() {
        let before = Pressure {
            cpu: Some(1_000_000),
            memory: Some(0),
            io: None,
        };
        let after = Pressure {
            cpu: Some(13_500_000),
            memory: Some(200_000),
            io: None,
        };
        assert_eq!(
            slow_message("a commit", Duration::from_millis(14_020), Some((before, after))),
            "a commit took 14.0 s; meanwhile this service waited 12.5 s on CPU, 0.2 s on memory, and unknown on IO"
        );
        assert_eq!(
            slow_message("a rollup", Duration::from_secs(6), None),
            "a rollup took 6.0 s"
        );
    }

    #[test]
    fn keeps_unit_records_when_the_queue_is_full() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("s.sqlite")).unwrap();
        let writer = Writer::spawn(store, None).unwrap();
        {
            let mut queue = lock(&writer.shared.queue);
            queue.writes.extend((0..MAX_QUEUED).map(|i| Write::Gone {
                unit_id: 0,
                ts_ms: i64::try_from(i).unwrap(),
            }));
        }
        writer.push(Write::Tick(TickRow {
            ts_ms: 1,
            interval_ms: 2000,
            lag_ms: 0,
            duration_us: 0,
            self_cpu_usec: 0,
            self_rss: 0,
            self_write_bytes: None,
            db_bytes: 0,
            units: 0,
        }));
        writer.push(Write::Gone { unit_id: 0, ts_ms: 0 });
        let queue = lock(&writer.shared.queue);
        assert_eq!(queue.dropped, 1, "the tick is dropped");
        assert_eq!(queue.writes.len(), MAX_QUEUED + 1, "the unit record is kept");
    }
}
