//! Docker CLI 驱动。只管理 namespace 内带完整 ownership 标签的资源。
//!
//! 容器 generation 是工作负载代次，卷的 generation 固定为 data_generation，
//! 因而保数据重建可跨工作负载代次验证并复用同一卷。CLI 失败保留已创建资源，
//! 下一次 ensure 通过稳定名称接回。生产通过 connect 固定本地 Unix socket 与 daemon ID，
//! 不支持 TCP、SSH 或 TLS Docker 端点。测试使用 new 和脚本化 CLI，不访问 Docker。

use std::{collections::BTreeMap, net::IpAddr, process::Stdio, time::Duration};

use async_trait::async_trait;
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::TcpStream,
    process::Command,
    time::timeout,
};

use super::Driver;
use crate::models::{
    Capabilities, Error, Observed, ObservedEndpoint, Resource, Result, Sandbox, valid_name,
};

const SCOPE: &str = "io.ursi.scope";
const ID: &str = "io.ursi.id";
const GENERATION: &str = "io.ursi.generation";
const DATA_GENERATION: &str = "io.ursi.data_generation";
const OUTPUT_LIMIT: usize = 1024 * 1024;
const LOG_LIMIT: usize = 64 * 1024;
const TAIL_LIMIT: usize = 5000;
const CLI_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(test)]
type Script = std::sync::Mutex<std::collections::VecDeque<(Vec<String>, Result<CliOutput>)>>;

pub struct DockerDriver {
    namespace: String,
    docker_host: Option<String>,
    identity: String,
    runtime_profiles: super::profiles::RuntimeProfiles,
    #[cfg(test)]
    script: Option<Script>,
}

#[derive(Debug)]
struct CliOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

impl CliOutput {
    fn check(self) -> Result<Self> {
        if self.success {
            Ok(self)
        } else {
            Err(Error::Unavailable(format!(
                "docker: {}",
                String::from_utf8_lossy(&self.stderr)
            )))
        }
    }
}

impl DockerDriver {
    /// 解析 Docker CLI 的当前连接配置，并固定后续所有命令的目标。
    /// DOCKER_CONTEXT 优先于 DOCKER_HOST，其次为配置文件中的当前 context。
    /// 仅支持本地 Unix socket，不加载远端 context 的 TLS/SSH 配置。
    pub async fn connect(namespace: String) -> Result<Self> {
        let mut driver = Self::new(namespace)?;
        let context = docker_env("DOCKER_CONTEXT")?;
        let host = docker_env("DOCKER_HOST")?;
        driver.initialize_connection(context, host).await?;
        Ok(driver)
    }

    /// 管理员白名单固定到当前驱动。新增配置不改变 daemon/namespace 的数据库身份。
    pub fn with_runtime_profiles(mut self, profiles: super::profiles::RuntimeProfiles) -> Self {
        self.runtime_profiles = profiles;
        self
    }

    /// 返回冻结的 endpoint 与 daemon ID，供持久化存储绑定使用。
    pub fn identity(&self) -> &str {
        &self.identity
    }

    /// 仅构造配置，不访问 Docker。生产入口应使用 connect。
    pub fn new(namespace: String) -> Result<Self> {
        if !valid_name(&namespace) || !namespace.as_bytes()[0].is_ascii_alphanumeric() {
            return Err(Error::Invalid(
                "Docker namespace 必须以字母或数字开头，且仅含字母、数字、下划线和连字符".into(),
            ));
        }
        Ok(Self {
            namespace,
            docker_host: None,
            identity: String::new(),
            runtime_profiles: Default::default(),
            #[cfg(test)]
            script: None,
        })
    }

