// Engine CLI discovery.
//
// The workbench drives two external engines. Where they may come from depends
// on the build being run:
//
//   Debug (developer build)
//     PTPN_BIN / ELF2TDG_BIN override -> sidecar next to the app -> repository
//     build directories (cmake-build-*, build/ptpn, build/cargo/release) ->
//     PATH. This keeps `just dev` and isolated engine development working.
//
//   Release (installer / portable package)
//     explicit env override (flagged as external) -> sidecar next to the app
//     (`ptpn.exe`, `elf2tdg.exe` or `bin/…`) -> error. Release builds never scan
//     the working directory or PATH, so a random CLI lying around cannot be
//     picked up instead of the bundled one.

use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Debug,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineSource {
    /// Explicit `PTPN_BIN` / `ELF2TDG_BIN` override.
    Env,
    /// Sidecar shipped next to the application binary.
    Sidecar,
    /// Repository build tree (debug builds only).
    DevBuild,
    /// Found on `PATH` (debug builds only).
    Path,
}

impl EngineSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Sidecar => "sidecar",
            Self::DevBuild => "dev-build",
            Self::Path => "path",
        }
    }
}

#[derive(Clone, Debug)]
pub struct EngineBinary {
    pub path: PathBuf,
    pub source: EngineSource,
    /// Release build running an explicitly overridden CLI instead of the bundle.
    pub external_override: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EngineInfo {
    pub path: String,
    pub source: String,
    pub external_override: bool,
}

impl EngineBinary {
    pub fn info(&self) -> EngineInfo {
        EngineInfo {
            path: self.path.display().to_string(),
            source: self.source.as_str().to_string(),
            external_override: self.external_override,
        }
    }
}

pub fn current_mode() -> Mode {
    if cfg!(debug_assertions) {
        Mode::Debug
    } else {
        Mode::Release
    }
}

fn exe_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

/// `name` without extension, or already carrying the platform suffix.
fn binary_name(name: &str) -> String {
    let suffix = exe_suffix();
    if name.ends_with(suffix) && !suffix.is_empty() {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    }
}

struct Spec {
    env_var: &'static str,
    /// Repository-relative binaries used by debug builds only, without suffix.
    dev_binaries: &'static [&'static str],
}

fn spec(engine: &str) -> Option<Spec> {
    match engine {
        "ptpn" => Some(Spec {
            env_var: "PTPN_BIN",
            dev_binaries: &[
                "cmake-build-debug-mingw/ptpn",
                "cmake-build-release-mingw/ptpn",
                "cmake-build-desktop-mingw/ptpn",
                "build/ptpn/ptpn",
                "build/ptpn",
                "engines/prioritized-tpn/build/ptpn",
            ],
        }),
        "elf2tdg" => Some(Spec {
            env_var: "ELF2TDG_BIN",
            dev_binaries: &[
                "build/cargo/release/elf2tdg",
                "target/release/elf2tdg",
                "engines/elf2tdg/target/release/elf2tdg",
            ],
        }),
        _ => None,
    }
}

fn file(path: &Path) -> Option<PathBuf> {
    path.is_file().then(|| path.to_path_buf())
}

fn on_path(name: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
    let suffix = exe_suffix();
    let file_name = binary_name(name);
    let paths = path_var?;
    for directory in env::split_paths(paths) {
        if let Some(found) = file(&directory.join(&file_name)) {
            return Some(found);
        }
        // Accept the bare name as well; useful for wrapper scripts.
        if suffix.is_empty() || suffix != ".exe" {
            if let Some(found) = file(&directory.join(name)) {
                return Some(found);
            }
        }
    }
    None
}

fn sidecar_in(directory: &Path, name: &str) -> Option<PathBuf> {
    let file_name = binary_name(name);
    file(&directory.join(&file_name)).or_else(|| file(&directory.join("bin").join(&file_name)))
}

fn dev_binary_in(bases: &[PathBuf], name: &str) -> Option<PathBuf> {
    let Some(spec) = spec(name) else {
        return None;
    };
    let file_name = binary_name(name);
    for base in bases {
        for relative in spec.dev_binaries {
            let directory = relative.rsplit_once('/').map(|(directory, _)| directory);
            let candidate = match directory {
                Some(directory) => base.join(directory).join(&file_name),
                None => base.join(&file_name),
            };
            if let Some(found) = file(&candidate) {
                return Some(found);
            }
        }
    }
    None
}

/// Locate an engine CLI following the mode-specific policy above.
pub fn locate(engine: &str, mode: Mode) -> Option<EngineBinary> {
    let spec = spec(engine)?;
    let env_override = env::var_os(spec.env_var).map(PathBuf::from);
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let cwd = env::current_dir().ok();
    let path_var = env::var_os("PATH");
    locate_with(
        engine,
        mode,
        env_override.as_deref(),
        exe_dir.as_deref(),
        cwd.as_deref(),
        path_var.as_deref(),
    )
}

