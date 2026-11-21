//! End to end over a fake cgroup tree, procfs, and T3 database: the sampler finds scopes, maps them to threads, and
//! the report attributes delegated threads exactly and native subagents by overlap.

use crate::host::Roots;
use crate::report::{self, NodeKind, Window};
use crate::sampler::{Options, Sampler, now_ms};
use crate::store::Store;
use crate::t3::T3;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

struct Fake {
    _dir: tempfile::TempDir,
    roots: Roots,
    db: PathBuf,
    t3_home: PathBuf,
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn scope_files(dir: &Path, cpu_usec: u64, mem: u64, pid: u32) {
    write(
        &dir.join("cpu.stat"),
        &format!("usage_usec {cpu_usec}\nuser_usec 0\nsystem_usec 0\n"),
    );
    write(&dir.join("memory.current"), &format!("{mem}\n"));
    write(&dir.join("memory.peak"), &format!("{}\n", mem * 2));
    write(
        &dir.join("memory.stat"),
        &format!("anon {}\nfile {}\n", mem / 2, mem / 4),
    );
    write(&dir.join("pids.current"), "3\n");
    write(&dir.join("cgroup.procs"), &format!("{pid}\n"));
    write(&dir.join("cgroup.events"), "populated 1\nfrozen 0\n");
}

/// A fake process: its parent and environment.
fn process(proc: &Path, pid: u32, ppid: u32, environ: &str) {
    // Field 22 is the start time; fake processes start at their pid.
    write(
        &proc.join(format!("{pid}/stat")),
        &format!("{pid} (agent) S {ppid} {pid} {pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {pid} 1000 50"),
    );
    write(&proc.join(format!("{pid}/environ")), environ);
}

fn machine_files(proc: &Path, busy_ticks: u64) {
    write(
        &proc.join("stat"),
        &format!("cpu  {busy_ticks} 0 0 100000 0 0 0 0 0 0\n"),
    );
    write(
        &proc.join("meminfo"),
        "MemTotal:       16000000 kB\nMemFree:  1000000 kB\nMemAvailable:   12000000 kB\nCached: 2000000 kB\n",
    );
}

fn fake() -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let cgroup = dir.path().join("cgroup");
    let proc = dir.path().join("proc");
    let t3_home = dir.path().join("t3");
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let agents = cgroup.join(format!(
        "user.slice/user-{uid}.slice/user@{uid}.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-abc.slice"
    ));
    scope_files(&agents.join("t3code-claude-0000000a.scope"), 0, 100 << 20, 100);
    scope_files(&agents.join("t3code-claude-0000000b.scope"), 0, 50 << 20, 200);
    let t3_text = t3_home.to_string_lossy();
    process(
        &proc,
        100,
        1,
        &format!("HOME=/h\0T3CODE_THREAD_ID=root-thread\0T3CODE_HOME={t3_text}\0"),
    );
    process(&proc, 200, 1, "T3CODE_THREAD_ID=child-thread\0");
    write(&proc.join("sys/kernel/random/boot_id"), "boot-1\n");
    write(&proc.join("self/cgroup"), "0::/user.slice/terminal.scope\n");
    machine_files(&proc, 0);
    let db = dir.path().join("samples.sqlite");
    Fake {
        _dir: dir,
        roots: Roots { cgroup, proc },
        db,
        t3_home,
    }
}

fn agents_dir(roots: &Roots) -> PathBuf {
    let uid = unsafe { libc::getuid() };
    roots.cgroup.join(format!(
        "user.slice/user-{uid}.slice/user@{uid}.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-abc.slice"
    ))
}

