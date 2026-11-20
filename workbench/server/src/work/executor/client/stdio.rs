//! Bounded JSONL transport for rmcp. The SDK handles initialization and typed dispatch.
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ClientRequest, JsonRpcMessage, RequestId, ServerJsonRpcMessage},
    transport::Transport,
};
use serde_json::Value;
use std::{io, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::Mutex,
};

const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const MAX_LINES: u8 = 32;

pub(super) struct Stdio {
    output: BufReader<ChildStdout>,
    input: Arc<Mutex<Option<ChildStdin>>>,
    frame: Vec<u8>,
    remaining: u64,
    lines: u8,
    pending: Option<(RequestId, bool)>,
}

impl Stdio {
    pub(super) fn new(output: ChildStdout, input: ChildStdin) -> Self {
        Self {
            output: BufReader::new(output),
            input: Arc::new(Mutex::new(Some(input))),
            frame: Vec::new(),
            remaining: FRAME_LIMIT as u64,
            lines: MAX_LINES,
            pending: None,
        }
    }
}

impl Transport<RoleClient> for Stdio {
    type Error = io::Error;

    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        if let JsonRpcMessage::Request(request) = &message {
            self.pending = Some((
                request.id.clone(),
                matches!(request.request, ClientRequest::CallToolRequest(_)),
            ));
            self.remaining = FRAME_LIMIT as u64;
            self.lines = MAX_LINES;
        }
        let input = self.input.clone();
        async move {
            let mut frame = Frame(Vec::new());
            serde_json::to_writer(&mut frame, &message)?;
            frame.0.push(b'\n');
            let mut input = input.lock().await;
            input
                .as_mut()
                .ok_or_else(|| io::Error::other("stdio closed"))?
                .write_all(&frame.0)
                .await
        }
    }

    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        let Some((id, expect_tool)) = &self.pending else {
            return std::future::pending().await;
        };
        if self.lines == 0 {
            return None;
        }
        // read_until preserves partial data in `frame` when the SDK select loop cancels this receive.
        let remaining = self.remaining.checked_sub(self.frame.len() as u64)?;
        (&mut self.output)
            .take(remaining)
            .read_until(b'\n', &mut self.frame)
            .await
            .ok()?;
        self.remaining -= self.frame.len() as u64;
        self.lines -= 1;
        let message = decode(&self.frame, *expect_tool);
        self.frame.clear();
        match &message {
            Some(JsonRpcMessage::Response(response)) if &response.id == id => self.pending = None,
            Some(JsonRpcMessage::Error(error)) if error.id.as_ref() == Some(id) => {
                self.pending = None
            }
            Some(JsonRpcMessage::Notification(_)) => {}
            _ => return None,
        }
        message
    }

    async fn close(&mut self) -> io::Result<()> {
        self.input.lock().await.take();
        Ok(())
    }
}

fn decode(frame: &[u8], expect_tool: bool) -> Option<ServerJsonRpcMessage> {
    if frame.last() != Some(&b'\n') {
        return None;
    }
    let value: Value = serde_json::from_slice(frame).ok()?;
    // rmcp permits an omitted content array, but this executor contract requires one.
    if let Some(result) = value.get("result") {
        if value.get("error").is_some()
            || value.get("method").is_some()
            || !result.is_object()
            || (expect_tool
                && (!result["content"].is_array()
                    || result.get("isError").is_some_and(|e| !e.is_boolean())))
        {
            return None;
        }
    }
    serde_json::from_value(value).ok()
}

struct Frame(Vec<u8>);
impl io::Write for Frame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() >= FRAME_LIMIT - self.0.len() {
            return Err(io::Error::other("frame too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_executor_wire_contract() {
        for frame in [
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"structuredContent\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]},\"error\":null}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[] }\n",
            "not-json\n",
        ] {
            assert!(decode(frame.as_bytes(), true).is_none());
        }
        assert!(decode(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[],\"structuredContent\":{}}}\n", true).is_some());
        assert!(serde_json::to_writer(Frame(Vec::new()), &"x".repeat(FRAME_LIMIT)).is_err());
    }
}
