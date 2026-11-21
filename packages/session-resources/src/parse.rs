//! Parsers for kernel text interfaces: cgroup v2 files, /proc/stat, /proc/meminfo, PSI, and environ blocks.
//!
//! Every function here is pure, so the sampler's file reads stay thin and the formats are tested without a kernel.

use std::collections::HashMap;

/// `key value` lines, as in `cpu.stat` and `memory.stat`. Lines that do not parse are skipped.
pub fn key_values(text: &str) -> HashMap<&str, u64> {
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(' ')?;
            Some((key, value.trim().parse().ok()?))
        })
        .collect()
}

/// A single integer file such as `memory.current` or `pids.current`. `max` and blank read as `None`.
pub fn single(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

/// Busy clock ticks across all CPUs from the aggregate `cpu` line of /proc/stat: everything except idle and iowait.
/// Guest time is already counted inside user and nice, so it is not added again.
pub fn proc_stat_busy_ticks(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|field| field.parse().ok())
        .collect::<Option<_>>()?;
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    let [user, nice, system, _idle, _iowait, irq, softirq, steal, ..] = fields[..] else {
        return None;
    };
    Some(user + nice + system + irq + softirq + steal)
}

/// Online CPUs: the per-CPU `cpuN` lines of /proc/stat, the same CPUs the aggregate line sums over.
pub fn proc_stat_cpu_count(text: &str) -> usize {
    text.lines()
        .filter(|line| {
            line.strip_prefix("cpu")
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        })
        .count()
}

/// Machine memory from /proc/meminfo, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    pub total: u64,
    pub available: u64,
    pub cached: u64,
}

impl MemInfo {
    /// Memory that cannot be reclaimed without swapping: total minus MemAvailable.
    pub fn used(&self) -> u64 {
        self.total.saturating_sub(self.available)
    }
}

pub fn meminfo(text: &str) -> Option<MemInfo> {
    let mut values = HashMap::new();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(kib) = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        values.insert(key, kib * 1024);
    }
    Some(MemInfo {
        total: *values.get("MemTotal")?,
        available: *values.get("MemAvailable")?,
        cached: values.get("Cached").copied().unwrap_or(0),
    })
}

/// The value of `name` in a NUL-separated environ block.
pub fn environ_var(block: &[u8], name: &str) -> Option<String> {
    block.split(|byte| *byte == 0).find_map(|entry| {
        let rest = entry.strip_prefix(name.as_bytes())?.strip_prefix(b"=")?;
        String::from_utf8(rest.to_vec()).ok()
    })
}

/// The provider name in a T3 agent scope name: `t3code-claude-1049ada4.scope` is `claude`.
pub fn scope_provider(scope: &str) -> Option<&str> {
    let stem = scope.strip_suffix(".scope")?.strip_prefix("t3code-")?;
    let (name, suffix) = stem.rsplit_once('-')?;
    (!name.is_empty() && suffix.len() == 8 && suffix.bytes().all(|b| b.is_ascii_hexdigit())).then_some(name)
}

/// Whether `cgroup.events` reports a populated group.
pub fn populated(events: &str) -> Option<bool> {
    key_values(events).get("populated").map(|value| *value != 0)
}

/// Process ids, one per line, from `cgroup.procs`.
pub fn pids(text: &str) -> Vec<u32> {
    text.lines().filter_map(|line| line.trim().parse().ok()).collect()
}

/// The parent process id and start time (clock ticks after boot) from /proc/<pid>/stat. The command name in field 2
/// may hold spaces and parentheses, so fields are counted from its last closing parenthesis.
pub fn stat_ppid_start(text: &str) -> Option<(u32, u64)> {
    let (_, rest) = text.rsplit_once(')')?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // After the name: state is field 3, ppid field 4, starttime field 22.
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

/// The second field of /proc/<pid>/statm, resident pages.
pub fn statm_resident_pages(text: &str) -> Option<u64> {
    text.split_whitespace().nth(1)?.parse().ok()
}

/// `write_bytes` from /proc/<pid>/io: bytes this process caused to be sent to storage.
pub fn io_write_bytes(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix("write_bytes:"))?
        .trim()
        .parse()
        .ok()
}