fn seed_t3(home: &Path, native_from: &str, native_to: &str) {
    let path = crate::t3::state_db(home);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, default_provider TEXT, provider_instance_id TEXT);
         INSERT INTO orchestration_v2_projection_threads VALUES ('root-thread', 'Root task', 'claude', 'claude-rs');
         INSERT INTO orchestration_v2_projection_threads VALUES ('child-thread', 'Delegated review', 'codex', 'codex');
         CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, parent_node_id TEXT,
           child_thread_id TEXT, origin TEXT, provider TEXT, status TEXT, started_at TEXT, completed_at TEXT,
           payload_json TEXT);
         INSERT INTO orchestration_v2_projection_subagents VALUES ('s1', 'root-thread', 'run', 'child-thread',
           'app_owned', 'codex', 'completed', NULL, NULL, '{{\"title\":\"Delegated review\"}}');
         INSERT INTO orchestration_v2_projection_subagents VALUES ('s0', 'root-thread', 'run', 'thread:subagent:never',
           'provider_native', 'claude-rs', 'cancelled', NULL, NULL, '{{\"title\":\"Never started\"}}');
         INSERT INTO orchestration_v2_projection_subagents VALUES ('s2', 'root-thread', 'run', 'thread:subagent:x',
           'provider_native', 'claude-rs', 'completed', '{native_from}', '{native_to}',
           '{{\"title\":\"Explore\",\"model\":\"claude-haiku-5-5\"}}');
         INSERT INTO orchestration_v2_projection_subagents VALUES ('s3', 'root-thread', 's2', 'thread:subagent:y',
           'provider_native', 'claude-rs', 'completed', '{native_to}', '{native_to}', '{{\"title\":\"Nested\"}}');
         CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, ordinal INTEGER, status TEXT, requested_at TEXT,
           completed_at TEXT, payload_json TEXT);"
    ))
    .unwrap();
}

#[test]
fn samples_and_reports_a_task_tree() {
    let f = fake();
    let sampler_options = Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    };
    let mut sampler = Sampler::new(&sampler_options).unwrap();
    let base = now_ms() + 1_000;
    let agents = agents_dir(&f.roots);
    let root_scope = agents.join("t3code-claude-0000000a.scope");
    let child_scope = agents.join("t3code-claude-0000000b.scope");

    // Three ticks two seconds apart. The root uses 2 s of CPU per interval, the child 1 s.
    for step in 0..3_u64 {
        scope_files(&root_scope, step * 2_000_000, (100 + step * 10) << 20, 100);
        scope_files(&child_scope, step * 1_000_000, 50 << 20, 200);
        machine_files(&f.roots.proc, step * 400); // 4 s of busy time per interval at 100 ticks/s
        sampler.tick(base + step as i64 * 2000, 0).unwrap();
    }
    drop(sampler);

    // The native subagent runs across both intervals' midpoints.
    let iso = |ms: i64| format!("{}.000Z", crate::parse::ms_to_iso_utc(ms).trim_end_matches('Z'));
    seed_t3(&f.t3_home, &iso(base + 500), &iso(base + 5_000));

    let store = Store::open_read_only(&f.db).unwrap();
    let t3 = T3::open(&f.t3_home).unwrap();
    let built = report::report(&store, Some(&t3), "root-thread", Window::ALL).unwrap();

    let root = &built.root;
    assert_eq!(root.title.as_deref(), Some("Root task"));
    let measured = root.measured.as_ref().expect("root measured");
    assert_eq!(measured.cpu_usec, 4_000_000);
    assert_eq!(measured.resident_max, ((120_u64 << 20) * 3) / 4);
    assert_eq!(measured.mem_peak, 240 << 20, "lifetime peak comes from memory.peak");

    let delegated = root.children.iter().find(|c| c.kind == NodeKind::Delegated).unwrap();
    assert_eq!(delegated.title.as_deref(), Some("Delegated review"));
    assert_eq!(delegated.measured.as_ref().unwrap().cpu_usec, 2_000_000);

    let natives: Vec<_> = root.children.iter().filter(|c| c.kind == NodeKind::Native).collect();
    assert_eq!(
        natives.len(),
        1,
        "a native that never started is not shown, and a nested one sits below its parent"
    );
    let native = natives[0];
    assert_eq!(native.children[0].title.as_deref(), Some("Nested"));
    assert_eq!(native.model.as_deref(), Some("claude-haiku-5-5"));
    // Each interval's 2 s splits between the parent and one active subagent.
    assert_eq!(native.estimated_cpu_usec, Some(2_000_000));
    assert_eq!(root.own_cpu_usec_estimate, Some(2_000_000));

    assert_eq!(built.total.cpu_usec, 6_000_000);
    assert_eq!(built.total.scopes, 2);
    let machine = built.machine.as_ref().unwrap();
    assert_eq!(machine.machine_cpu_usec, 8_000_000);
    assert_eq!(machine.all_agents_cpu_usec, 6_000_000);
    assert!((machine.task_share.unwrap() - 0.75).abs() < 1e-9);
    assert_eq!(machine.other_cpu_usec, 2_000_000);

    let overhead = built.sampler.as_ref().unwrap();
    assert_eq!(overhead.ticks, 3);
    assert!(!overhead.from_cgroup, "a foreground run is not the service cgroup");

    let text = report::render_text(&built);
    assert!(text.contains("native Explore"), "{text}");
    assert!(text.contains("delegated Delegated review"), "{text}");
    let page = crate::page::render(&store, &built).unwrap();
    assert!(page.contains("id=\"sr-data\""), "the page carries chart data");
    assert!(page.contains("Delegated review"));
    assert!(page.contains("uPlot"));
}

