use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

const PROJECTS_LIMIT: usize = 200;

fn app_data_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or_else(|| "cannot determine the application data directory".to_string())?;
    let directory = base.join("RT-PN");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    Ok(directory)
}

fn projects_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("projects");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    Ok(directory)
}

fn database() -> Result<Connection, String> {
    let path = app_data_dir()?.join("workspace.db");
    let connection = Connection::open(&path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("cannot enable WAL: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                dir TEXT NOT NULL,
                elf_path TEXT,
                arch TEXT,
                functions INTEGER,
                profile TEXT,
                options TEXT,
                latest_wcet_root TEXT,
                latest_wcet_cycles REAL,
                run_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_opened INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("cannot create workspace schema: {error}"))?;
    // Migration for workspace databases created before run_count existed.
    let _ = connection.execute(
        "ALTER TABLE projects ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0",
        [],
    );
    Ok(connection)
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn project_id(elf_path: &Path) -> String {
    if let Ok(bytes) = fs::read(elf_path) {
        // Small, dependency-free identity hash. The full project directory lives
        // under the app data dir, so collisions only affect the cached copy.
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        return format!("{hash:016x}");
    }
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in elf_path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn text(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn summary(payload: &Value) -> (String, i64, String, Option<String>, Option<f64>, String) {
    let profile = text(payload, "/analysis/profile/board_profile_id");
    let functions = payload
        .get("functions")
        .and_then(Value::as_u64)
        .unwrap_or(0) as i64;
    let wcet = payload.pointer("/analysis/wcet");
    let root = wcet
        .and_then(|value| value.get("roots"))
        .and_then(Value::as_array)
        .and_then(|roots| roots.first());
    let root_name = root
        .map(|root| {
            root.get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .unwrap_or_default();
    let cycles = root.and_then(|root| root.get("cycles")).and_then(Value::as_f64);
    let model = text(payload, "/analysis/model/id");
    (profile, functions, model, if root_name.is_empty() { None } else { Some(root_name) }, cycles, text(payload, "/image/arch"))
}

pub fn save_project(
    name: &str,
    elf_path: &str,
    options: &Value,
    payload: &Value,
) -> Result<Value, String> {
    let path = Path::new(elf_path);
    let id = project_id(path);
    let directory = projects_dir()?.join(&id);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    fs::write(
        directory.join("latest.json"),
        serde_json::to_vec(payload).map_err(|error| format!("cannot serialize payload: {error}"))?,
    )
    .map_err(|error| format!("cannot write latest.json: {error}"))?;
    let (profile, functions, model, wcet_root, wcet_cycles, arch) = summary(payload);
    let project = json!({
        "schema_version": 1,
        "id": id,
        "name": name,
        "elf_path": elf_path,
        "arch": arch,
        "functions": functions,
        "model": model,
        "profile": profile,
        "options": options,
        "latest_wcet_root": wcet_root,
        "latest_wcet_cycles": wcet_cycles,
        "created_at": now_seconds(),
    });
    fs::write(
        directory.join("project.json"),
        serde_json::to_vec_pretty(&project)
            .map_err(|error| format!("cannot serialize project: {error}"))?,
    )
    .map_err(|error| format!("cannot write project.json: {error}"))?;

    let connection = database()?;
    let now = now_seconds();
    connection
        .execute(
            "INSERT INTO projects (id, name, dir, elf_path, arch, functions, profile, options,
                latest_wcet_root, latest_wcet_cycles, run_count, created_at, last_opened)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)
             ON CONFLICT(id) DO UPDATE SET name=?2, dir=?3, elf_path=?4, arch=?5,
                functions=?6, profile=?7, options=?8, latest_wcet_root=?9,
                latest_wcet_cycles=?10, run_count = projects.run_count + 1, last_opened=?11",
            params![
                id,
                name,
                directory.display().to_string(),
                elf_path,
                arch,
                functions,
                profile,
                options.to_string(),
                wcet_root,
                wcet_cycles,
                now
            ],
        )
        .map_err(|error| format!("cannot save project: {error}"))?;
    Ok(project)
}

pub fn recent(limit: Option<u32>) -> Result<Value, String> {
    let connection = database()?;
    let limit = i64::from(limit.unwrap_or(20).min(PROJECTS_LIMIT as u32));
    let mut statement = connection
        .prepare(
            "SELECT id, name, elf_path, arch, functions, profile, latest_wcet_root,
                    latest_wcet_cycles, run_count, last_opened FROM projects
             ORDER BY last_opened DESC LIMIT ?1",
        )
        .map_err(|error| format!("cannot query projects: {error}"))?;
    let rows = statement
        .query_map([limit], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "elf_path": row.get::<_, Option<String>>(2)?,
                "arch": row.get::<_, Option<String>>(3)?,
                "functions": row.get::<_, Option<i64>>(4)?,
                "profile": row.get::<_, Option<String>>(5)?,
                "latest_wcet_root": row.get::<_, Option<String>>(6)?,
                "latest_wcet_cycles": row.get::<_, Option<f64>>(7)?,
                "run_count": row.get::<_, i64>(8)?,
                "last_opened": row.get::<_, i64>(9)?,
            }))
        })
        .map_err(|error| format!("cannot read projects: {error}"))?;
    let projects = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read project rows: {error}"))?;
    Ok(Value::Array(projects))
}

pub fn open_project(id: &str) -> Result<Value, String> {
    let connection = database()?;
    let mut statement = connection
        .prepare("SELECT dir, elf_path, options FROM projects WHERE id = ?1")
        .map_err(|error| format!("cannot query project: {error}"))?;
    let (directory, elf_path, options) = statement
        .query_row([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("project {id} not found: {error}"))?;
    if let Some(path) = &elf_path {
        if !Path::new(path).is_file() {
            return Err(format!(
                "the project image is missing: {path}\nRe-import the ELF to rebuild this project."
            ));
        }
    }
    let payload = fs::read(directory + "/latest.json")
        .map_err(|error| format!("cannot read cached analysis: {error}"))?;
    let payload: Value =
        serde_json::from_slice(&payload).map_err(|error| format!("invalid cached analysis: {error}"))?;
    connection
        .execute("UPDATE projects SET last_opened = ?1 WHERE id = ?2", params![now_seconds(), id])
        .map_err(|error| format!("cannot update project: {error}"))?;
    Ok(json!({
        "project": {
            "id": id,
            "elf_path": elf_path,
            "options": options.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        },
        "payload": payload,
    }))
}

pub fn delete_project(id: &str) -> Result<(), String> {
    let connection = database()?;
    let directory: String = connection
        .query_row("SELECT dir FROM projects WHERE id = ?1", [id], |row| row.get(0))
        .map_err(|error| format!("project {id} not found: {error}"))?;
    connection
        .execute("DELETE FROM projects WHERE id = ?1", [id])
        .map_err(|error| format!("cannot delete project: {error}"))?;
    let path = Path::new(&directory);
    if path.starts_with(app_data_dir()?) {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}