    async fn initialize_connection(
        &mut self,
        context: Option<String>,
        host: Option<String>,
    ) -> Result<()> {
        let endpoint = if let Some(host) = host.filter(|_| context.is_none()) {
            host
        } else {
            let mut args = vec!["context".into(), "inspect".into()];
            if let Some(context) = context {
                args.extend(["--".into(), context]);
            }
            let output = self.run(args, CLI_TIMEOUT, OUTPUT_LIMIT).await?.check()?;
            if output.truncated {
                return Err(Error::Unavailable("Docker context 输出过大".into()));
            }
            let contexts: Vec<Value> = serde_json::from_slice(&output.stdout)
                .map_err(|_| Error::Unavailable("Docker context 响应非法".into()))?;
            if contexts.len() != 1 {
                return Err(Error::Unavailable("Docker context 未返回唯一目标".into()));
            }
            contexts[0]["Endpoints"]["docker"]["Host"]
                .as_str()
                .filter(|host| !host.is_empty())
                .ok_or_else(|| Error::Unavailable("Docker context 缺少 endpoint".into()))?
                .to_owned()
        };
        if !endpoint.strip_prefix("unix://").is_some_and(|path| {
            path.starts_with('/') && path.len() > 1 && !path.chars().any(char::is_control)
        }) {
            return Err(Error::Unsupported(
                "Docker 仅支持本地绝对路径 Unix socket".into(),
            ));
        }
        // info 也必须使用冻结的端点，保证身份与后续副作用指向同一 daemon。
        self.docker_host = Some(endpoint.clone());
        let output = self
            .run(
                vec!["info".into(), "--format".into(), "{{json .ID}}".into()],
                CLI_TIMEOUT,
                OUTPUT_LIMIT,
            )
            .await?
            .check()?;
        if output.truncated {
            return Err(Error::Unavailable("Docker info 输出过大".into()));
        }
        let daemon_id: String = serde_json::from_slice(&output.stdout)
            .map_err(|_| Error::Unavailable("Docker info ID 响应非法".into()))?;
        if daemon_id.is_empty()
            || daemon_id
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(Error::Unavailable("Docker info 缺少有效 daemon ID".into()));
        }
        self.identity = serde_json::to_string(&(endpoint, daemon_id))
            .expect("serializing Docker identity strings");
        Ok(())
    }

    fn command(&self, args: Vec<String>) -> Command {
        let mut command = Command::new("docker");
        command.args(args);
        if let Some(host) = &self.docker_host {
            command
                .env_remove("DOCKER_CONTEXT")
                .env("DOCKER_HOST", host)
                .env_remove("DOCKER_TLS")
                .env_remove("DOCKER_TLS_VERIFY")
                .env_remove("DOCKER_CERT_PATH");
        }
        command
    }

    fn names(&self, id: &str, resource: Resource) -> Result<(String, String)> {
        if !valid_name(id) || resource.generation == 0 || resource.data_generation == 0 {
            return Err(Error::Invalid("资源 id 或代次非法".into()));
        }
        Ok((
            format!("{}-{id}-r{}", self.namespace, resource.generation),
            format!("{}-{id}-v{}", self.namespace, resource.data_generation),
        ))
    }

    fn labels(&self, id: &str, resource: Resource, volume: bool) -> BTreeMap<String, String> {
        BTreeMap::from([
            (SCOPE.into(), self.namespace.clone()),
            (ID.into(), id.into()),
            (
                GENERATION.into(),
                if volume {
                    resource.data_generation
                } else {
                    resource.generation
                }
                .to_string(),
            ),
            (DATA_GENERATION.into(), resource.data_generation.to_string()),
        ])
    }

    fn owned(&self, object: &Value, id: &str, resource: Resource, volume: bool) -> Result<()> {
        let labels = if volume {
            &object["Labels"]
        } else {
            &object["Config"]["Labels"]
        };
        for (key, expected) in self.labels(id, resource, volume) {
            if labels[&key].as_str() != Some(&expected) {
                return Err(Error::Conflict(format!(
                    "Docker 资源 ownership 标签 {key} 不匹配"
                )));
            }
        }
        Ok(())
    }

    async fn run(&self, args: Vec<String>, timeout: Duration, limit: usize) -> Result<CliOutput> {
        #[cfg(test)]
        if let Some(script) = &self.script {
            let (expected, output) = script
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected Docker call");
            assert_eq!(args, expected);
            return output;
        }
        execute(self.command(args), timeout, limit).await
    }

    async fn inspect(&self, kind: &str, name: &str) -> Result<Option<Value>> {
        let output = self
            .run(
                vec![kind.into(), "inspect".into(), name.into()],
                CLI_TIMEOUT,
                OUTPUT_LIMIT,
            )
            .await?;
        if !output.success && !output.truncated && missing(&output.stderr, kind, name) {
            return Ok(None);
        }
        let output = output.check()?;
        if output.truncated {
            return Err(Error::Unavailable("Docker inspect 输出过大".into()));
        }
        let values: Vec<Value> = serde_json::from_slice(&output.stdout)
            .map_err(|e| Error::Unavailable(format!("Docker inspect 响应非法: {e}")))?;
        if values.len() != 1 || !values[0].is_object() {
            return Err(Error::Unavailable("Docker inspect 未返回唯一资源".into()));
        }
        Ok(values.into_iter().next())
    }

    async fn container(&self, sandbox: &Sandbox) -> Result<Value> {
        let (name, _) = self.names(&sandbox.id, sandbox.resource)?;
        let object = self
            .inspect("container", &name)
            .await?
            .ok_or_else(|| Error::NotFound(format!("容器 {name} 不存在")))?;
        self.owned(&object, &sandbox.id, sandbox.resource, false)?;
        Ok(object)
    }

    fn container_id(object: &Value) -> Result<&str> {
        object["Id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| Error::Unavailable("Docker inspect 缺少容器 ID".into()))
    }

    async fn volume(&self, sandbox: &Sandbox) -> Result<()> {
        let (_, name) = self.names(&sandbox.id, sandbox.resource)?;
        if let Some(object) = self.inspect("volume", &name).await? {
            return self.owned(&object, &sandbox.id, sandbox.resource, true);
        }
        if sandbox.resource.data_generation < sandbox.resource.generation {
            return Err(Error::Conflict("保数据重建所需的数据卷不存在".into()));
        }
        let mut args = vec!["volume".into(), "create".into()];
        for (key, value) in self.labels(&sandbox.id, sandbox.resource, true) {
            args.extend(["--label".into(), format!("{key}={value}")]);
        }
        args.push(name.clone());
        self.run(args, CLI_TIMEOUT, OUTPUT_LIMIT).await?.check()?;
        // volume create 可接回并发创建的同名卷，必须再检查实际标签。
        let object = self
            .inspect("volume", &name)
            .await?
            .ok_or_else(|| Error::Unavailable("创建后的数据卷不存在".into()))?;
        self.owned(&object, &sandbox.id, sandbox.resource, true)
    }

    async fn image(&self, sandbox: &Sandbox) -> Result<String> {
        let image = &sandbox.spec.image;
        let object = match self.inspect("image", image).await? {
            Some(object) => object,
            None => {
                self.run(
                    vec!["pull".into(), image.clone()],
                    Duration::from_secs(1200),
                    LOG_LIMIT,
                )
                .await?
                .check()?;
                self.inspect("image", image)
                    .await?
                    .ok_or_else(|| Error::Unavailable("拉取后的镜像不存在".into()))?
            }
        };
        match &object["Config"]["Volumes"] {
            Value::Null => {}
            Value::Object(volumes) => {
                if volumes.keys().any(|path| path != "/ursi/workspace") {
                    return Err(Error::Unsupported(
                        "镜像只能声明 /ursi/workspace VOLUME，额外声明会产生匿名卷".into(),
                    ));
                }
            }
            _ => return Err(Error::Unavailable("镜像 Config.Volumes 格式非法".into())),
        }
        if let Some(bundle) = &sandbox.spec.bundle {
            let level = object["Config"]["Labels"]["io.ursi.image-level"]
                .as_str()
                .and_then(|v| v.parse::<u32>().ok());
            if !level.is_some_and(|level| level >= bundle.min_image_level) {
                return Err(Error::Unsupported(format!(
                    "镜像 io.ursi.image-level 低于 {} 或未声明",
                    bundle.min_image_level
                )));
            }
        }
        // 使用已验证镜像的不可变 ID，防止 tag 在检查后漂移。
        object["Id"]
            .as_str()
            .filter(|id| {
                id.starts_with("sha256:")
                    && id[7..].len() == 64
                    && id[7..].bytes().all(|c| c.is_ascii_hexdigit())
            })
            .map(str::to_owned)
            .ok_or_else(|| Error::Unavailable("镜像缺少有效 ID".into()))
    }

    fn create_args(&self, sandbox: &Sandbox, image: String) -> Result<Vec<String>> {
        let (name, volume) = self.names(&sandbox.id, sandbox.resource)?;
        let mut args = vec![
            "create".into(),
            "--name".into(),
            name,
            "--memory".into(),
            format!("{}m", sandbox.spec.memory_mb),
            "--cpus".into(),
            sandbox.spec.cpus.to_string(),
            "--pids-limit".into(),
            "256".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--mount".into(),
            format!("type=volume,src={volume},dst=/ursi/workspace"),
        ];
        if let Some(profile) = &sandbox.spec.runtime_profile {
            let path = self.runtime_profiles.get(profile)?;
            args.extend([
                "--mount".into(),
                format!(
                    "type=bind,src={},dst=/run/ursi/config,readonly",
                    path.display()
                ),
            ]);
            // 固定服务能力集，仅供root监督器/sshd降权与回收。Agent子进程清空所有capabilities。
            for capability in [
                "CHOWN",
                "DAC_OVERRIDE",
                "FOWNER",
                "SETUID",
                "SETGID",
                "SYS_CHROOT",
                "KILL",
            ] {
                args.extend(["--cap-add".into(), capability.into()]);
            }
            args.extend(["--stop-timeout".into(), "25".into()]);
        }
        for (key, value) in self.labels(&sandbox.id, sandbox.resource, false) {
            args.extend(["--label".into(), format!("{key}={value}")]);
        }
        for (key, value) in &sandbox.spec.labels {
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                return Err(Error::Invalid("用户标签名称或内容非法".into()));
            }
            args.extend(["--label".into(), format!("io.ursi.user.{key}={value}")]);
        }
        if let Some(bundle) = &sandbox.spec.bundle {
            args.extend([
                "--env".into(),
                format!("URSI_BUNDLE_URL={}", bundle.url),
                "--env".into(),
                format!("URSI_BUNDLE_SHA256={}", bundle.sha256),
                "--env".into(),
                format!("URSI_BUNDLE_MIN_IMAGE_LEVEL={}", bundle.min_image_level),
            ]);
        }
        args.push(image);
        args.extend(sandbox.spec.command.iter().cloned());
        Ok(args)
    }

    fn observed(&self, sandbox: &Sandbox, object: &Value) -> Result<Observed> {
        let running = object["State"]["Running"]
            .as_bool()
            .ok_or_else(|| Error::Unavailable("Docker inspect 缺少 running 状态".into()))?;
        let healthy = object["State"]["Health"]["Status"]
            .as_str()
            .map(|status| status == "healthy");
        let mut endpoints = Vec::new();
        if running && !sandbox.endpoints.is_empty() {
            let ip = object["NetworkSettings"]["Networks"]
                .as_object()
                .into_iter()
                .flat_map(|networks| networks.values())
                .flat_map(|network| {
                    [
                        network["IPAddress"].as_str(),
                        network["GlobalIPv6Address"].as_str(),
                    ]
                })
                .flatten()
                .filter_map(|value| value.parse::<IpAddr>().ok())
                .find(|ip| !ip.is_unspecified())
                .ok_or_else(|| Error::Unavailable("运行中的容器没有内部网络地址".into()))?;
            for declared in &sandbox.endpoints {
                endpoints.push(ObservedEndpoint {
                    name: declared.name.clone(),
                    bundle: declared.bundle.clone(),
                    protocol: declared.protocol.clone(),
                    port: declared.port,
                    state: crate::models::EndpointState::Ready,
                    ready: true,
                    address: format!("{}:{}", host(&ip.to_string()), declared.port),
                });
            }
        }
        Ok(Observed {
            running,
            endpoints,
            healthy,
        })
    }
}