#[test]
fn marks_vanished_scopes_gone() {
    let f = fake();
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let base = now_ms() + 1_000;
    sampler.tick(base, 0).unwrap();
    fs::remove_dir_all(agents_dir(&f.roots).join("t3code-claude-0000000b.scope")).unwrap();
    sampler.tick(base + 2000, 0).unwrap();
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    let child = store.units_for_thread("child-thread").unwrap();
    assert_eq!(child.len(), 1);
    assert_eq!(child[0].gone_ms, Some(base + 2000));
    assert!(store.units_for_thread("root-thread").unwrap()[0].gone_ms.is_none());
}

#[test]
fn keeps_shared_scopes_out_of_thread_totals() {
    let f = fake();
    // One app-server serves two threads: its own environment names none, and the commands it starts name theirs.
    let shared = agents_dir(&f.roots).join("t3code-codex-0000000c.scope");
    scope_files(&shared, 0, 80 << 20, 300);
    write(&shared.join("cgroup.procs"), "300\n301\n302\n");
    let home = f.t3_home.to_string_lossy();
    process(&f.roots.proc, 300, 1, &format!("T3CODE_HOME={home}\0"));
    process(&f.roots.proc, 301, 300, "T3CODE_THREAD_ID=root-thread\0");
    process(&f.roots.proc, 302, 300, "T3CODE_THREAD_ID=codex-thread\0");
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let base = now_ms() + 1_000;
    for step in 0..2_u64 {
        scope_files(&shared, step * 5_000_000, 80 << 20, 300);
        write(&shared.join("cgroup.procs"), "300\n301\n302\n");
        machine_files(&f.roots.proc, step * 400);
        sampler.tick(base + step as i64 * 2000, 0).unwrap();
    }
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    assert!(store.units_for_thread("codex-thread").unwrap().is_empty());
    let built = report::report(&store, None, "root-thread", Window::ALL).unwrap();
    assert_eq!(
        built.total.cpu_usec, 0,
        "the shared scope's 5 s is not the root thread's"
    );
    let codex = report::report(&store, None, "codex-thread", Window::ALL).unwrap();
    assert!(codex.root.measured.is_none());
    let scope = &codex.root.shared[0];
    assert_eq!(scope.threads, 2);
    assert_eq!(scope.provider.as_deref(), Some("codex"));
    assert!(report::render_text(&codex).contains("shared codex scope serving 2 threads"));
}

#[test]
fn interpolates_turns_between_ticks_and_across_rollups() {
    let f = fake();
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let root_scope = agents_dir(&f.roots).join("t3code-claude-0000000a.scope");
    // Old enough to be rolled up: ticks at 10 s, 12 s, and 14 s past a minute, 1 s of CPU per second.
    let minute = (now_ms() - crate::store::FULL_RESOLUTION_MS - 3_600_000) / 60_000 * 60_000;
    for step in 0..3_i64 {
        scope_files(&root_scope, (10 + step as u64 * 2) * 1_000_000, 100 << 20, 100);
        sampler.tick(minute + 10_000 + step * 2000, 0).unwrap();
    }
    sampler.roll_up(now_ms()).unwrap();
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    let units = store.units_for_thread("root-thread").unwrap();
    // A turn from 11 s to 13 s lies between readings and inside a folded minute.
    let turn = Window {
        from_ms: minute + 11_000,
        to_ms: minute + 13_000,
    };
    let start = store.points(units[0].unit_id, minute, minute + 60_000).unwrap();
    assert_eq!(
        start.first().map(|p| p.ts_ms),
        Some(minute + 10_000),
        "the rollup keeps its first sample's time"
    );
    let report_units = report::usage(&store, &units, turn).unwrap().unwrap();
    assert_eq!(report_units.cpu_usec, 2_000_000);
}

