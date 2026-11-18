//! 进程内调度所有权。持久租约负责不同引擎之间的所有权。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

#[derive(Default)]
pub(super) struct Drivers(Mutex<HashMap<String, Arc<ActiveDriver>>>);

impl Drivers {
    pub(super) fn claim(self: &Arc<Self>, run_id: &str) -> Result<DriverGuard, Arc<ActiveDriver>> {
        let mut drivers = self.0.lock().expect("调度表可用");
        if let Some(active) = drivers.get(run_id) {
            return Err(active.clone());
        }
        let active = Arc::new(ActiveDriver {
            cancel_requested: watch::Sender::new(false),
            finished: watch::Sender::new(false),
        });
        drivers.insert(run_id.to_string(), active.clone());
        Ok(DriverGuard {
            drivers: self.clone(),
            run_id: run_id.to_string(),
            active,
        })
    }
}

pub(super) struct ActiveDriver {
    cancel_requested: watch::Sender<bool>,
    finished: watch::Sender<bool>,
}

impl ActiveDriver {
    pub(super) fn cancel_requested(&self) -> bool {
        *self.cancel_requested.borrow()
    }

    pub(super) fn cancel_signal(&self) -> watch::Receiver<bool> {
        self.cancel_requested.subscribe()
    }

    pub(super) async fn request_cancel_and_wait(&self) {
        self.cancel_requested.send_replace(true);
        let mut finished = self.finished.subscribe();
        // 持有 self 时发送者不会关闭，晚到的等待者也能读到完成标记。
        finished.wait_for(|finished| *finished).await.expect("调度完成信号可用");
    }
}

pub(super) struct DriverGuard {
    drivers: Arc<Drivers>,
    run_id: String,
    pub(super) active: Arc<ActiveDriver>,
}

impl Drop for DriverGuard {
    fn drop(&mut self) {
        self.drivers.0.lock().expect("调度表可用").remove(&self.run_id);
        self.active.finished.send_replace(true);
    }
}