#[async_trait]
impl Driver for DockerDriver {
    fn name(&self) -> &'static str {
        "docker"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            rebuild_preserve_data: true,
            rebuild_destroy_data: true,
        }
    }

    fn validate_spec(&self, spec: &crate::models::SandboxSpec) -> Result<()> {
        spec.validate()?;
        if let Some(profile) = &spec.runtime_profile {
            self.runtime_profiles.get(profile)?;
        }
        Ok(())
    }

    async fn ensure(&self, sandbox: &Sandbox) -> Result<Observed> {
        self.validate_spec(&sandbox.spec)?;
        let (name, volume_name) = self.names(&sandbox.id, sandbox.resource)?;
        // 在任何创建前验证参数。镜像 ID 随后替换。
        self.create_args(sandbox, sandbox.spec.image.clone())?;
        if let Some(object) = self.inspect("container", &name).await? {
            self.owned(&object, &sandbox.id, sandbox.resource, false)?;
            let volume = self
                .inspect("volume", &volume_name)
                .await?
                .ok_or_else(|| Error::Conflict("已有容器的数据卷不存在".into()))?;
            self.owned(&volume, &sandbox.id, sandbox.resource, true)?;
        } else {
            let image = self.image(sandbox).await?;
            self.volume(sandbox).await?;
            let result = self
                .run(self.create_args(sandbox, image)?, CLI_TIMEOUT, OUTPUT_LIMIT)
                .await;
            if let Err(error) = result.and_then(CliOutput::check) {
                // create 响应丢失或同名并发创建时，仅接回严格属于该代的容器。
                match self.inspect("container", &name).await? {
                    Some(object) => self.owned(&object, &sandbox.id, sandbox.resource, false)?,
                    None => return Err(error),
                }
            }
        }
        self.start(sandbox).await?;
        self.observe(sandbox).await
    }

    async fn start(&self, sandbox: &Sandbox) -> Result<()> {
        let object = self.container(sandbox).await?;
        if object["State"]["Running"].as_bool() != Some(true) {
            self.run(
                vec!["start".into(), Self::container_id(&object)?.into()],
                CLI_TIMEOUT,
                OUTPUT_LIMIT,
            )
            .await?
            .check()?;
        }
        Ok(())
    }

    async fn stop(&self, sandbox: &Sandbox) -> Result<()> {
        let object = self.container(sandbox).await?;
        self.run(
            vec![
                "stop".into(),
                "--time".into(),
                if sandbox.spec.runtime_profile.is_some() {
                    "25"
                } else {
                    "10"
                }
                .into(),
                Self::container_id(&object)?.into(),
            ],
            CLI_TIMEOUT,
            OUTPUT_LIMIT,
        )
        .await?
        .check()?;
        Ok(())
    }

    async fn remove(&self, id: &str, resource: Resource, remove_data: bool) -> Result<()> {
        let (name, volume_name) = self.names(id, resource)?;
        let container = self.inspect("container", &name).await?;
        if let Some(object) = &container {
            self.owned(object, id, resource, false)?;
        }
        // 先完整验证所有待删资源，ownership 不符时不产生部分删除。
        let volume = if remove_data {
            self.inspect("volume", &volume_name).await?
        } else {
            None
        };
        if let Some(object) = &volume {
            self.owned(object, id, resource, true)?;
        }
        if let Some(object) = container {
            let container_id = Self::container_id(&object)?;
            let output = self
                .run(
                    vec!["rm".into(), "--force".into(), container_id.into()],
                    CLI_TIMEOUT,
                    OUTPUT_LIMIT,
                )
                .await?;
            if !output.success
                && (output.truncated || !missing(&output.stderr, "container", container_id))
            {
                output.check()?;
            }
        }
        if volume.is_some() {
            let output = self
                .run(
                    vec!["volume".into(), "rm".into(), volume_name.clone()],
                    CLI_TIMEOUT,
                    OUTPUT_LIMIT,
                )
                .await?;
            if !output.success
                && (output.truncated || !missing(&output.stderr, "volume", &volume_name))
            {
                output.check()?;
            }
        }
        Ok(())
    }

    async fn capture_target(&self, sandbox: &Sandbox) -> Result<Value> {
        let object = self.container(sandbox).await?;
        if object["State"]["Running"] != true {
            return Err(Error::Conflict("容器未运行".into()));
        }
        Ok(serde_json::json!({
            "container": Self::container_id(&object)?, "generation": sandbox.resource.generation,
            "pid": object["State"]["Pid"], "started_at": object["State"]["StartedAt"],
            "docker_host": self.docker_host,
        }))
    }

    async fn observe(&self, sandbox: &Sandbox) -> Result<Observed> {
        let mut observed = self.observed(sandbox, &self.container(sandbox).await?)?;
        if observed.running {
            for endpoint in &mut observed.endpoints {
                let ready = timeout(
                    Duration::from_millis(750),
                    TcpStream::connect(&endpoint.address),
                )
                .await
                .is_ok_and(|result| result.is_ok());
                endpoint.ready = ready;
                endpoint.state = if ready {
                    crate::models::EndpointState::Ready
                } else {
                    crate::models::EndpointState::Unavailable
                };
            }
        }
        Ok(observed)
    }

    async fn logs(&self, sandbox: &Sandbox, tail: usize) -> Result<String> {
        let object = self.container(sandbox).await?;
        let output = self
            .run(
                vec![
                    "logs".into(),
                    "--tail".into(),
                    tail.min(TAIL_LIMIT).to_string(),
                    Self::container_id(&object)?.into(),
                ],
                CLI_TIMEOUT,
                LOG_LIMIT,
            )
            .await?
            .check()?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        if output.truncated {
            text.push_str("\n[日志输出已截断]\n");
        }
        Ok(text)
    }
}

