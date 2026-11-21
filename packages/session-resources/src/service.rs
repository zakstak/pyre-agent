//! Install and remove the sampler as a systemd user service.
//!
//! The binary is copied to a stable path under the user's data folder, so the unit keeps working when the plugin
//! cache moves to a new version. The unit's limits are the hard stop on the sampler's cost: a low CPU weight and quota,
//! idle IO, a memory ceiling, and a watchdog that restarts it if a tick hangs.

use crate::host::SERVICE_NAME;
use crate::store::home;
use std::path::{Path, PathBuf};
use std::process::Command;

fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(fallback))
}

pub fn installed_binary() -> PathBuf {
    xdg("XDG_DATA_HOME", ".local/share").join("session-resources/bin/session-resources")
}

/// Where `install` records the database the service writes, so `uninstall --purge` removes that one.
fn db_record() -> PathBuf {
    xdg("XDG_DATA_HOME", ".local/share").join("session-resources/db-path")
}

pub fn unit_path() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config")
        .join("systemd/user")
        .join(SERVICE_NAME)
}

/// systemd unit text. `ExecStart` and the database are absolute, resolved at install time from the installing
/// shell's environment, which is also the environment later report commands run in.
pub fn unit_text(binary: &Path, db: &Path, interval_ms: i64) -> String {
    format!(
        "[Unit]
Description=Session resource sampler for T3 agent cgroups
Documentation=https://github.com/zakstak/pyre-agent/tree/main/packages/session-resources

[Service]
Type=notify
ExecStart={binary} run --db {db} --interval-ms {interval_ms}
Restart=on-failure
RestartSec=10
# Restarted if a tick stops reporting for this long.
WatchdogSec=30
# Never compete with real work: lowest CPU weight, a hard 10% cap of one CPU, idle IO, and a memory ceiling.
Nice=19
CPUWeight=idle
CPUQuota=10%
IOSchedulingClass=idle
# File cache (its binary, the NVIDIA library, the database) counts here too; the ceiling leaves room for it.
MemoryHigh=96M
MemoryMax=128M
TasksMax=8
NoNewPrivileges=yes

[Install]
WantedBy=default.target
",
        binary = quote(binary),
        db = quote(db),
    )
}

/// Quote a path for a systemd command line. `%` and `$` are doubled so systemd does not expand specifiers or
/// variables inside it.
fn quote(path: &Path) -> String {
    let text = path.to_string_lossy().replace('%', "%%").replace('$', "$$");
    if text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+@%$".contains(c))
    {
        text
    } else {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .map_err(|e| format!("cannot run systemctl: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("systemctl --user {} failed ({status})", args.join(" ")))
    }
}

pub fn install(db: &Path, interval_ms: i64) -> Result<String, String> {
    // The unit runs from a different working folder, so a relative path would name another file.
    let db = &std::path::absolute(db).map_err(|e| format!("cannot resolve {}: {e}", db.display()))?;
    let source = std::env::current_exe().map_err(|e| e.to_string())?;
    let binary = installed_binary();
    let parent = binary.parent().ok_or("no parent for the binary path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Copy beside the target and rename, so a running service never sees a half-written file.
    let staged = parent.join(".session-resources.new");
    std::fs::copy(&source, &staged).map_err(|e| format!("cannot copy {}: {e}", source.display()))?;
    std::fs::rename(&staged, &binary).map_err(|e| e.to_string())?;
    let unit = unit_path();
    std::fs::create_dir_all(unit.parent().ok_or("no parent for the unit path")?).map_err(|e| e.to_string())?;
    std::fs::write(&unit, unit_text(&binary, db, interval_ms)).map_err(|e| e.to_string())?;
    std::fs::write(db_record(), db.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", SERVICE_NAME])?;
    systemctl(&["restart", SERVICE_NAME])?;
    Ok(format!(
        "Installed {} and {}; the sampler writes to {}.",
        binary.display(),
        unit.display(),
        db.display()
    ))
}

/// Whether the installed binary is byte for byte the running executable, or None when none is installed. After a
/// plugin update the service keeps running the binary the last `install` copied, until `install` runs again.
pub fn installed_is_current() -> Result<Option<bool>, String> {
    let installed = match std::fs::read(installed_binary()) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", installed_binary().display())),
    };
    let own = std::env::current_exe()
        .and_then(std::fs::read)
        .map_err(|e| format!("cannot read this executable: {e}"))?;
    Ok(Some(installed == own))
}

/// Remove a file, treating one that is already gone as removed.
fn remove(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot remove {}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Stop and remove the service. `--purge` deletes `db` when given, else the database `install` recorded, else the
/// default one. The record stays until the purge succeeds, so a retry deletes the same database.
pub fn uninstall(db: Option<&Path>, purge: bool) -> Result<String, String> {
    let record = db_record();
    let db = match db {
        Some(db) => db.to_owned(),
        None => match std::fs::read(&record) {
            Ok(bytes) => PathBuf::from(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => crate::store::default_db_path(),
            Err(e) => return Err(format!("cannot read {}: {e}", record.display())),
        },
    };
    let unit = unit_path();
    if unit.exists() {
        systemctl(&["disable", "--now", SERVICE_NAME])?;
        remove(&unit)?;
        systemctl(&["daemon-reload"])?;
    }
    let binary = installed_binary();
    remove(&binary)?;
    let mut message = format!("Removed {} and {}.", unit.display(), binary.display());
    if purge {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = db.as_os_str().to_owned();
            path.push(suffix);
            remove(Path::new(&path))?;
        }
        remove(&record)?;
        message.push_str(&format!(" Deleted {}.", db.display()));
    } else {
        message.push_str(&format!(" Kept the samples in {}.", db.display()));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_with_spaces() {
        let text = unit_text(Path::new("/opt/s r/bin"), Path::new("/data/s.sqlite"), 2000);
        assert!(text.contains("ExecStart=\"/opt/s r/bin\" run --db /data/s.sqlite --interval-ms 2000"));
        assert!(text.contains("WatchdogSec=30"));
        let text = unit_text(Path::new("/opt/bin"), Path::new("/data/100%/$HOME.sqlite"), 2000);
        assert!(text.contains("--db /data/100%%/$$HOME.sqlite "), "{text}");
    }
}
