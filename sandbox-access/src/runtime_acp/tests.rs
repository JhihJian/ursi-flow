use super::*;
use tokio::{net::TcpListener, sync::oneshot};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::handshake::server::{Request, Response},
};

const TOKEN: &str = "admin-private-fixture-session-identity";

async fn fixture() -> (Binding, TcpListener, Role) {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let identity = Identity {
        sandbox_id: "sb-real-wire".into(),
        address: ([127, 0, 0, 1], listener.local_addr().unwrap().port()).into(),
        token: TOKEN.into(),
        model: "fixed".into(),
    };
    let role = Role {
        id: "r".into(),
        name: "role".into(),
        prompt: "role".into(),
        model: Some("fixed".into()),
        skills: vec![],
        mcp_servers: vec![],
        executor_id: None,
    };
    (Binding { identity }, listener, role)
}

async fn method(ws: &mut Socket, name: &str) -> Value {
    let v = receive(ws).await.unwrap();
    assert_eq!(v["method"], name);
    v
}
async fn reply(ws: &mut Socket, request: &Value, result: Value) {
    send(
        ws,
        json!({"jsonrpc":"2.0", "id":request["id"],"result":result}),
    )
    .await
    .unwrap();
}
async fn accept(listener: &TcpListener) -> Socket {
    let (stream, _) = listener.accept().await.unwrap();
    let mut ws = accept_hdr_async(stream, |req: &Request, resp: Response| {
        assert_eq!(req.uri(), "/acp");
        assert_eq!(req.headers()["authorization"], format!("Bearer {TOKEN}"));
        Ok(resp)
    })
    .await
    .unwrap();
    let init = method(&mut ws, "initialize").await;
    assert_eq!(
        init["params"],
        json!({"protocolVersion":1,"clientCapabilities":{}})
    );
    reply(&mut ws, &init, json!({"protocolVersion":1})).await;
    ws
}
async fn session(listener: &TcpListener) -> (Socket, Value) {
    let mut ws = accept(listener).await;
    let req = method(&mut ws, "session/new").await;
    assert_eq!(
        req["params"],
        json!({"cwd":"/ursi/workspace/repo","mcpServers":[]})
    );
    reply(&mut ws, &req, json!({"sessionId":"s1"})).await;
    let req = method(&mut ws, "session/prompt").await;
    assert_eq!(
        req["params"],
        json!({"sessionId":"s1","prompt":[{"type":"text","text":"task"}]})
    );
    (ws, req)
}

#[tokio::test]
async fn sdk_status_during_prompt_does_not_confirm_cancel() {
    let (binding, listener, role) = fixture().await;
    let (cancel, rx) = watch::channel(false);
    let (started, ready) = oneshot::channel();
    let server = async {
        let (mut prompt_ws, prompt) = session(&listener).await;
        started.send(()).unwrap();
        let mut reader = accept(&listener).await;
        let status = method(&mut reader, "_ursi/session/status").await;
        assert_eq!(status["params"], json!({"sessionId":"s1"}));
        reply(
            &mut reader,
            &status,
            json!({"sessionId":"s1","state":"running","pid":42,"detail":"provider-secret","credentials":{"token":TOKEN}}),
        )
        .await;
        let cancel = method(&mut prompt_ws, "session/cancel").await;
        assert_eq!(cancel["params"], json!({"sessionId":"s1"}));
        assert!(cancel.get("id").is_none());
        reply(&mut prompt_ws, &prompt, json!({"stopReason":"cancelled"})).await;
        let close = method(&mut prompt_ws, "_ursi/session/close").await;
        assert_eq!(close["params"], json!({"sessionId":"s1"}));
        reply(&mut prompt_ws, &close, json!({})).await;
    };
    let observe = async {
        ready.await.unwrap();
        let status = binding.session_status("s1").await.unwrap();
        assert_eq!(status, json!({"sessionId":"s1","state":"running","pid":42}));
        cancel.send(true).unwrap();
    };
    let result = timeout(Duration::from_secs(5), async {
        tokio::join!(binding.execute(&role, "task", rx), server, observe).0
    })
    .await
    .unwrap();
    assert!(matches!(result, Err(ExecutorError::DoNotRetry(_))));
}

