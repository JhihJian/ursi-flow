use super::*;
use axum::{Router, routing::get};
use std::{
    future::Future,
    net::SocketAddr,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as ClientMessage, client::IntoClientRequest},
};

type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

struct Fixture {
    address: SocketAddr,
    alive: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
impl Fixture {
    async fn new<F, Fut>(target: F) -> Self
    where
        F: FnOnce(TcpStream) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let tcp = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let target_address = format!("127.0.0.1:{}", tcp.local_addr().unwrap().port());
        let target_task = tokio::spawn(async move {
            target(tcp.accept().await.unwrap().0).await;
        });
        let alive = Arc::new(AtomicBool::new(true));
        let route_alive = alive.clone();
        let app = Router::new().route(
            "/",
            get(move |upgrade: WebSocketUpgrade| {
                let target_address = target_address.clone();
                let route_alive = route_alive.clone();
                async move {
                    let tcp = TcpStream::connect(target_address).await.unwrap();
                    configure(upgrade).on_upgrade(move |ws| async move {
                        relay_with_check(ws, tcp, move || route_alive.load(Ordering::SeqCst)).await;
                    })
                }
            }),
        );
        let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let address = SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
        let api_task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            address,
            alive,
            tasks: vec![target_task, api_task],
        }
    }
    async fn client(&self) -> Client {
        let mut request = format!("ws://{}/", self.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("sec-websocket-protocol", PROTOCOL.parse().unwrap());
        let (client, response) = connect_async(request).await.unwrap();
        assert_eq!(response.headers()["sec-websocket-protocol"], PROTOCOL);
        client
    }
}

async fn closed(client: &mut Client) {
    time::timeout(Duration::from_secs(2), async {
        loop {
            match client.next().await {
                None | Some(Err(_)) | Some(Ok(ClientMessage::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .expect("tunnel did not close");
}

#[tokio::test]
async fn binary_roundtrip_preserves_output_after_input_eof() {
    let input: Vec<_> = (0..130_000).map(|index| (index % 251) as u8).collect();
    let expected = input.clone();
    let fixture = Fixture::new(move |mut tcp| async move {
        let mut received = Vec::new();
        tcp.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, expected);
        // 上游收到 FIN 后才产生输出，能发现提前终止回包的问题。
        tcp.write_all(&received).await.unwrap();
        tcp.shutdown().await.unwrap();
    })
    .await;
    let mut client = fixture.client().await;
    for chunk in input.chunks(MAX_CLIENT_MESSAGE) {
        client
            .send(ClientMessage::Binary(chunk.to_vec().into()))
            .await
            .unwrap();
    }
    client
        .send(ClientMessage::Text("eof".into()))
        .await
        .unwrap();
    let mut received = Vec::new();
    time::timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await.unwrap().unwrap() {
                ClientMessage::Binary(bytes) => {
                    assert!(bytes.len() <= OUTPUT_CHUNK);
                    received.extend_from_slice(&bytes);
                }
                ClientMessage::Text(text) => {
                    assert_eq!(text, "eof");
                    break;
                }
                ClientMessage::Ping(_) | ClientMessage::Pong(_) => {}
                frame => panic!("unexpected frame: {frame:?}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(received, input);
    closed(&mut client).await;
}

#[tokio::test]
async fn target_eof_does_not_truncate_later_client_input() {
    let (bytes_tx, bytes_rx) = tokio::sync::oneshot::channel();
    let fixture = Fixture::new(move |mut tcp| async move {
        tcp.shutdown().await.unwrap();
        let mut data = Vec::new();
        tcp.read_to_end(&mut data).await.unwrap();
        bytes_tx.send(data).unwrap();
    })
    .await;
    let mut client = fixture.client().await;
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        ClientMessage::Text("eof".into())
    );
    client
        .send(ClientMessage::Binary(b"late input".to_vec().into()))
        .await
        .unwrap();
    client
        .send(ClientMessage::Text("eof".into()))
        .await
        .unwrap();
    assert_eq!(
        time::timeout(Duration::from_secs(2), bytes_rx)
            .await
            .unwrap()
            .unwrap(),
        b"late input"
    );
    closed(&mut client).await;
}

#[tokio::test]
async fn rejects_invalid_text_oversized_messages_and_data_after_eof() {
    for messages in [
        vec![ClientMessage::Text("arbitrary command".into())],
        vec![ClientMessage::Binary(
            vec![0; MAX_CLIENT_MESSAGE + 1].into(),
        )],
        vec![
            ClientMessage::Text("eof".into()),
            ClientMessage::Text("eof".into()),
        ],
        vec![
            ClientMessage::Text("eof".into()),
            ClientMessage::Binary(vec![1].into()),
        ],
    ] {
        let fixture = Fixture::new(|tcp| async move {
            let _stream = tcp;
            std::future::pending::<()>().await;
        })
        .await;
        let mut client = fixture.client().await;
        for message in messages {
            client.send(message).await.unwrap();
        }
        closed(&mut client).await;
    }
}

#[tokio::test]
async fn ping_pong_remains_valid_after_input_eof() {
    let fixture = Fixture::new(|tcp| async move {
        let _stream = tcp;
        std::future::pending::<()>().await;
    })
    .await;
    let mut client = fixture.client().await;
    client
        .send(ClientMessage::Text("eof".into()))
        .await
        .unwrap();
    client
        .send(ClientMessage::Ping(b"live".to_vec().into()))
        .await
        .unwrap();
    let reply = time::timeout(Duration::from_secs(2), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply, ClientMessage::Pong(b"live".to_vec().into()));
}

#[tokio::test]
async fn lifecycle_cancellation_closes_a_backpressured_connection_within_one_second() {
    let fixture = Fixture::new(|tcp| async move {
        let _stream = tcp;
        std::future::pending::<()>().await;
    })
    .await;
    let client = fixture.client().await;
    let (mut writer, mut reader) = client.split();
    let writing = tokio::spawn(async move {
        for _ in 0..4096 {
            if writer
                .send(ClientMessage::Binary(vec![1; MAX_CLIENT_MESSAGE].into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    time::sleep(Duration::from_millis(100)).await;
    fixture.alive.store(false, Ordering::SeqCst);
    let result = time::timeout(Duration::from_secs(1), async {
        loop {
            match reader.next().await {
                None | Some(Err(_)) | Some(Ok(ClientMessage::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    writing.abort();
    assert!(
        result.is_ok(),
        "backpressure delayed lifecycle cancellation"
    );
}
