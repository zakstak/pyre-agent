//! Read-only queries against T3's state database: thread titles, child threads, and native subagent windows.
//!
//! The database is opened read-only and only at report time; the sampler never touches it. The table and column
//! names are T3's internal schema, so every query tolerates a missing table by returning nothing.

use crate::parse::iso_utc_ms;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};

pub struct T3 {
    conn: Connection,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ThreadInfo {
    pub thread_id: String,
    pub title: Option<String>,
    pub provider: Option<String>,
}

/// Whether a child runs in its own provider process, and so its own scope, or inside its parent's process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildOrigin {
    /// Started by T3 (delegate_task, workflows, swarms): a separate thread with its own scope.
    AppOwned,
    /// Started by the provider (Claude Agent, Codex spawn_agent): runs inside the parent's process.
    ProviderNative,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Child {
    pub subagent_id: String,
    /// The node it was started from: the run, or another subagent's `subagent_id` for a nested subagent.
    pub parent_node_id: Option<String>,
    pub origin: ChildOrigin,
    pub child_thread_id: Option<String>,
    pub title: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub status: String,
    pub started_ms: Option<i64>,
    pub completed_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Run {
    pub ordinal: i64,
    pub status: String,
    pub requested_ms: Option<i64>,
    pub completed_ms: Option<i64>,
}

/// The T3 state database for a T3 home folder.
pub fn state_db(home: &Path) -> PathBuf {
    home.join("userdata/statev2.sqlite")
}

/// The T3 home folder: the recorded one, else `T3CODE_HOME`, else `~/.t3`.
pub fn resolve_home(recorded: Option<&str>) -> PathBuf {
    recorded
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("T3CODE_HOME").map(PathBuf::from))
        .unwrap_or_else(|| crate::store::home().join(".t3"))
}

impl T3 {
    pub fn open(home: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            state_db(home),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        Ok(Self { conn })
    }

    pub fn thread(&self, thread_id: &str) -> Option<ThreadInfo> {
        self.conn
            .query_row(
                "SELECT title, coalesce(provider_instance_id, default_provider)
                 FROM orchestration_v2_projection_threads WHERE thread_id = ?1",
                [thread_id],
                |r| {
                    Ok(ThreadInfo {
                        thread_id: thread_id.to_owned(),
                        title: r.get(0)?,
                        provider: r.get(1)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    /// The thread's direct children, in start order.
    pub fn children(&self, thread_id: &str) -> Vec<Child> {
        let query = || -> rusqlite::Result<Vec<Child>> {
            let mut stmt = self.conn.prepare(
                "SELECT origin, child_thread_id, json_extract(payload_json, '$.title'), provider,
                        json_extract(payload_json, '$.model'), status, started_at, completed_at, subagent_id,
                        parent_node_id
                 FROM orchestration_v2_projection_subagents WHERE thread_id = ?1
                 ORDER BY started_at, subagent_id",
            )?;
            stmt.query_map([thread_id], |r| {
                let origin: String = r.get(0)?;
                Ok(Child {
                    subagent_id: r.get(8)?,
                    parent_node_id: r.get(9)?,
                    origin: if origin == "provider_native" {
                        ChildOrigin::ProviderNative
                    } else {
                        ChildOrigin::AppOwned
                    },
                    child_thread_id: r.get(1)?,
                    title: r.get(2)?,
                    provider: r.get(3)?,
                    model: r.get(4)?,
                    status: r.get(5)?,
                    started_ms: r.get::<_, Option<String>>(6)?.as_deref().and_then(iso_utc_ms),
                    completed_ms: r.get::<_, Option<String>>(7)?.as_deref().and_then(iso_utc_ms),
                })
            })?
            .collect()
        };
        query().unwrap_or_default()
    }

    /// The thread's turns, in order. A turn runs from when the user's request was made to its completion, so time the
    /// provider spent preparing before it started counts.
    pub fn runs(&self, thread_id: &str) -> Vec<Run> {
        let query = || -> rusqlite::Result<Vec<Run>> {
            let mut stmt = self.conn.prepare(
                "SELECT ordinal, status, requested_at, completed_at
                 FROM orchestration_v2_projection_runs WHERE thread_id = ?1 ORDER BY ordinal",
            )?;
            stmt.query_map([thread_id], |r| {
                Ok(Run {
                    ordinal: r.get(0)?,
                    status: r.get(1)?,
                    requested_ms: r.get::<_, Option<String>>(2)?.as_deref().and_then(iso_utc_ms),
                    completed_ms: r.get::<_, Option<String>>(3)?.as_deref().and_then(iso_utc_ms),
                })
            })?
            .collect()
        };
        query().unwrap_or_default()
    }
}