#[tokio::test]
async fn sdk_status_accepts_null_pid_and_rejects_invalid_protocol_fields() {
    let (binding, listener, _) = fixture().await;
    let valid = json!({"sessionId":"s1","state":"idle","pid":null});
    for status in [
        valid.clone(),
        json!({"sessionId":"other","state":"idle","pid":null}),
        json!({"sessionId":"s1","state":"provider-secret","pid":null}),
        json!({"sessionId":"s1","state":"idle"}),
        json!({"sessionId":"s1","state":"idle","pid":"provider-secret"}),
        json!({"sessionId":"s1","state":"idle","pid":0}),
        json!({"sessionId":"s1","state":"idle","pid":4294967296_u64}),
    ] {
        let server = async {
            let mut ws = accept(&listener).await;
            let req = method(&mut ws, "_ursi/session/status").await;
            reply(&mut ws, &req, status.clone()).await;
        };
        let (result, ()) = tokio::join!(binding.session_status("s1"), server);
        if status == valid {
            assert_eq!(result.unwrap(), valid);
        } else {
            assert!(matches!(result, Err(ExecutorError::OutcomeUnknown(_))));
        }
    }
}

#[tokio::test]
async fn new_rejection_is_definitive_only_with_a_valid_matching_error_receipt() {
    for (receipt, rejected) in [
        (
            Some(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":TOKEN}})),
            true,
        ),
        (
            Some(json!({"jsonrpc":"2.0","id":2,"error":{"message":"invalid"}})),
            false,
        ),
        (
            Some(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"late"}})),
            false,
        ),
        (None, false),
    ] {
        let (binding, listener, role) = fixture().await;
        let (_cancel, rx) = watch::channel(false);
        let server = async {
            let mut ws = accept(&listener).await;
            method(&mut ws, "session/new").await;
            if let Some(receipt) = receipt {
                send(&mut ws, receipt).await.unwrap();
            }
        };
        let (result, ()) = tokio::join!(binding.execute(&role, "task", rx), server);
        if rejected {
            assert!(matches!(result, Err(ExecutorError::DoNotRetry(msg)) if !msg.contains(TOKEN)));
        } else {
            assert!(matches!(result, Err(ExecutorError::OutcomeUnknown(_))));
        }
    }
}

