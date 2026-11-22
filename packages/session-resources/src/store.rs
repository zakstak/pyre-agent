//! The sampler's own SQLite database: measured cgroups, their samples, one-minute rollups, and the sampler's ticks.
//!
//! Counters (`cpu_usec`, PSI totals) are stored cumulative, as the kernel reports them, so a missed sample loses
//! resolution but not CPU time. Reports take differences.

use crate::host::UnitKind;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};

/// Samples older than this are folded into one-minute rows.
pub const FULL_RESOLUTION_MS: i64 = 7 * 24 * 3_600_000;
/// How long the sampler holds writes in one open transaction before committing. Every commit writes each changed
/// 4 KiB page to the write-ahead log and later again to the database; batching 15 ticks writes each page once instead of
/// 15 times. Readers see data up to this much behind, and a crash loses at most this much.
pub const FLUSH_EVERY_MS: i64 = 30_000;
const MINUTE_MS: i64 = 60_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS units (
  unit_id INTEGER PRIMARY KEY,
  boot_id TEXT NOT NULL,
  cgroup_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT,
  thread_id TEXT,
  t3_home TEXT,
  created_ms INTEGER,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  gone_ms INTEGER,
  -- 1 when the scope serves several threads, such as Codex's single app-server. Its thread_id stays NULL.
  shared INTEGER NOT NULL DEFAULT 0,
  -- The first leader process seen, so a restarted sampler keeps judging the scope by the same process.
  leader_pid INTEGER,
  leader_start INTEGER,
  UNIQUE (boot_id, cgroup_id)
);
CREATE TABLE IF NOT EXISTS unit_threads (
  unit_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (unit_id, thread_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS unit_threads_thread ON unit_threads (thread_id);
CREATE INDEX IF NOT EXISTS units_thread ON units (thread_id);
CREATE INDEX IF NOT EXISTS units_kind ON units (kind, last_seen_ms);
CREATE TABLE IF NOT EXISTS samples (
  unit_id INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  cpu_usec INTEGER,
  mem_current INTEGER,
  mem_peak INTEGER,
  mem_file INTEGER,
  pids INTEGER,
  vram INTEGER,
  gpu_util INTEGER,
  gpu_power_mw INTEGER,
  PRIMARY KEY (unit_id, ts_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS samples_1m (
  unit_id INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  n INTEGER NOT NULL,
  first_ts_ms INTEGER NOT NULL,
  last_ts_ms INTEGER NOT NULL,
  cpu_usec_first INTEGER,
  cpu_usec INTEGER,
  mem_current_avg REAL,
  mem_current_max INTEGER,
  mem_peak INTEGER,
  resident_avg REAL,
  resident_max INTEGER,
  pids_max INTEGER,
  vram_avg REAL,
  vram_max INTEGER,
  gpu_util_avg REAL,
  gpu_power_mw_avg REAL,
  PRIMARY KEY (unit_id, ts_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ticks (
  ts_ms INTEGER PRIMARY KEY,
  interval_ms INTEGER NOT NULL,
  lag_ms INTEGER NOT NULL,
  duration_us INTEGER NOT NULL,
  self_cpu_usec INTEGER NOT NULL,
  self_rss INTEGER NOT NULL,
  self_write_bytes INTEGER,
  db_bytes INTEGER NOT NULL,
  units INTEGER NOT NULL
);
";

pub fn default_db_path() -> PathBuf {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state"));
    state.join("session-resources/samples.sqlite")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[derive(Debug, Clone, Default)]
pub struct SampleRow {
    pub cpu_usec: Option<u64>,
    pub mem_current: Option<u64>,
    pub mem_peak: Option<u64>,
    pub mem_file: Option<u64>,
    pub pids: Option<u64>,
    pub vram: Option<u64>,
    pub gpu_util: Option<u64>,
    pub gpu_power_mw: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub struct TickRow {
    pub ts_ms: i64,
    pub interval_ms: i64,
    pub lag_ms: i64,
    pub duration_us: i64,
    pub self_cpu_usec: u64,
    pub self_rss: u64,
    pub self_write_bytes: Option<u64>,
    pub db_bytes: u64,
    pub units: usize,
}

#[derive(Debug, Clone)]
pub struct RecentThread {
    pub thread_id: String,
    pub t3_home: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

impl Unit {
    /// When the unit's counters started: its creation time, or when it was first seen if that is unknown. The
    /// machine's counters run since boot, so it has no start inside any window.
    pub fn start_ms(&self) -> i64 {
        self.created_ms
            .map_or(self.first_seen_ms, |c| c.min(self.first_seen_ms))
    }
}

#[derive(Debug, Clone)]
pub struct Unit {
    pub unit_id: i64,
    pub kind: UnitKind,
    pub provider: Option<String>,
    /// When the cgroup was created, from its directory's change time. Its counters start here.
    pub created_ms: Option<i64>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub gone_ms: Option<i64>,
}

/// A shared scope a thread's commands ran in, and how many threads it served.
#[derive(Debug, Clone)]
pub struct SharedUse {
    pub unit: Unit,
    pub threads: usize,
    /// When this thread was first and last seen in the scope.
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

/// A unit's recorded identity: its owning thread, whether it is shared, and its pinned leader (pid, start time).
#[derive(Debug, Clone)]
pub struct IdentityState {
    pub owner: Option<String>,
    pub shared: bool,
    pub leader: Option<(u32, u64)>,
}

/// An open unit as recorded, for reconciling with live cgroups at startup.
#[derive(Debug, Clone)]
pub struct OpenUnit {
    pub unit_id: i64,
    pub boot_id: String,
    pub cgroup_id: i64,
    pub path: String,
    pub last_seen_ms: i64,
}

/// A sample or one end of a one-minute rollup, read the same way. For a raw sample the averages and maxima are the
/// value. A rollup reads as two points, at its first and last sample, so counters and integrated time keep their
/// real timestamps.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Point {
    pub ts_ms: i64,
    pub cpu_usec: Option<u64>,
    pub mem_peak: Option<u64>,
    pub resident_avg: f64,
    pub resident_max: u64,
    pub mem_current_max: u64,
    pub pids_max: u64,
    /// `None` when GPU memory was not read for this sample.
    pub vram_avg: Option<f64>,
    pub vram_max: Option<u64>,
    pub gpu_util_avg: Option<f64>,
    pub gpu_power_mw_avg: Option<f64>,
}

pub struct Store {
    conn: Connection,
    path: PathBuf,
}

/// The database layout version, in SQLite's `user_version`. A file with another version is refused rather than
/// misread.
const SCHEMA_VERSION: i64 = 1;

fn to_i64(value: Option<u64>) -> Option<i64> {
    value.map(|v| i64::try_from(v).unwrap_or(i64::MAX))
}

fn to_u64(value: Option<i64>) -> Option<u64> {
    value.map(|v| u64::try_from(v).unwrap_or(0))
}

impl Store {
    /// Open for writing, creating the file and schema. Only the sampler writes.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let setup = || -> rusqlite::Result<(Connection, i64)> {
            let conn = Connection::open(path)?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            let version = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            Ok((conn, version))
        };
        let (conn, version) = setup().map_err(|e| e.to_string())?;
        if version != 0 && version != SCHEMA_VERSION {
            return Err(format!(
                "its layout is version {version}, not {SCHEMA_VERSION}; move it aside to start a new one"
            ));
        }
        conn.execute_batch(SCHEMA)
            .and_then(|()| conn.pragma_update(None, "user_version", SCHEMA_VERSION))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn,
            path: path.to_owned(),
        })
    }

    /// Open an existing database for reports, without creating or migrating anything.
    pub fn open_read_only(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            conn,
            path: path.to_owned(),
        })
    }

    /// Bytes on disk for the database and its write-ahead log.
    pub fn disk_bytes(&self) -> u64 {
        let size = |p: PathBuf| std::fs::metadata(p).map_or(0, |m| m.len());
        let mut wal = self.path.clone().into_os_string();
        wal.push("-wal");
        size(self.path.clone()) + size(PathBuf::from(wal))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    }

    /// Open the batch transaction if none is open. Writes collect in it until `flush`. Whether one is open is read from
    /// SQLite, so a failed commit or rollback cannot leave this out of step.
    pub fn ensure_batch(&self) -> rusqlite::Result<()> {
        if self.conn.is_autocommit() {
            self.conn.execute_batch("BEGIN")?;
        }
        Ok(())
    }

    /// Commit the batch transaction, if one is open. A failed commit rolls back, dropping the batch, so the next batch
    /// starts clean.
    pub fn flush(&self) -> rusqlite::Result<()> {
        if self.conn.is_autocommit() {
            return Ok(());
        }
        self.conn.execute_batch("COMMIT").inspect_err(|_| self.rollback())
    }

    fn rollback(&self) {
        if !self.conn.is_autocommit() {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }

    /// The unit id for a cgroup, inserting it on first sight. A recreated cgroup has a new kernel id, so it is a new
    /// unit even under the same name.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_unit(
        &self,
        boot_id: &str,
        cgroup_id: u64,
        kind: UnitKind,
        path: &str,
        name: &str,
        provider: Option<&str>,
        created_ms: Option<i64>,
        now_ms: i64,
    ) -> rusqlite::Result<i64> {
        let cgroup_id = i64::try_from(cgroup_id).unwrap_or(i64::MAX);
        if let Some(id) = self
            .conn
            .query_row(
                "SELECT unit_id FROM units WHERE boot_id = ?1 AND cgroup_id = ?2",
                params![boot_id, cgroup_id],
                |r| r.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO units (boot_id, cgroup_id, kind, path, name, provider, created_ms, first_seen_ms, last_seen_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![boot_id, cgroup_id, kind.as_str(), path, name, provider, created_ms, now_ms],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Record who a scope works for: one thread that owns it, or none for a shared scope.
    pub fn set_identity(
        &self,
        unit_id: i64,
        owner: Option<&str>,
        shared: bool,
        t3_home: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE units SET thread_id = ?2, shared = ?3, t3_home = coalesce(?4, t3_home) WHERE unit_id = ?1",
            params![unit_id, owner, shared, t3_home],
        )?;
        Ok(())
    }

    /// Whether a batch transaction is open. A failed write can make SQLite roll the batch back on its own.
    pub fn batch_open(&self) -> bool {
        !self.conn.is_autocommit()
    }

    /// What is recorded about a unit's identity.
    pub fn identity_state(&self, unit_id: i64) -> rusqlite::Result<IdentityState> {
        self.conn.query_row(
            "SELECT thread_id, shared, leader_pid, leader_start FROM units WHERE unit_id = ?1",
            [unit_id],
            |r| {
                let pid: Option<i64> = r.get(2)?;
                let start: Option<i64> = r.get(3)?;
                let leader = pid
                    .zip(start)
                    .and_then(|(p, s)| Some((u32::try_from(p).ok()?, u64::try_from(s).ok()?)));
                Ok(IdentityState {
                    owner: r.get(0)?,
                    shared: r.get::<_, i64>(1)? != 0,
                    leader,
                })
            },
        )
    }

    pub fn set_leader(&self, unit_id: i64, pid: u32, start: u64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE units SET leader_pid = ?2, leader_start = ?3 WHERE unit_id = ?1",
            params![unit_id, pid, i64::try_from(start).unwrap_or(i64::MAX)],
        )?;
        Ok(())
    }

    /// Record threads seen in a scope's processes at `now_ms`.
    pub fn saw_threads(&self, unit_id: i64, threads: &[String], now_ms: i64) -> rusqlite::Result<()> {
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO unit_threads (unit_id, thread_id, first_seen_ms, last_seen_ms) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT (unit_id, thread_id) DO UPDATE SET last_seen_ms = max(last_seen_ms, excluded.last_seen_ms)",
        )?;
        for thread in threads {
            stmt.execute(params![unit_id, thread, now_ms])?;
        }
        Ok(())
    }

    pub fn mark_gone(&self, unit_id: i64, gone_ms: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE units SET gone_ms = ?2 WHERE unit_id = ?1 AND gone_ms IS NULL",
            params![unit_id, gone_ms],
        )?;
        Ok(())
    }

    /// Units the previous sampler run left open: their cgroups may have gone while it was stopped.
    pub fn open_units(&self) -> rusqlite::Result<Vec<OpenUnit>> {
        let mut stmt = self
            .conn
            .prepare("SELECT unit_id, boot_id, cgroup_id, path, last_seen_ms FROM units WHERE gone_ms IS NULL")?;
        stmt.query_map([], |r| {
            Ok(OpenUnit {
                unit_id: r.get(0)?,
                boot_id: r.get(1)?,
                cgroup_id: r.get(2)?,
                path: r.get(3)?,
                last_seen_ms: r.get(4)?,
            })
        })?
        .collect()
    }

    pub fn insert_sample(&self, unit_id: i64, ts_ms: i64, row: &SampleRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO samples
               (unit_id, ts_ms, cpu_usec, mem_current, mem_peak, mem_file, pids, vram, gpu_util, gpu_power_mw)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                unit_id,
                ts_ms,
                to_i64(row.cpu_usec),
                to_i64(row.mem_current),
                to_i64(row.mem_peak),
                to_i64(row.mem_file),
                to_i64(row.pids),
                to_i64(row.vram),
                to_i64(row.gpu_util),
                to_i64(row.gpu_power_mw),
            ],
        )?;
        self.conn.execute(
            "UPDATE units SET last_seen_ms = max(last_seen_ms, ?2) WHERE unit_id = ?1",
            params![unit_id, ts_ms],
        )?;
        Ok(())
    }

    pub fn insert_tick(&self, tick: &TickRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO ticks
               (ts_ms, interval_ms, lag_ms, duration_us, self_cpu_usec, self_rss, self_write_bytes, db_bytes, units)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                tick.ts_ms,
                tick.interval_ms,
                tick.lag_ms,
                tick.duration_us,
                to_i64(Some(tick.self_cpu_usec)),
                to_i64(Some(tick.self_rss)),
                to_i64(tick.self_write_bytes),
                to_i64(Some(tick.db_bytes)),
                i64::try_from(tick.units).unwrap_or(i64::MAX),
            ],
        )?;
        Ok(())
    }

    /// Fold full-resolution samples older than `now - FULL_RESOLUTION_MS` into one-minute rows, and drop ticks older
    /// than that. The cutoff falls on a minute boundary, so no minute is split between the two tables. Each row keeps
    /// its first and last sample's time and CPU counter. Commits the open batch first, and rolls back on failure.
    pub fn roll_up(&self, now_ms: i64) -> rusqlite::Result<usize> {
        let cutoff = (now_ms - FULL_RESOLUTION_MS).div_euclid(MINUTE_MS) * MINUTE_MS;
        self.flush()?;
        self.conn.execute_batch("BEGIN")?;
        let work = || -> rusqlite::Result<usize> {
            let folded = self.conn.execute(
                "INSERT OR REPLACE INTO samples_1m
                   (unit_id, ts_ms, n, first_ts_ms, last_ts_ms, cpu_usec_first, cpu_usec, mem_current_avg,
                    mem_current_max, mem_peak, resident_avg, resident_max, pids_max,
                    vram_avg, vram_max, gpu_util_avg, gpu_power_mw_avg)
                 SELECT unit_id, (ts_ms / 60000) * 60000, count(*), min(ts_ms), max(ts_ms), min(cpu_usec),
                        max(cpu_usec), avg(mem_current), max(mem_current), max(mem_peak),
                        avg(mem_current - coalesce(mem_file, 0)), max(mem_current - coalesce(mem_file, 0)), max(pids),
                        avg(vram), max(vram), avg(gpu_util), avg(gpu_power_mw)
                 FROM samples WHERE ts_ms < ?1 GROUP BY 1, 2",
                [cutoff],
            )?;
            self.conn.execute("DELETE FROM samples WHERE ts_ms < ?1", [cutoff])?;
            self.conn.execute("DELETE FROM ticks WHERE ts_ms < ?1", [cutoff])?;
            self.conn.execute_batch("COMMIT")?;
            Ok(folded)
        };
        work().inspect_err(|_| self.rollback())
    }

    fn unit_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Unit> {
        let kind: String = row.get(1)?;
        Ok(Unit {
            unit_id: row.get(0)?,
            kind: UnitKind::parse(&kind).unwrap_or(UnitKind::Agent),
            provider: row.get(2)?,
            created_ms: row.get(4)?,
            first_seen_ms: row.get(5)?,
            last_seen_ms: row.get(6)?,
            gone_ms: row.get(7)?,
        })
    }

    const UNIT_COLUMNS: &'static str =
        "unit_id, kind, provider, t3_home, created_ms, first_seen_ms, last_seen_ms, gone_ms";

    /// The T3 home recorded for a thread, from a scope it owns or a shared scope its commands ran in.
    pub fn t3_home_for_thread(&self, thread_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row(
            "SELECT coalesce(
               (SELECT max(t3_home) FROM units WHERE thread_id = ?1),
               (SELECT max(u.t3_home) FROM unit_threads t JOIN units u ON u.unit_id = t.unit_id WHERE t.thread_id = ?1))",
            [thread_id],
            |r| r.get(0),
        )
    }

    /// Shared scopes whose processes named `thread_id`, with how many threads each served.
    pub fn shared_units_for_thread(&self, thread_id: &str) -> rusqlite::Result<Vec<SharedUse>> {
        let mut stmt = self.conn.prepare(
            "SELECT u.unit_id, u.kind, u.provider, u.t3_home, u.created_ms, u.first_seen_ms, u.last_seen_ms, u.gone_ms,
                    (SELECT count(*) FROM unit_threads o WHERE o.unit_id = u.unit_id), t.first_seen_ms, t.last_seen_ms
             FROM unit_threads t JOIN units u ON u.unit_id = t.unit_id
             WHERE t.thread_id = ?1 AND u.shared = 1 ORDER BY t.first_seen_ms",
        )?;
        stmt.query_map([thread_id], |r| {
            Ok(SharedUse {
                unit: Self::unit_from_row(r)?,
                threads: usize::try_from(r.get::<_, i64>(8)?).unwrap_or(0),
                first_seen_ms: r.get(9)?,
                last_seen_ms: r.get(10)?,
            })
        })?
        .collect()
    }

    pub fn units_for_thread(&self, thread_id: &str) -> rusqlite::Result<Vec<Unit>> {
        let sql = format!(
            "SELECT {} FROM units WHERE thread_id = ?1 ORDER BY first_seen_ms",
            Self::UNIT_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        stmt.query_map([thread_id], Self::unit_from_row)?.collect()
    }

    /// Units of `kind` whose lifetime overlaps `[from, to]`.
    pub fn units_overlapping(&self, kind: UnitKind, from: i64, to: i64) -> rusqlite::Result<Vec<Unit>> {
        let sql = format!(
            "SELECT {} FROM units WHERE kind = ?1 AND first_seen_ms <= ?3 AND last_seen_ms >= ?2 ORDER BY first_seen_ms",
            Self::UNIT_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        stmt.query_map(params![kind.as_str(), from, to], Self::unit_from_row)?
            .collect()
    }

    /// Threads with recorded scopes, most recent first: scopes they own, and shared scopes their commands were seen
    /// in, such as Codex's app-server. Only owned scopes count toward a thread's totals.
    pub fn recent_threads(&self, limit: usize) -> rusqlite::Result<Vec<RecentThread>> {
        let mut stmt = self.conn.prepare(
            "SELECT thread_id, max(t3_home), min(first_seen_ms), max(last_seen_ms) FROM (
               SELECT thread_id, t3_home, first_seen_ms, last_seen_ms FROM units WHERE thread_id IS NOT NULL
               UNION ALL
               SELECT t.thread_id, u.t3_home, t.first_seen_ms, t.last_seen_ms
               FROM unit_threads t JOIN units u ON u.unit_id = t.unit_id WHERE u.shared = 1
             ) GROUP BY thread_id ORDER BY max(last_seen_ms) DESC LIMIT ?1",
        )?;
        stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok(RecentThread {
                thread_id: r.get(0)?,
                t3_home: r.get(1)?,
                first_seen_ms: r.get(2)?,
                last_seen_ms: r.get(3)?,
            })
        })?
        .collect()
    }

    /// Samples and rollups for a unit in `[from, to]`, oldest first. A rollup reads as a point at its first sample,
    /// with the counter read there, and one at its last sample when that is later.
    pub fn points(&self, unit_id: i64, from: i64, to: i64) -> rusqlite::Result<Vec<Point>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT first_ts_ms, cpu_usec_first, mem_peak, resident_avg, resident_max, mem_current_max, pids_max,
                    vram_avg, vram_max, gpu_util_avg, gpu_power_mw_avg
             FROM samples_1m WHERE unit_id = ?1 AND first_ts_ms BETWEEN ?2 AND ?3
             UNION ALL
             SELECT last_ts_ms, cpu_usec, mem_peak, resident_avg, resident_max, mem_current_max, pids_max, vram_avg,
                    vram_max, gpu_util_avg, gpu_power_mw_avg
             FROM samples_1m WHERE unit_id = ?1 AND last_ts_ms > first_ts_ms AND last_ts_ms BETWEEN ?2 AND ?3
             UNION ALL
             SELECT ts_ms, cpu_usec, mem_peak, mem_current - coalesce(mem_file, 0), mem_current - coalesce(mem_file, 0),
                    mem_current, pids, vram, vram, gpu_util, gpu_power_mw
             FROM samples WHERE unit_id = ?1 AND ts_ms BETWEEN ?2 AND ?3
             ORDER BY 1",
        )?;
        stmt.query_map(params![unit_id, from, to], |r| {
            Ok(Point {
                ts_ms: r.get(0)?,
                cpu_usec: to_u64(r.get(1)?),
                mem_peak: to_u64(r.get(2)?),
                resident_avg: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0).max(0.0),
                resident_max: to_u64(r.get(4)?).unwrap_or(0),
                mem_current_max: to_u64(r.get(5)?).unwrap_or(0),
                pids_max: to_u64(r.get(6)?).unwrap_or(0),
                vram_avg: r.get(7)?,
                vram_max: to_u64(r.get(8)?),
                gpu_util_avg: r.get(9)?,
                gpu_power_mw_avg: r.get(10)?,
            })
        })?
        .collect()
    }

    /// The nearest cumulative CPU reading for a unit at or before `ts` (`after` false), or at or after it (`after`
    /// true), as `(ts_ms, cpu_usec)`. Rollups count as readings at their first and last sample.
    pub fn cpu_near(&self, unit_id: i64, ts: i64, after: bool) -> rusqlite::Result<Option<(i64, u64)>> {
        let (raw, rolled) = if after {
            (
                "SELECT ts_ms, cpu_usec FROM samples WHERE unit_id = ?1 AND ts_ms >= ?2 AND cpu_usec IS NOT NULL
                 ORDER BY ts_ms LIMIT 1",
                "SELECT CASE WHEN first_ts_ms >= ?2 THEN first_ts_ms ELSE last_ts_ms END,
                        CASE WHEN first_ts_ms >= ?2 THEN cpu_usec_first ELSE cpu_usec END
                 FROM samples_1m WHERE unit_id = ?1 AND ts_ms >= ?2 - 59999 AND last_ts_ms >= ?2
                   AND cpu_usec IS NOT NULL ORDER BY ts_ms LIMIT 1",
            )
        } else {
            (
                "SELECT ts_ms, cpu_usec FROM samples WHERE unit_id = ?1 AND ts_ms <= ?2 AND cpu_usec IS NOT NULL
                 ORDER BY ts_ms DESC LIMIT 1",
                "SELECT CASE WHEN last_ts_ms <= ?2 THEN last_ts_ms ELSE first_ts_ms END,
                        CASE WHEN last_ts_ms <= ?2 THEN cpu_usec ELSE cpu_usec_first END
                 FROM samples_1m WHERE unit_id = ?1 AND ts_ms <= ?2 AND first_ts_ms <= ?2
                   AND cpu_usec IS NOT NULL ORDER BY ts_ms DESC LIMIT 1",
            )
        };
        let mut found = Vec::new();
        for sql in [raw, rolled] {
            let row: Option<(i64, i64)> = self
                .conn
                .prepare_cached(sql)?
                .query_row(params![unit_id, ts], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            found.extend(row.map(|(t, cpu)| (t, u64::try_from(cpu).unwrap_or(0))));
        }
        Ok(if after {
            found.into_iter().min_by_key(|(t, _)| *t)
        } else {
            found.into_iter().max_by_key(|(t, _)| *t)
        })
    }

    pub fn ticks(&self, from: i64, to: i64) -> rusqlite::Result<Vec<TickRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT ts_ms, interval_ms, lag_ms, duration_us, self_cpu_usec, self_rss, self_write_bytes, db_bytes, units
             FROM ticks WHERE ts_ms BETWEEN ?1 AND ?2 ORDER BY ts_ms",
        )?;
        stmt.query_map(params![from, to], |r| {
            Ok(TickRow {
                ts_ms: r.get(0)?,
                interval_ms: r.get(1)?,
                lag_ms: r.get(2)?,
                duration_us: r.get(3)?,
                self_cpu_usec: to_u64(r.get(4)?).unwrap_or(0),
                self_rss: to_u64(r.get(5)?).unwrap_or(0),
                self_write_bytes: to_u64(r.get(6)?),
                db_bytes: to_u64(r.get(7)?).unwrap_or(0),
                units: usize::try_from(r.get::<_, i64>(8)?).unwrap_or(0),
            })
        })?
        .collect()
    }

    /// The sampling interval in effect at `ts`: that of the last tick at or before it. `None` once tick rows are gone,
    /// as for rolled-up history.
    pub fn interval_at(&self, ts: i64) -> rusqlite::Result<Option<i64>> {
        self.conn
            .prepare_cached("SELECT interval_ms FROM ticks WHERE ts_ms <= ?1 ORDER BY ts_ms DESC LIMIT 1")?
            .query_row([ts], |r| r.get(0))
            .optional()
    }

    pub fn last_tick(&self) -> rusqlite::Result<Option<TickRow>> {
        let ts: Option<i64> = self.conn.query_row("SELECT max(ts_ms) FROM ticks", [], |r| r.get(0))?;
        match ts {
            Some(ts) => Ok(self.ticks(ts, ts)?.into_iter().next()),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(cpu: u64, mem: u64) -> SampleRow {
        SampleRow {
            cpu_usec: Some(cpu),
            mem_current: Some(mem),
            mem_peak: Some(mem),
            mem_file: Some(mem / 4),
            ..SampleRow::default()
        }
    }

    #[test]
    fn rolls_old_samples_into_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("s.sqlite")).unwrap();
        let unit = store
            .ensure_unit(
                "boot",
                7,
                UnitKind::Agent,
                "/a.scope",
                "a.scope",
                Some("claude"),
                None,
                0,
            )
            .unwrap();
        assert_eq!(
            store
                .ensure_unit("boot", 7, UnitKind::Agent, "/a.scope", "a.scope", None, None, 5)
                .unwrap(),
            unit
        );
        for (i, ts) in [0_i64, 2_000, 4_000, 60_000].into_iter().enumerate() {
            let n = i as u64 + 1;
            store.insert_sample(unit, ts, &sample(n * 1000, n * 400)).unwrap();
        }
        let now = FULL_RESOLUTION_MS + 60_000;
        store.roll_up(now).unwrap();
        let points = store.points(unit, 0, now).unwrap();
        assert_eq!(
            points.len(),
            3,
            "first minute folded to its ends, second kept: {points:?}"
        );
        assert_eq!((points[0].ts_ms, points[0].cpu_usec), (0, Some(1000)));
        assert_eq!((points[1].ts_ms, points[1].cpu_usec), (4_000, Some(3000)));
        assert_eq!(points[1].resident_max, 900);
        assert_eq!(points[1].vram_avg, None, "no GPU readings stay unread, not zero");
        assert_eq!(points[2].ts_ms, 60_000);
        assert_eq!(store.cpu_near(unit, 3_000, false).unwrap(), Some((0, 1000)));
        assert_eq!(store.cpu_near(unit, 3_000, true).unwrap(), Some((4_000, 3000)));
        assert_eq!(store.cpu_near(unit, 5_000, true).unwrap(), Some((60_000, 4000)));
        assert_eq!(store.cpu_near(unit, -1, false).unwrap(), None);
    }
}
