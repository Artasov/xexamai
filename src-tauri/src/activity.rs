use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use uuid::Uuid;

/// Coordinates long-running application work with update installation.
///
/// Normal operations take a shared permit. Installation takes the exclusive
/// permit and fails immediately if work is still active, so there is no race
/// between a last-moment recording/request and launching the installer.
#[derive(Default)]
pub(crate) struct ActivityGate {
    inner: Arc<RwLock<()>>,
}

impl ActivityGate {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn try_begin_work(&self) -> Result<WorkPermit, String> {
        self.inner
            .clone()
            .try_read_owned()
            .map(|guard| WorkPermit { _guard: guard })
            .map_err(|_| "An application update is being installed".to_string())
    }

    pub(crate) fn try_begin_install(&self) -> Result<InstallPermit, String> {
        self.inner
            .clone()
            .try_write_owned()
            .map(|guard| InstallPermit { _guard: guard })
            .map_err(|_| {
                "Finish or cancel the active recording, transcription, or AI request before installing the update"
                    .to_string()
            })
    }
}

pub(crate) struct WorkPermit {
    _guard: OwnedRwLockReadGuard<()>,
}

pub(crate) struct InstallPermit {
    _guard: OwnedRwLockWriteGuard<()>,
}

/// Keeps shared activity permits for work performed directly by the webview
/// (authenticated backend requests and vendor WebSockets). Without these
/// leases an installer could win the gap between the renderer's last busy
/// check and a newly-created request.
pub(crate) struct RendererActivityLeases {
    gate: Arc<ActivityGate>,
    state: Mutex<RendererActivityState>,
}

#[derive(Default)]
struct RendererActivityState {
    session: Option<RendererSession>,
    leases: HashMap<Uuid, RendererActivityLease>,
}

#[derive(Clone, Copy)]
struct RendererSession {
    id: Uuid,
    generation: u64,
}

struct RendererActivityLease {
    #[allow(dead_code)]
    label: String,
    _permit: WorkPermit,
}

impl RendererActivityLeases {
    const MAX_ACTIVE_LEASES: usize = 64;
    const MAX_LABEL_BYTES: usize = 96;

    pub(crate) fn new(gate: Arc<ActivityGate>) -> Self {
        Self {
            gate,
            state: Mutex::new(RendererActivityState::default()),
        }
    }

    /// Registers the current webview document. A newer document atomically
    /// drops leases abandoned by a DevTools/page reload so they cannot block
    /// update installation until the whole process is restarted.
    pub(crate) async fn register_session(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        let id = parse_session_id(session_id)?;
        if generation == 0 {
            return Err("Invalid renderer activity generation".to_string());
        }
        let mut state = self.state.lock().await;
        match state.session {
            Some(current) if current.id == id && current.generation == generation => return Ok(()),
            Some(current) if generation <= current.generation => {
                return Err("Stale renderer activity session".to_string());
            }
            _ => {}
        }
        state.leases.clear();
        state.session = Some(RendererSession { id, generation });
        Ok(())
    }

    pub(crate) async fn begin(&self, session_id: &str, label: String) -> Result<String, String> {
        let label = label.trim();
        if label.is_empty() || label.len() > Self::MAX_LABEL_BYTES {
            return Err("Invalid renderer activity label".to_string());
        }

        let session_id = parse_session_id(session_id)?;

        // Acquire the native shared permit before publishing the lease. If an
        // installation already owns the exclusive permit, new work fails.
        let permit = self.gate.try_begin_work()?;
        let mut state = self.state.lock().await;
        if state.session.map(|session| session.id) != Some(session_id) {
            return Err("Renderer activity session is not registered".to_string());
        }
        if state.leases.len() >= Self::MAX_ACTIVE_LEASES {
            return Err("Too many renderer activities are active".to_string());
        }
        let id = Uuid::new_v4();
        state.leases.insert(
            id,
            RendererActivityLease {
                label: label.to_string(),
                _permit: permit,
            },
        );
        Ok(id.to_string())
    }

    pub(crate) async fn end(&self, session_id: &str, lease_id: &str) -> Result<(), String> {
        let session_id = parse_session_id(session_id)?;
        let id =
            Uuid::parse_str(lease_id).map_err(|_| "Invalid renderer activity lease".to_string())?;
        // Ending a lease is idempotent so finally/teardown paths can safely race.
        let mut state = self.state.lock().await;
        if state.session.map(|session| session.id) == Some(session_id) {
            state.leases.remove(&id);
        }
        Ok(())
    }
}

fn parse_session_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "Invalid renderer activity session".to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use uuid::Uuid;

    use super::{ActivityGate, RendererActivityLeases};

    #[tokio::test]
    async fn install_and_work_are_mutually_exclusive() {
        let gate = ActivityGate::new();
        let work = gate.try_begin_work().expect("work permit");
        assert!(gate.try_begin_install().is_err());
        drop(work);

        let install = gate.try_begin_install().expect("install permit");
        assert!(gate.try_begin_work().is_err());
        drop(install);
        assert!(gate.try_begin_work().is_ok());
    }

    #[tokio::test]
    async fn renderer_lease_holds_native_work_permit_until_release() {
        let gate = Arc::new(ActivityGate::new());
        let leases = RendererActivityLeases::new(gate.clone());
        let session = Uuid::new_v4().to_string();
        leases.register_session(&session, 1).await.unwrap();
        let id = leases
            .begin(&session, "Backend request".to_string())
            .await
            .unwrap();
        assert!(gate.try_begin_install().is_err());
        leases.end(&session, &id).await.unwrap();
        assert!(gate.try_begin_install().is_ok());
    }

    #[tokio::test]
    async fn newer_renderer_session_releases_abandoned_leases() {
        let gate = Arc::new(ActivityGate::new());
        let leases = RendererActivityLeases::new(gate.clone());
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        leases.register_session(&first, 10).await.unwrap();
        leases.begin(&first, "Upload".to_string()).await.unwrap();
        assert!(gate.try_begin_install().is_err());

        leases.register_session(&second, 11).await.unwrap();
        assert!(gate.try_begin_install().is_ok());
        assert!(leases.register_session(&first, 10).await.is_err());
    }
}