fn docker_env(name: &str) -> Result<Option<String>> {
    match std::env::var(name) {
        Ok(value) => Ok((!value.is_empty()).then_some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(Error::Invalid(format!("{name} 必须为 UTF-8")))
        }
    }
}

fn host(value: &str) -> String {
    if value.contains(':') {
        format!("[{value}]")
    } else {
        value.into()
    }
}

// 只认可 Docker 针对当前对象的明确不存在响应。包含 daemon/连接错误的混合输出仍是失败。
fn missing(stderr: &[u8], kind: &str, name: &str) -> bool {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    let normalized = text
        .strip_prefix("Error response from daemon: ")
        .or_else(|| text.strip_prefix("Error: "))
        .unwrap_or(text);
    normalized == format!("No such {kind}: {name}")
        || (kind == "volume"
            && [
                format!("get {name}: no such volume"),
                format!("remove {name}: no such volume"),
                format!("volume {name} not found"),
            ]
            .contains(&normalized.to_owned()))
        || (kind == "image"
            && !name.contains('@')
            && !name.rsplit('/').next().unwrap_or(name).contains(':')
            && normalized == format!("No such image: {name}:latest"))
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(limit.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok((result, truncated))
}

async fn execute(mut command: Command, timeout: Duration, limit: usize) -> Result<CliOutput> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| Error::Unavailable(format!("无法启动 Docker CLI: {e}")))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let result = tokio::time::timeout(timeout, async {
        tokio::try_join!(
            child.wait(),
            read_bounded(stdout, limit),
            read_bounded(stderr, limit)
        )
    })
    .await;
    match result {
        Ok(Ok((status, (stdout, out_truncated), (stderr, err_truncated)))) => Ok(CliOutput {
            success: status.success(),
            stdout,
            stderr,
            truncated: out_truncated || err_truncated,
        }),
        Ok(Err(e)) => Err(Error::Unavailable(format!("Docker CLI 读取失败: {e}"))),
        Err(_) => Err(Error::Unavailable("Docker CLI 执行超时".into())),
    }
}

#[cfg(test)]
#[path = "docker_tests.rs"]
mod tests;