#[test]
fn spreads_cpu_over_the_buckets_an_interval_covers() {
    let f = fake();
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let root_scope = agents_dir(&f.roots).join("t3code-claude-0000000a.scope");
    let base = (now_ms() / 60_000 + 1) * 60_000;
    // One core for 30 s between two readings.
    for (step, cpu) in [(0_i64, 0_u64), (30_000, 30_000_000)] {
        scope_files(&root_scope, cpu, 100 << 20, 100);
        sampler.tick(base + step, 0).unwrap();
    }
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    let units = store.units_for_thread("root-thread").unwrap();
    let buckets = report::series(&store, &units, Window::ALL, 2_000).unwrap();
    let peak = buckets.iter().map(|b| b.cores).fold(0.0, f64::max);
    assert!((peak - 1.0).abs() < 1e-9, "peak {peak}");
}

#[test]
fn keeps_a_shared_scope_shared_after_its_leader_exits() {
    let f = fake();
    let shared = agents_dir(&f.roots).join("t3code-codex-0000000c.scope");
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let base = now_ms() + 1_000;
    scope_files(&shared, 1_000_000, 80 << 20, 300);
    write(&shared.join("cgroup.procs"), "300\n301\n");
    process(&f.roots.proc, 300, 1, "HOME=/h\0");
    process(&f.roots.proc, 301, 300, "T3CODE_THREAD_ID=codex-thread\0");
    sampler.tick(base, 0).unwrap();
    // The app-server exits and the sampler restarts; its command is reparented outside the scope and now looks like a
    // leader. The pin and classification come back from the database.
    drop(sampler);
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    for step in 1..40 {
        scope_files(&shared, 1_000_000, 80 << 20, 301);
        process(&f.roots.proc, 301, 1, "T3CODE_THREAD_ID=codex-thread\0");
        sampler.tick(base + step * 2000, 0).unwrap();
    }
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    assert!(
        store.units_for_thread("codex-thread").unwrap().is_empty(),
        "the command does not own the scope"
    );
    assert_eq!(store.shared_units_for_thread("codex-thread").unwrap().len(), 1);
}

#[test]
fn leaves_turns_inside_sampler_downtime_unmeasured() {
    let f = fake();
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let root_scope = agents_dir(&f.roots).join("t3code-claude-0000000a.scope");
    let base = now_ms() + 1_000;
    // Two readings, five minutes of downtime, two more: 1 s of CPU per second throughout.
    for offset in [0_i64, 2_000, 300_000, 302_000] {
        scope_files(&root_scope, offset.unsigned_abs() * 1000, 100 << 20, 100);
        sampler.tick(base + offset, 0).unwrap();
    }
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    let units = store.units_for_thread("root-thread").unwrap();
    let inside = Window {
        from_ms: base + 100_000,
        to_ms: base + 200_000,
    };
    assert!(report::usage(&store, &units, inside).unwrap().is_none());
    // A turn that starts sampled and ends in the gap counts only up to the last reading, as a lower bound.
    let edge = Window {
        from_ms: base + 1_000,
        to_ms: base + 150_000,
    };
    let usage = report::usage(&store, &units, edge).unwrap().unwrap();
    assert_eq!(usage.cpu_usec, 1_000_000);
    assert!(usage.cpu_partial);
}

#[test]
fn does_not_interpolate_across_a_short_outage() {
    let f = fake();
    let mut sampler = Sampler::new(&Options {
        roots: f.roots.clone(),
        db: f.db.clone(),
        interval_ms: 2000,
        gpu: false,
    })
    .unwrap();
    let root_scope = agents_dir(&f.roots).join("t3code-claude-0000000a.scope");
    let base = now_ms() + 1_000;
    // Ticks every 2 s with an 8 s outage between 2 s and 10 s.
    for offset in [0_i64, 2_000, 10_000, 12_000] {
        scope_files(&root_scope, offset.unsigned_abs() * 1000, 100 << 20, 100);
        sampler.tick(base + offset, 0).unwrap();
    }
    drop(sampler);
    let store = Store::open_read_only(&f.db).unwrap();
    let units = store.units_for_thread("root-thread").unwrap();
    let inside = Window {
        from_ms: base + 3_000,
        to_ms: base + 9_000,
    };
    assert!(report::usage(&store, &units, inside).unwrap().is_none());
}