#[tokio::test]
async fn unrelated_responses_and_updates_do_not_complete_current_request() {
    let (binding, listener, role) = fixture().await;
    let (_cancel, rx) = watch::channel(false);
    let server = async {
        let mut ws = accept(&listener).await;
        let new = method(&mut ws, "session/new").await;
        send(&mut ws, json!({"jsonrpc":"2.0","id":1,"result":{}}))
            .await
            .unwrap();
        reply(&mut ws, &new, json!({"sessionId":"s1"})).await;
        let prompt = method(&mut ws, "session/prompt").await;
        send(
            &mut ws,
            json!({"jsonrpc":"2.0","id":"3","error":{"code":-32000,"message":"unrelated"}}),
        )
        .await
        .unwrap();
        for (sid, text) in [("s2", "other"), ("s1", "expected")] {
            send(&mut ws,json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":sid,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})).await.unwrap();
        }
        reply(&mut ws, &prompt, json!({"stopReason":"end_turn"})).await;
        let close = method(&mut ws, "_ursi/session/close").await;
        reply(&mut ws, &prompt, json!({"stopReason":"end_turn"})).await;
        reply(&mut ws, &close, json!({})).await;
    };
    let (result, ()) = timeout(Duration::from_secs(5), async {
        tokio::join!(binding.execute(&role, "task", rx), server)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap(), "expected");
}

#[tokio::test]
async fn late_unrelated_receipt_does_not_extend_control_deadline() {
    let (binding, listener, role) = fixture().await;
    let (_cancel, rx) = watch::channel(false);
    let server = async {
        let mut ws = accept(&listener).await;
        method(&mut ws, "session/new").await;
        tokio::time::sleep(CONTROL / 2).await;
        send(&mut ws, json!({"jsonrpc":"2.0","id":1,"result":{}}))
            .await
            .unwrap();
        assert!(receive(&mut ws).await.is_err()); // Client drops the connection on timeout.
    };
    let start = tokio::time::Instant::now();
    let (result, ()) = timeout(CONTROL + Duration::from_secs(2), async {
        tokio::join!(binding.execute(&role, "task", rx), server)
    })
    .await
    .unwrap();
    assert!(matches!(result, Err(ExecutorError::OutcomeUnknown(_))));
    assert!(start.elapsed() >= CONTROL);
}

#[tokio::test]
async fn cancel_write_backpressure_is_bounded_by_control_timeout() {
    let sink = futures_util::sink::unfold((), |(), _: Message| {
        std::future::pending::<Result<(), ()>>()
    });
    tokio::pin!(sink);
    let start = tokio::time::Instant::now();
    let result = timeout(
        CONTROL + Duration::from_secs(2),
        send_cancel(&mut sink, &json!({"sessionId":"s1"})),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(start.elapsed() >= CONTROL);
}

#[tokio::test]
async fn receipt_loss_invalid_stop_and_failed_close_are_unknown() {
    for stop in [
        None,
        Some("unrecognized"),
        Some("cancelled"),
        Some("end_turn"),
        Some("rpc-error"),
    ] {
        let (binding, listener, role) = fixture().await;
        let (_cancel, rx) = watch::channel(false);
        let server = async {
            let (mut ws, prompt) = session(&listener).await;
            match stop {
                None => return,
                Some("rpc-error") => send(&mut ws,json!({"jsonrpc":"2.0","id":prompt["id"],"error":{"code":-32000,"message":"process cleanup failed"}})).await.unwrap(),
                Some(reason) => reply(&mut ws,&prompt,json!({"stopReason":reason})).await,
            }
            if stop != Some("unrecognized") {
                // Even a confirmed prompt result cannot substitute for cleanup.
                let _ = method(&mut ws, "_ursi/session/close").await;
            }
        };
        let result = timeout(Duration::from_secs(5), async {
            tokio::join!(binding.execute(&role, "task", rx), server).0
        })
        .await
        .unwrap();
        assert!(
            matches!(result, Err(ExecutorError::OutcomeUnknown(_))),
            "{stop:?}: {result:?}"
        );
        assert!(
            timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn text_chunks_preserve_whitespace_and_redact_across_messages() {
    let (binding, listener, role) = fixture().await;
    let (_cancel, rx) = watch::channel(false);
    let server = async {
        let (mut ws, prompt) = session(&listener).await;
        for text in ["done\n  ", &TOKEN[..8], &TOKEN[8..]] {
            send(&mut ws,json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})).await.unwrap();
        }
        reply(&mut ws, &prompt, json!({"stopReason":"end_turn"})).await;
        let close = method(&mut ws, "_ursi/session/close").await;
        reply(&mut ws, &close, json!({})).await;
    };
    let result = tokio::join!(binding.execute(&role, "task", rx), server)
        .0
        .unwrap();
    assert_eq!(result, "done\n  [REDACTED]");
}

#[tokio::test]
async fn unbound_model_and_unsupported_capabilities_rejected_before_connect() {
    let (binding, listener, role) = fixture().await;
    let (_cancel, rx) = watch::channel(false);
    for other in [
        Role {
            model: None,
            ..role.clone()
        },
        Role {
            model: Some("other".into()),
            ..role.clone()
        },
        Role {
            skills: vec!["multi-file".into()],
            ..role.clone()
        },
        Role {
            mcp_servers: vec!["mcp".into()],
            ..role.clone()
        },
    ] {
        assert!(matches!(
            binding.execute(&other, "task", rx.clone()).await,
            Err(ExecutorError::Launch(_))
        ));
    }
    assert!(
        timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}