#[allow(clippy::too_many_arguments)]
fn locate_with(
    engine: &str,
    mode: Mode,
    env_override: Option<&Path>,
    exe_dir: Option<&Path>,
    cwd: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Option<EngineBinary> {
    let _ = spec(engine)?;

    if let Some(override_path) = env_override.map(|path| path.to_path_buf()) {
        if override_path.is_file() {
            return Some(EngineBinary {
                path: override_path,
                source: EngineSource::Env,
                external_override: mode == Mode::Release,
            });
        }
    }

    if let Some(directory) = exe_dir {
        if let Some(found) = sidecar_in(directory, engine) {
            return Some(EngineBinary {
                path: found,
                source: EngineSource::Sidecar,
                external_override: false,
            });
        }
    }

    if mode == Mode::Debug {
        let mut bases: Vec<PathBuf> = Vec::new();
        if let Some(directory) = exe_dir {
            bases.extend(directory.ancestors().take(7).map(Path::to_path_buf));
        }
        if let Some(cwd) = cwd {
            bases.extend(cwd.ancestors().take(7).map(Path::to_path_buf));
        }
        if let Some(found) = dev_binary_in(&bases, engine) {
            return Some(EngineBinary {
                path: found,
                source: EngineSource::DevBuild,
                external_override: false,
            });
        }
        if let Some(found) = on_path(engine, path_var) {
            return Some(EngineBinary {
                path: found,
                source: EngineSource::Path,
                external_override: false,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("build")
                .join(format!("engine-locate-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("fixture root");
            Self { root }
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("fixture dir");
            fs::write(&path, b"").expect("fixture file");
            path
        }

        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(&path).expect("fixture dir");
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn name(engine: &str) -> String {
        binary_name(engine)
    }

    #[test]
    fn release_prefers_the_bundled_sidecar_and_ignores_the_working_directory() {
        let fixture = Fixture::new("release");
        let app_dir = fixture.dir("app");
        let cwd = fixture.dir("cwd");
        fixture.file(&format!("app/{}", name("elf2tdg")));
        fixture.file(&format!("cwd/{}", name("elf2tdg")));
        fixture.file(&format!("cwd/build/cargo/release/{}", name("elf2tdg")));

        let found = locate_with(
            "elf2tdg",
            Mode::Release,
            None,
            Some(&app_dir),
            Some(&cwd),
            None,
        )
        .expect("sidecar must be found");
        assert_eq!(found.source, EngineSource::Sidecar);
        assert!(found.path.starts_with(&app_dir));
    }

    #[test]
    fn release_accepts_the_bin_sidecar_layout() {
        let fixture = Fixture::new("release-bin");
        let app_dir = fixture.dir("app");
        fixture.file(&format!("app/bin/{}", name("ptpn")));
        let found = locate_with("ptpn", Mode::Release, None, Some(&app_dir), None, None)
            .expect("bin/ sidecar must be found");
        assert_eq!(found.source, EngineSource::Sidecar);
    }

    #[test]
    fn release_without_sidecar_does_not_fall_back_to_dev_trees_or_path() {
        let fixture = Fixture::new("release-none");
        let app_dir = fixture.dir("app");
        let cwd = fixture.dir("cwd");
        fixture.file(&format!("cwd/build/cargo/release/{}", name("elf2tdg")));
        let fake_path = fixture.dir("fake-path");
        fixture.file(&format!("fake-path/{}", name("elf2tdg")));

        let found = locate_with(
            "elf2tdg",
            Mode::Release,
            None,
            Some(&app_dir),
            Some(&cwd),
            Some(fake_path.as_os_str()),
        );
        assert!(found.is_none(), "release must not scan dev trees or PATH");
    }

    #[test]
    fn debug_falls_back_to_the_repository_build_tree() {
        let fixture = Fixture::new("debug");
        let app_dir = fixture.dir("app");
        let cwd = fixture.dir("cwd");
        fixture.file(&format!("cwd/build/cargo/release/{}", name("elf2tdg")));

        let found = locate_with(
            "elf2tdg",
            Mode::Debug,
            None,
            Some(&app_dir),
            Some(&cwd),
            None,
        )
        .expect("dev build tree must be found");
        assert_eq!(found.source, EngineSource::DevBuild);
    }

    #[test]
    fn explicit_override_wins_and_is_flagged_only_in_release() {
        let fixture = Fixture::new("override");
        let override_path = fixture.file(&format!("custom/{}", name("ptpn")));
        let app_dir = fixture.dir("app");

        let debug = locate_with(
            "ptpn",
            Mode::Debug,
            Some(&override_path),
            Some(&app_dir),
            None,
            None,
        )
        .expect("debug override");
        assert_eq!(debug.source, EngineSource::Env);
        assert!(!debug.external_override);

        let release = locate_with(
            "ptpn",
            Mode::Release,
            Some(&override_path),
            Some(&app_dir),
            None,
            None,
        )
        .expect("release override");
        assert_eq!(release.source, EngineSource::Env);
        assert!(release.external_override);
    }
}