/// The unified-hierarchy path from /proc/<pid>/cgroup: the `0::` line.
pub fn proc_cgroup_path(text: &str) -> Option<&str> {
    text.lines().find_map(|line| line.strip_prefix("0::"))
}

/// Milliseconds since the Unix epoch for an RFC 3339 UTC timestamp such as `2026-11-18T15:53:09.265Z`.
pub fn iso_utc_ms(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date_parts = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date_parts.next()??, date_parts.next()??, date_parts.next()??);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock_parts = clock.splitn(3, ':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (clock_parts.next()??, clock_parts.next()??, clock_parts.next()??);
    let millis: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// An RFC 3339 UTC timestamp with second precision for milliseconds since the epoch.
pub fn ms_to_iso_utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    // Inverse of days_from_civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cpu_stat() {
        let text = "usage_usec 1603219\nuser_usec 1421768\nsystem_usec 181451\nnr_periods 0\n";
        assert_eq!(key_values(text).get("usage_usec"), Some(&1_603_219));
    }

    #[test]
    fn reads_proc_stat_busy() {
        let text = "cpu  100 5 50 1000 20 3 2 1 7 0\ncpu0 1 1 1 1 1 1 1 1 0 0\n";
        assert_eq!(proc_stat_busy_ticks(text), Some(100 + 5 + 50 + 3 + 2 + 1));
        assert_eq!(
            proc_stat_cpu_count(&format!("{text}cpu1 1 1 1 1 1 1 1 1 0 0\nctxt 5\n")),
            2
        );
    }

    #[test]
    fn reads_meminfo() {
        let text =
            "MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    600 kB\nCached:          300 kB\n";
        let info = meminfo(text).unwrap();
        assert_eq!(info.used(), 400 * 1024);
        assert_eq!(info.cached, 300 * 1024);
    }

    #[test]
    fn reads_environ() {
        let block = b"HOME=/home/u\0T3CODE_THREAD_ID=abc-123\0T3CODE_THREAD_ID_X=no\0";
        assert_eq!(environ_var(block, "T3CODE_THREAD_ID").as_deref(), Some("abc-123"));
        assert_eq!(environ_var(block, "T3CODE_HOME"), None);
    }

    #[test]
    fn reads_scope_provider() {
        assert_eq!(scope_provider("t3code-claude-1049ada4.scope"), Some("claude"));
        assert_eq!(
            scope_provider("t3code-codex-app-server-0a1b2c3d.scope"),
            Some("codex-app-server")
        );
        assert_eq!(scope_provider("t3code-claude-xyz.scope"), None);
        assert_eq!(scope_provider("app-t3code.slice"), None);
    }

    #[test]
    fn reads_proc_files() {
        assert_eq!(populated("populated 0\nfrozen 0\n"), Some(false));
        assert_eq!(pids("12\n13\n"), vec![12, 13]);
        let stat = "42 (node (x) y) S 7 42 42 0 -1 4194560 1 0 0 0 5 3 0 0 20 0 1 0 98765 1000 50";
        assert_eq!(stat_ppid_start(stat), Some((7, 98765)));
        assert_eq!(stat_ppid_start("42 (short) S 7"), None);
        assert_eq!(statm_resident_pages("100 25 3 1 0 20 0"), Some(25));
        assert_eq!(io_write_bytes("rchar: 1\nwrite_bytes: 4096\n"), Some(4096));
        assert_eq!(
            proc_cgroup_path("0::/user.slice/a.scope\n"),
            Some("/user.slice/a.scope")
        );
    }

    #[test]
    fn round_trips_timestamps() {
        let ms = iso_utc_ms("2026-11-18T15:53:09.265Z").unwrap();
        assert_eq!(ms % 1000, 265);
        assert_eq!(ms_to_iso_utc(ms), "2026-11-18T15:53:09Z");
        assert_eq!(iso_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_utc_ms("2000-03-01T00:00:00.5Z"), Some(951_868_800_500));
        assert_eq!(iso_utc_ms("not a date"), None);
    }
}
