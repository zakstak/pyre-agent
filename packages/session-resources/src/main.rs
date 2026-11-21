//! session-resources: passive CPU, memory, and GPU memory accounting for T3 agent sessions.

mod gpu;
mod host;
mod page;
mod parse;
mod report;
mod sampler;
mod service;
mod store;
mod t3;
#[cfg(test)]
mod tests;
mod timeline;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    version,
    about = "Passive CPU, memory, and GPU memory accounting for T3 agent sessions."
)]
struct Cli {
    /// The sampler database. Defaults to $XDG_STATE_HOME/session-resources/samples.sqlite.
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sample until stopped. Normally run by the systemd user service that `install` sets up.
    Run {
        #[arg(long, default_value_t = 2000, value_parser = interval_ms)]
        interval_ms: i64,
        /// Do not load NVML or record GPU memory.
        #[arg(long)]
        no_gpu: bool,
        /// Root of the cgroup v2 hierarchy (for tests).
        #[arg(long, default_value = "/sys/fs/cgroup", hide = true)]
        cgroup_root: PathBuf,
        /// Root of procfs (for tests).
        #[arg(long, default_value = "/proc", hide = true)]
        proc_root: PathBuf,
    },
    /// Cost of a thread, the threads it delegated to, and its native subagents, with the machine baseline and the
    /// sampler's own overhead over the same window.
    Report {
        /// T3 thread id. Defaults to $T3CODE_THREAD_ID, the thread this command runs in.
        thread: Option<String>,
        /// T3 home folder holding userdata/statev2.sqlite. Defaults to the one recorded with the thread.
        #[arg(long)]
        t3_home: Option<PathBuf>,
        #[arg(long)]
        json: bool,
        /// Also write a self-contained HTML page with charts to this path.
        #[arg(long)]
        html: Option<PathBuf>,
    },
    /// Recently measured threads with their totals.
    Threads {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Whether the sampler is running and what it costs. Exits 1 when it is over a limit, 2 when it is not running.
    Status {
        /// Minutes of history to judge overhead over.
        #[arg(long, default_value_t = 5)]
        minutes: i64,
        #[arg(long)]
        json: bool,
    },
    /// Install and start the systemd user service.
    Install {
        #[arg(long, default_value_t = 2000, value_parser = interval_ms)]
        interval_ms: i64,
    },
    /// Stop and remove the systemd user service.
    Uninstall {
        /// Also delete the samples database.
        #[arg(long)]
        purge: bool,
    },
}

/// A sampling interval from 250 ms up to the slowest the sampler backs off to, which stays inside the service's
/// watchdog.
fn interval_ms(text: &str) -> Result<i64, String> {
    let value: i64 = text.parse().map_err(|e| format!("{e}"))?;
    if (250..=sampler::MAX_INTERVAL_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!("must be 250 to {}", sampler::MAX_INTERVAL_MS))
    }
}

fn open_for_reading(db: &std::path::Path) -> Result<store::Store, String> {
    if !db.exists() {
        return Err(format!(
            "no samples at {}; install the sampler with `session-resources install`",
            db.display()
        ));
    }
    store::Store::open_read_only(db).map_err(|e| format!("cannot open {}: {e}", db.display()))
}

fn print_json(value: &impl serde::Serialize) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let explicit_db = cli.db.clone();
    let db = cli.db.unwrap_or_else(store::default_db_path);
    let result = match cli.command {
        Command::Run {
            interval_ms,
            no_gpu,
            cgroup_root,
            proc_root,
        } => sampler::run(&sampler::Options {
            roots: host::Roots {
                cgroup: cgroup_root,
                proc: proc_root,
            },
            db,
            interval_ms,
            gpu: !no_gpu,
        })
        .map(|()| ExitCode::SUCCESS),
        Command::Report {
            thread,
            t3_home,
            json,
            html,
        } => (|| {
            let thread = thread
                .or_else(|| std::env::var("T3CODE_THREAD_ID").ok())
                .ok_or("name a thread id, or run inside a T3 thread")?;
            let store = open_for_reading(&db)?;
            let recorded = store.t3_home_for_thread(&thread).map_err(|e| e.to_string())?;
            let home = t3_home.unwrap_or_else(|| t3::resolve_home(recorded.as_deref()));
            let t3 = t3::T3::open(&home).ok();
            let built = report::report(&store, t3.as_ref(), &thread, report::Window::ALL).map_err(|e| e.to_string())?;
            if let Some(path) = &html {
                let page = page::render(&store, &built)?;
                std::fs::write(path, page).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
                eprintln!("Wrote {}", path.display());
            }
            if json {
                print_json(&built)?;
            } else {
                print!("{}", report::render_text(&built));
            }
            Ok(ExitCode::SUCCESS)
        })(),
        Command::Threads { limit, json } => (|| {
            let store = open_for_reading(&db)?;
            let rows = report::recent(&store, limit).map_err(|e| e.to_string())?;
            if json {
                print_json(&rows)?;
            } else {
                print!("{}", report::render_recent(&rows));
            }
            Ok(ExitCode::SUCCESS)
        })(),
        Command::Status { minutes, json } => (|| {
            // No database means the sampler never ran with it: the not-running result, not an error.
            let mut health = if db.exists() {
                let store = open_for_reading(&db)?;
                report::health(&store, sampler::now_ms(), minutes.max(1) * 60_000).map_err(|e| e.to_string())?
            } else {
                report::Health::never_ran(&db)
            };
            health.installed_current = service::installed_is_current()?;
            if json {
                print_json(&health)?;
            } else {
                print!("{}", report::render_health(&health));
            }
            Ok(if !health.running {
                ExitCode::from(2)
            } else if health.problems.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        })(),
        Command::Install { interval_ms } => service::install(&db, interval_ms).map(|message| {
            println!("{message}");
            ExitCode::SUCCESS
        }),
        Command::Uninstall { purge } => service::uninstall(explicit_db.as_deref(), purge).map(|message| {
            println!("{message}");
            ExitCode::SUCCESS
        }),
    };
    result.unwrap_or_else(|error| {
        eprintln!("session-resources: {error}");
        ExitCode::FAILURE
    })
}
