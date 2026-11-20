//! 本进程内的 Linux 旁路采集。只有专用线程进入目标网络命名空间。
//! `bytes` 包含 PCAP 文件头与记录头。接收线程和写入线程通过固定块池解耦，
//! 队列满时记录用户态丢包并继续收包。取消后最多排空 250 毫秒，只有读到
//! EAGAIN 才确认尾包排空；超时报错。慢盘可延长观测任务收尾，不阻塞 Gateway。

use anyhow::{Context, Result, anyhow, bail};
use std::collections::VecDeque;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const SEGMENT_BYTES: u64 = 256 * 1024 * 1024;
const SYNC_BYTES: u64 = 8 * 1024 * 1024;
const SOCKET_BUFFER: libc::c_int = 4 * 1024 * 1024;
const SNAPLEN: usize = 262_144;
// 接收前为 SLL2 和可能由辅助元数据恢复的 VLAN 头预留空间。
const RECEIVE_BYTES: usize = SNAPLEN - SLL2_HEADER - 4;
const GLOBAL_HEADER: usize = 24;
const RECORD_HEADER: usize = 16;
const SLL2_HEADER: usize = 20;
const PACKET_HEAD: usize = RECORD_HEADER + SLL2_HEADER;
const INTERVAL: Duration = Duration::from_secs(1);
const DRAIN_BUDGET: Duration = Duration::from_millis(250);
const BLOCK_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const BLOCK_BYTES: usize = PACKET_HEAD + SNAPLEN + 4;
const BLOCK_COUNT: usize = (6 * 1024 * 1024) / BLOCK_BYTES;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CaptureStatus {
    pub state: String,
    pub error: Option<String>,
    pub segments: u64,
    pub packets: u64,
    pub bytes: u64,
    pub kernel_drops: u64,
    pub queue_drops: u64,
}

struct Shared {
    status: Mutex<CaptureStatus>,
    stop: AtomicBool,
    abort: AtomicBool,
    wake: OwnedFd,
}

pub struct Capture {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

/// 网络命名空间、socket 和首段文件准备完成后才报告就绪。两秒未就绪即取消。
/// 调用者持有已核验身份的命名空间，避免通过可能复用的 PID 二次寻址。
pub fn start(namespace: File, run_dir: &Path, limit_bytes: u64) -> Result<Capture> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    let wake = owned_fd(fd).context("创建抓包取消 eventfd")?;
    let shared = Arc::new(Shared {
        status: Mutex::new(CaptureStatus {
            segments: 0,
            state: "starting".into(),
            error: None,
            packets: 0,
            bytes: 0,
            kernel_drops: 0,
            queue_drops: 0,
        }),
        stop: AtomicBool::new(false),
        abort: AtomicBool::new(false),
        wake,
    });
    let worker_shared = shared.clone();
    let directory = run_dir.to_path_buf();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let handle = thread::Builder::new()
        .name("packet-receiver".into())
        .stack_size(1024 * 1024)
        .spawn(move || {
            // 仅在专用线程进入网络命名空间并初始化采集。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker(
                    namespace,
                    directory,
                    limit_bytes,
                    worker_shared.clone(),
                    &ready_tx,
                )
            }));
            let error = match result {
                Ok(Ok(())) => return,
                Ok(Err(error)) => format!("{error:#}"),
                Err(_) => "抓包工作线程发生 panic".into(),
            };
            let mut status = worker_shared
                .status
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            status.state = "error".into();
            status.error = Some(error.clone());
            let _ = ready_tx.try_send(Err(error));
        })
        .context("启动抓包 OS 线程")?;
    let capture = Capture {
        shared,
        thread: Some(handle),
    };
    match ready_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok(())) => Ok(capture),
        Ok(Err(error)) => Err(anyhow!(error)),
        Err(mpsc::RecvTimeoutError::Timeout) => bail!("抓包初始化超过 2 秒，已请求取消"),
        Err(mpsc::RecvTimeoutError::Disconnected) => bail!("抓包工作线程在就绪前退出"),
    }
    // 错误路径也在独立观测任务中收尾；释放沙箱锁前必须停止写入。
}

impl Capture {
    pub fn status(&self) -> CaptureStatus {
        self.shared
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn request_stop(&self) {
        self.shared.stop.store(true, Ordering::Release);
        wake(&self.shared);
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// 不等待活动线程，调用者应在总清理期限内轮询 is_finished。
    pub fn finish(&mut self) -> Result<CaptureStatus> {
        if !self.is_finished() {
            bail!("抓包线程仍在运行");
        }
        if let Some(handle) = self.thread.take() {
            handle.join().map_err(|_| anyhow!("抓包线程异常退出"))?;
        }
        Ok(self.status())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.request_stop();
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn wake(shared: &Shared) {
    let value = 1u64;
    loop {
        let result = unsafe {
            libc::write(
                shared.wake.as_raw_fd(),
                (&value as *const u64).cast(),
                size_of::<u64>(),
            )
        };
        if result >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break;
        }
    }
}

fn request_abort(shared: &Shared) {
    shared.abort.store(true, Ordering::Release);
    shared.stop.store(true, Ordering::Release);
    wake(shared);
}

fn owned_fd(fd: RawFd) -> io::Result<OwnedFd> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: 成功系统调用返回新拥有的文件描述符。
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn set_option<T>(fd: RawFd, level: i32, name: i32, value: &T) -> io::Result<()> {
    let result = unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (value as *const T).cast(),
            size_of::<T>() as libc::socklen_t,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn packet_socket() -> Result<OwnedFd> {
    let fd = owned_fd(unsafe {
        // protocol=0 在 bind 完成前不接收报文。
        libc::socket(
            libc::AF_PACKET,
            libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
        )
    })
    .context("创建 AF_PACKET socket，需要 CAP_NET_RAW")?;
    let raw = fd.as_raw_fd();
    set_option(raw, libc::SOL_SOCKET, libc::SO_RCVBUF, &SOCKET_BUFFER)
        .context("设置抓包接收缓冲")?;
    let mut actual = 0i32;
    let mut length = size_of::<i32>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            raw,
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            (&mut actual as *mut i32).cast(),
            &mut length,
        )
    } < 0
    {
        return Err(io::Error::last_os_error()).context("读取抓包缓冲预算");
    }
    // Linux SO_RCVBUF 会翻倍；禁止 SO_RCVBUFFORCE，也不需要 CAP_NET_ADMIN。
    if actual <= 0 || actual > SOCKET_BUFFER * 2 {
        bail!("内核接收缓冲超出 8 MiB 预算: {actual}");
    }
    set_option(raw, libc::SOL_SOCKET, libc::SO_TIMESTAMPNS, &1i32).context("启用内核报文时间戳")?;
    set_option(raw, libc::SOL_PACKET, libc::PACKET_AUXDATA, &1i32).context("启用 VLAN 元数据")?;
    let mut address: libc::sockaddr_ll = unsafe { zeroed() };
    address.sll_family = libc::AF_PACKET as u16;
    address.sll_protocol = (libc::ETH_P_ALL as u16).to_be();
    address.sll_ifindex = 0; // 所有接口，包括后续新建的普通接口。
    if unsafe {
        libc::bind(
            raw,
            (&address as *const libc::sockaddr_ll).cast(),
            size_of::<libc::sockaddr_ll>() as libc::socklen_t,
        )
    } < 0
    {
        return Err(io::Error::last_os_error()).context("绑定命名空间全部接口");
    }
    Ok(fd)
}

fn kernel_drops(fd: RawFd) -> Result<u64> {
    let mut stats: libc::tpacket_stats = unsafe { zeroed() };
    let mut length = size_of::<libc::tpacket_stats>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_PACKET,
            libc::PACKET_STATISTICS,
            (&mut stats as *mut libc::tpacket_stats).cast(),
            &mut length,
        )
    } < 0
    {
        return Err(io::Error::last_os_error()).context("读取 PACKET_STATISTICS");
    }
    // 每次 getsockopt 重置内核计数，调用者累加差量。
    Ok(stats.tp_drops as u64)
}

struct Packet {
    size: usize,
    wire_length: usize,
    address: libc::sockaddr_ll,
    timestamp: libc::timespec,
    vlan: Option<(u16, u16)>,
}

enum Received {
    Packet(Packet),
    Empty,
    Interrupted,
}

fn receive(fd: RawFd, payload: &mut [u8]) -> Result<Received> {
    let capacity = payload.len().min(RECEIVE_BYTES);
    let mut address: libc::sockaddr_ll = unsafe { zeroed() };
    let mut iov = libc::iovec {
        iov_base: payload.as_mut_ptr().cast(),
        iov_len: capacity,
    };
    // usize 确保 cmsghdr 的对齐，容纳时间戳及 tpacket_auxdata。
    let mut control = [0usize; 32];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_name = (&mut address as *mut libc::sockaddr_ll).cast();
    message.msg_namelen = size_of::<libc::sockaddr_ll>() as libc::socklen_t;
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = size_of_val(&control);
    let received = unsafe { libc::recvmsg(fd, &mut message, libc::MSG_TRUNC) };
    if received < 0 {
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::WouldBlock => return Ok(Received::Empty),
            io::ErrorKind::Interrupted => return Ok(Received::Interrupted),
            _ => {}
        }
        return Err(error).context("接收抓包报文");
    }
    if message.msg_flags & libc::MSG_CTRUNC != 0 {
        bail!("抓包附属元数据被截断");
    }
    let mut timestamp = None;
    let mut vlan = None;
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            let h = &*header;
            if h.cmsg_level == libc::SOL_SOCKET
                && h.cmsg_type == libc::SCM_TIMESTAMPNS
                && h.cmsg_len >= libc::CMSG_LEN(size_of::<libc::timespec>() as u32) as usize
            {
                timestamp = Some(std::ptr::read_unaligned(
                    libc::CMSG_DATA(header).cast::<libc::timespec>(),
                ));
            }
            if h.cmsg_level == libc::SOL_PACKET
                && h.cmsg_type == libc::PACKET_AUXDATA
                && h.cmsg_len >= libc::CMSG_LEN(size_of::<libc::tpacket_auxdata>() as u32) as usize
            {
                let aux = std::ptr::read_unaligned(
                    libc::CMSG_DATA(header).cast::<libc::tpacket_auxdata>(),
                );
                if aux.tp_status & (1 << 4) != 0 {
                    // TP_STATUS_VLAN_VALID
                    let tpid = if aux.tp_status & (1 << 6) != 0 {
                        aux.tp_vlan_tpid
                    } else {
                        0x8100
                    };
                    vlan = Some((tpid, aux.tp_vlan_tci));
                }
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    Ok(Received::Packet(Packet {
        size: (received as usize).min(capacity),
        wire_length: received as usize,
        address,
        timestamp: timestamp.context("内核未提供报文时间戳")?,
        vlan,
    }))
}

fn global_header() -> [u8; GLOBAL_HEADER] {
    let mut header = [0u8; GLOBAL_HEADER];
    header[0..4].copy_from_slice(&0xa1b2c3d4u32.to_le_bytes());
    header[4..6].copy_from_slice(&2u16.to_le_bytes());
    header[6..8].copy_from_slice(&4u16.to_le_bytes());
    header[16..20].copy_from_slice(&(SNAPLEN as u32).to_le_bytes());
    header[20..24].copy_from_slice(&276u32.to_le_bytes()); // LINKTYPE_LINUX_SLL2
    header
}

fn encode_record(buffer: &mut [u8], packet: &Packet) -> Result<usize> {
    let vlan_size = if packet.vlan.is_some() { 4 } else { 0 };
    let size = packet.size + vlan_size;
    let captured = size + SLL2_HEADER;
    let original = packet
        .wire_length
        .checked_add(vlan_size + SLL2_HEADER)
        .context("报文长度溢出")?;
    if captured > SNAPLEN || original > u32::MAX as usize {
        bail!("报文超出 PCAP 长度范围");
    }
    let seconds = u32::try_from(packet.timestamp.tv_sec).context("时间戳超出 PCAP 秒范围")?;
    if !(0..1_000_000_000).contains(&packet.timestamp.tv_nsec) {
        bail!("内核时间戳纳秒无效");
    }
    if let Some((_, tci)) = packet.vlan {
        buffer.copy_within(PACKET_HEAD..PACKET_HEAD + packet.size, PACKET_HEAD + 4);
        buffer[PACKET_HEAD..PACKET_HEAD + 2].copy_from_slice(&tci.to_be_bytes());
        buffer[PACKET_HEAD + 2..PACKET_HEAD + 4]
            .copy_from_slice(&packet.address.sll_protocol.to_ne_bytes());
    }
    buffer[..PACKET_HEAD].fill(0);
    buffer[0..4].copy_from_slice(&seconds.to_le_bytes());
    buffer[4..8].copy_from_slice(&((packet.timestamp.tv_nsec / 1000) as u32).to_le_bytes());
    buffer[8..12].copy_from_slice(&(captured as u32).to_le_bytes());
    buffer[12..16].copy_from_slice(&(original as u32).to_le_bytes());
    let sll = &mut buffer[RECORD_HEADER..PACKET_HEAD];
    let protocol = packet
        .vlan
        .map(|(tpid, _)| tpid.to_be_bytes())
        .unwrap_or(packet.address.sll_protocol.to_ne_bytes());
    sll[0..2].copy_from_slice(&protocol);
    sll[4..8].copy_from_slice(&(packet.address.sll_ifindex as u32).to_be_bytes());
    sll[8..10].copy_from_slice(&packet.address.sll_hatype.to_be_bytes());
    sll[10] = packet.address.sll_pkttype;
    sll[11] = packet.address.sll_halen;
    let address_length = usize::from(packet.address.sll_halen).min(8);
    sll[12..12 + address_length].copy_from_slice(&packet.address.sll_addr[..address_length]);
    Ok(PACKET_HEAD + size)
}

struct SegmentWriter {
    directory: File,
    file: Option<File>,
    segment: u64,
    segment_bytes: u64,
    segment_limit: u64,
    limit: u64,
    bytes: u64,
    packets: u64,
    synced: u64,
    advised: u64,
    last_sync: Instant,
    page_size: u64,
}

impl SegmentWriter {
    fn new(directory: &Path, limit: u64, segment_limit: u64) -> Result<Self> {
        if segment_limit < (GLOBAL_HEADER + PACKET_HEAD) as u64 {
            bail!("PCAP 分段上限过小");
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory)
            .context("打开抓包运行目录")?;
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            bail!("无法读取系统页大小");
        }
        let mut writer = Self {
            directory,
            file: None,
            segment: 0,
            segment_bytes: 0,
            segment_limit,
            limit,
            bytes: 0,
            packets: 0,
            synced: 0,
            advised: 0,
            last_sync: Instant::now(),
            page_size: page_size as u64,
        };
        if limit >= GLOBAL_HEADER as u64 {
            writer.open_segment()?;
        }
        Ok(writer)
    }

    fn open_segment(&mut self) -> Result<()> {
        self.segment += 1;
        let name = CString::new(format!("capture-{:06}.pcap", self.segment))?;
        let fd = owned_fd(unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })
        .with_context(|| format!("独占创建 {}", name.to_string_lossy()))?;
        let mut file = File::from(fd);
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } < 0 {
            return Err(io::Error::last_os_error()).context("设置 PCAP 权限 0600");
        }
        if let Err(error) = file.write_all(&global_header()) {
            let _ = file.set_len(0);
            return Err(error).context("写 PCAP 文件头");
        }
        self.file = Some(file);
        self.segment_bytes = GLOBAL_HEADER as u64;
        self.bytes += GLOBAL_HEADER as u64;
        self.synced = 0;
        self.advised = 0;
        self.last_sync = Instant::now();
        Ok(())
    }

    #[cfg(test)]
    fn limited(&self) -> bool {
        let overhead = if self.segment_bytes + PACKET_HEAD as u64 > self.segment_limit {
            GLOBAL_HEADER as u64
        } else {
            0
        };
        self.file.is_none() || self.limit - self.bytes < PACKET_HEAD as u64 + overhead
    }

    #[cfg(test)]
    fn append(&mut self, record: &[u8]) -> Result<bool> {
        self.append_with_packets(record, 1)
    }

    fn append_block(&mut self, block: &PacketBlock) -> Result<bool> {
        self.append_with_packets(&block.bytes[..block.len], block.packets)
    }

    fn append_with_packets(&mut self, record: &[u8], packets: u64) -> Result<bool> {
        let length = record.len() as u64;
        if length + GLOBAL_HEADER as u64 > self.segment_limit {
            bail!("报文大于单段上限");
        }
        let rotate = self.segment_bytes + length > self.segment_limit;
        let required = length + if rotate { GLOBAL_HEADER as u64 } else { 0 };
        if self.file.is_none() || required > self.limit - self.bytes {
            return Ok(false);
        }
        if rotate {
            self.sync(true)?;
            self.file.take();
            self.open_segment()?;
        }
        if self.segment_bytes - self.synced + length >= SYNC_BYTES
            || self.last_sync.elapsed() >= INTERVAL
        {
            self.sync(false)?;
        }
        // 一个完整记录一次 write_all，写失败时截回上一条完整记录。
        let file = self.file.as_mut().expect("active segment");
        if let Err(error) = file.write_all(record) {
            let rollback = file.set_len(self.segment_bytes);
            return Err(error).with_context(|| match rollback {
                Ok(()) => "写 PCAP 报文失败，已保留完整前缀".into(),
                Err(e) => format!("写 PCAP 报文失败，截回完整前缀也失败: {e}"),
            });
        }
        self.segment_bytes += length;
        self.bytes += length;
        self.packets += packets;
        Ok(true)
    }

    fn sync(&mut self, final_sync: bool) -> Result<()> {
        if let Some(file) = &self.file {
            if self.segment_bytes != self.synced {
                file.sync_data().context("同步 PCAP 数据")?;
                self.synced = self.segment_bytes;
            }
            // 活动段只回收完整页。最后一页在后续批次或关闭时回收。
            let end = if final_sync {
                self.segment_bytes.div_ceil(self.page_size) * self.page_size
            } else {
                self.segment_bytes / self.page_size * self.page_size
            };
            if end > self.advised {
                let result = unsafe {
                    libc::posix_fadvise(
                        file.as_raw_fd(),
                        self.advised as libc::off_t,
                        (end - self.advised) as libc::off_t,
                        libc::POSIX_FADV_DONTNEED,
                    )
                };
                if result != 0 {
                    return Err(io::Error::from_raw_os_error(result)).context("回收 PCAP 文件缓存");
                }
                self.advised = end;
            }
        }
        self.last_sync = Instant::now();
        Ok(())
    }
}

#[derive(Debug)]
struct PacketBlock {
    bytes: Box<[u8; BLOCK_BYTES]>,
    len: usize,
    packets: u64,
}

impl PacketBlock {
    fn new() -> Self {
        let bytes = vec![0u8; BLOCK_BYTES]
            .into_boxed_slice()
            .try_into()
            .expect("固定抓包块大小正确");
        Self {
            bytes,
            len: 0,
            packets: 0,
        }
    }
}

struct QueueState {
    free: VecDeque<PacketBlock>,
    ready: VecDeque<PacketBlock>,
    closed: bool,
}

struct PacketQueue {
    state: Mutex<QueueState>,
    ready: Condvar,
}

enum QueueWait {
    Block(PacketBlock),
    Timeout,
    Closed,
}

impl PacketQueue {
    fn new() -> Self {
        let mut free = VecDeque::with_capacity(BLOCK_COUNT);
        for _ in 0..BLOCK_COUNT {
            free.push_back(PacketBlock::new());
        }
        Self {
            state: Mutex::new(QueueState {
                free,
                ready: VecDeque::with_capacity(BLOCK_COUNT),
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn try_take_free(&self) -> Option<PacketBlock> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut block = state.free.pop_front();
        if let Some(block) = &mut block {
            block.len = 0;
            block.packets = 0;
        }
        block
    }

    fn enqueue(&self, block: PacketBlock) -> std::result::Result<(), PacketBlock> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(block);
        }
        state.ready.push_back(block);
        self.ready.notify_one();
        Ok(())
    }

    fn take(&self, timeout: Duration) -> QueueWait {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(block) = state.ready.pop_front() {
                return QueueWait::Block(block);
            }
            if state.closed {
                return QueueWait::Closed;
            }
            let (next, result) = self
                .ready
                .wait_timeout(state, timeout)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
            if result.timed_out() {
                return QueueWait::Timeout;
            }
        }
    }

    fn recycle(&self, block: PacketBlock) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .free
            .push_back(block);
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        self.ready.notify_one();
    }
}

fn publish_writer(shared: &Shared, writer: &SegmentWriter) {
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    status.segments = writer.segment;
    status.bytes = writer.bytes;
    status.packets = writer.packets;
}

fn mark_error(shared: &Shared, error: impl Into<String>) {
    let error = error.into();
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    status.state = "error".into();
    status.error = Some(match status.error.take() {
        Some(previous) if previous != error => format!("{previous}; {error}"),
        _ => error,
    });
}

fn mark_limited(shared: &Shared, error: impl Into<String>) {
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    if status.state != "error" {
        status.state = "limited".into();
        status.error = Some(error.into());
    }
}

fn mark_degraded(shared: &Shared, error: impl Into<String>) {
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(status.state.as_str(), "running" | "stopped" | "degraded") {
        status.state = "degraded".into();
        status.error = Some(error.into());
    }
}

fn mark_queue_drop(shared: &Shared) {
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    status.queue_drops = status.queue_drops.saturating_add(1);
    if matches!(status.state.as_str(), "running" | "stopped" | "degraded") {
        status.state = "degraded".into();
        status.error = Some("用户态抓包队列已满，丢弃报文".into());
    }
}

fn record_kernel_drops(fd: RawFd, shared: &Shared) -> Result<()> {
    let drops = kernel_drops(fd)?;
    if drops == 0 {
        return Ok(());
    }
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    status.kernel_drops = status.kernel_drops.saturating_add(drops);
    if matches!(status.state.as_str(), "running" | "stopped" | "degraded") {
        status.state = "degraded".into();
        status.error = Some("内核抓包接收缓冲丢包".into());
    }
    Ok(())
}

fn finish_status(shared: &Shared) {
    let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
    if status.state == "running" {
        status.state = "stopped".into();
    }
}

fn worker(
    namespace: File,
    directory: PathBuf,
    limit: u64,
    shared: Arc<Shared>,
    ready: &mpsc::SyncSender<std::result::Result<(), String>>,
) -> Result<()> {
    if shared.stop.load(Ordering::Acquire) {
        bail!("抓包初始化已取消");
    }
    if unsafe { libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNET) } != 0 {
        return Err(io::Error::last_os_error()).context("进入目标网络命名空间，需要 CAP_SYS_ADMIN");
    }
    drop(namespace);
    let socket = packet_socket()?;
    if shared.stop.load(Ordering::Acquire) {
        bail!("抓包初始化已取消");
    }
    let writer = SegmentWriter::new(&directory, limit, SEGMENT_BYTES)?;
    {
        let mut status = shared.status.lock().unwrap_or_else(|e| e.into_inner());
        status.state = "running".into();
        status.error = None;
    }
    publish_writer(&shared, &writer);
    if ready.send(Ok(())).is_err() {
        request_abort(&shared);
    }
    let result = run_capture_threads(socket.as_raw_fd(), shared.clone(), writer, DRAIN_BUDGET);
    if let Err(error) = &result {
        mark_error(&shared, format!("{error:#}"));
    }
    let drops_result = record_kernel_drops(socket.as_raw_fd(), &shared);
    if let Err(error) = &drops_result {
        mark_error(&shared, format!("{error:#}"));
    }
    finish_status(&shared);
    result?;
    drops_result
}

fn receiver_loop(
    fd: RawFd,
    shared: &Shared,
    queue: &PacketQueue,
    drain_budget: Duration,
) -> Result<()> {
    let mut buffer = vec![0u8; RECEIVE_BYTES];
    let mut current: Option<PacketBlock> = None;
    let mut flush_deadline = None;
    let mut last_status = Instant::now();
    let mut drain_deadline = None;
    loop {
        if shared.abort.load(Ordering::Acquire) {
            return Ok(());
        }
        if shared.stop.load(Ordering::Acquire) {
            drain_deadline.get_or_insert_with(|| Instant::now() + drain_budget);
        }
        if last_status.elapsed() >= INTERVAL {
            record_kernel_drops(fd, shared)?;
            last_status = Instant::now();
        }
        // 保留跨 poll/收包批次的未满块，低流量按首条记录的期限刷新。
        if current
            .as_ref()
            .is_some_and(|block| block.len == BLOCK_BYTES)
            || flush_deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            if let Some(block) = current.take() {
                if queue.enqueue(block).is_err() {
                    return Ok(());
                }
            }
            flush_deadline = None;
        }
        if drain_deadline.is_none() {
            let mut remaining = INTERVAL.saturating_sub(last_status.elapsed());
            if let Some(deadline) = flush_deadline {
                remaining = remaining.min(deadline.saturating_duration_since(Instant::now()));
            }
            let mut fds = [
                libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: shared.wake.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let result = unsafe {
                libc::poll(
                    fds.as_mut_ptr(),
                    fds.len() as libc::nfds_t,
                    remaining.as_millis().max(1) as i32,
                )
            };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error).context("等待抓包 socket");
            }
            if shared.stop.load(Ordering::Acquire) || fds[1].revents & libc::POLLIN != 0 {
                continue;
            }
            if fds
                .iter()
                .any(|p| p.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0)
            {
                bail!("抓包 poll 描述符异常");
            }
            if fds[0].revents & libc::POLLIN == 0 {
                continue;
            }
        }
        for _ in 0..64 {
            if shared.abort.load(Ordering::Acquire) {
                return Ok(());
            }
            if drain_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                bail!(
                    "取消后抓包接收队列在 {} 毫秒内未确认排空，PCAP 可能缺少尾包",
                    drain_budget.as_millis()
                );
            }
            let packet = match receive(fd, &mut buffer)? {
                Received::Packet(packet) => packet,
                Received::Empty if drain_deadline.is_some() => {
                    if let Some(block) = current.take() {
                        if queue.enqueue(block).is_err() {
                            return Ok(());
                        }
                    }
                    return Ok(());
                }
                Received::Empty => break,
                Received::Interrupted => continue,
            };
            let needed = PACKET_HEAD + packet.size + usize::from(packet.vlan.is_some()) * 4;
            if current
                .as_ref()
                .is_some_and(|block| block.len + needed > BLOCK_BYTES)
            {
                if let Some(block) = current.take() {
                    if queue.enqueue(block).is_err() {
                        return Ok(());
                    }
                }
            }
            if current.is_none() {
                current = queue.try_take_free();
                if current.is_none() {
                    mark_queue_drop(shared);
                    continue;
                }
                flush_deadline = Some(Instant::now() + BLOCK_FLUSH_INTERVAL);
            }
            let block = current.as_mut().expect("当前抓包块已准备");
            let offset = block.len;
            block.bytes[offset + PACKET_HEAD..offset + PACKET_HEAD + packet.size]
                .copy_from_slice(&buffer[..packet.size]);
            block.len = offset + encode_record(&mut block.bytes[offset..], &packet)?;
            block.packets += 1;
            if packet.size != packet.wire_length {
                mark_degraded(
                    shared,
                    format!(
                        "报文长度 {} 超出采集 snaplen {}",
                        packet.wire_length, SNAPLEN
                    ),
                );
            }
        }
    }
}

fn receiver_thread(
    fd: RawFd,
    shared: Arc<Shared>,
    queue: Arc<PacketQueue>,
    drain_budget: Duration,
) -> Result<()> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        receiver_loop(fd, &shared, &queue, drain_budget)
    }));
    let result = match result {
        Ok(result) => result,
        Err(_) => Err(anyhow!("抓包接收线程发生 panic")),
    };
    if let Err(error) = &result {
        mark_error(&shared, format!("{error:#}"));
        request_abort(&shared);
    }
    queue.close();
    result
}

fn writer_loop(shared: &Shared, queue: &PacketQueue, mut writer: SegmentWriter) -> Result<()> {
    let mut errors = Vec::new();
    let mut discard = false;
    let mut last_publish = Instant::now();
    loop {
        match queue.take(INTERVAL) {
            QueueWait::Block(block) => {
                if !discard {
                    match writer.append_block(&block) {
                        Ok(true) => {}
                        Ok(false) => {
                            let message = format!(
                                "下一条完整报文超出 PCAP 配额（上限 {} 字节）",
                                writer.limit
                            );
                            mark_limited(shared, message);
                            request_abort(shared);
                            discard = true;
                        }
                        Err(error) => {
                            let message = format!("{error:#}");
                            mark_error(shared, message.clone());
                            request_abort(shared);
                            errors.push(message);
                            discard = true;
                        }
                    }
                }
                queue.recycle(block);
                if last_publish.elapsed() >= INTERVAL {
                    publish_writer(shared, &writer);
                    last_publish = Instant::now();
                }
            }
            QueueWait::Timeout => {
                if !discard {
                    if let Err(error) = writer.sync(false) {
                        let message = format!("{error:#}");
                        mark_error(shared, message.clone());
                        request_abort(shared);
                        errors.push(message);
                        discard = true;
                    }
                }
                publish_writer(shared, &writer);
                last_publish = Instant::now();
            }
            QueueWait::Closed => break,
        }
    }
    if let Err(error) = writer.sync(true) {
        let message = format!("{error:#}");
        mark_error(shared, message.clone());
        errors.push(message);
    }
    publish_writer(shared, &writer);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(errors.join("; ")))
    }
}

fn writer_thread(
    shared: Arc<Shared>,
    queue: Arc<PacketQueue>,
    writer: SegmentWriter,
) -> Result<()> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        writer_loop(&shared, &queue, writer)
    }));
    match result {
        Ok(result) => {
            if let Err(error) = &result {
                mark_error(&shared, format!("{error:#}"));
                request_abort(&shared);
            }
            result
        }
        Err(_) => {
            let error = anyhow!("PCAP 写线程发生 panic");
            mark_error(&shared, format!("{error:#}"));
            request_abort(&shared);
            Err(error)
        }
    }
}

fn run_capture_threads(
    fd: RawFd,
    shared: Arc<Shared>,
    writer: SegmentWriter,
    drain_budget: Duration,
) -> Result<()> {
    let queue = Arc::new(PacketQueue::new());
    let writer_shared = shared.clone();
    let writer_queue = queue.clone();
    let writer = match thread::Builder::new()
        .name("pcap-writer".into())
        .stack_size(1024 * 1024)
        .spawn(move || writer_thread(writer_shared, writer_queue, writer))
    {
        Ok(writer) => writer,
        Err(error) => {
            request_abort(&shared);
            queue.close();
            return Err(error).context("启动 PCAP 写线程");
        }
    };
    let receiver_result = receiver_thread(fd, shared, queue.clone(), drain_budget);
    let writer_result = writer.join().map_err(|_| anyhow!("PCAP 写线程异常退出"))?;
    receiver_result?;
    writer_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::atomic::AtomicU64;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "runner-capture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn record(payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; PACKET_HEAD + payload.len() + 4];
        bytes[PACKET_HEAD..PACKET_HEAD + payload.len()].copy_from_slice(payload);
        let mut address: libc::sockaddr_ll = unsafe { zeroed() };
        address.sll_protocol = 0x0800u16.to_be();
        address.sll_ifindex = 42;
        address.sll_hatype = 1;
        address.sll_pkttype = 4;
        address.sll_halen = 6;
        address.sll_addr = [1, 2, 3, 4, 5, 6, 0, 0];
        let packet = Packet {
            size: payload.len(),
            wire_length: payload.len(),
            address,
            timestamp: libc::timespec {
                tv_sec: 1_700_000_000,
                tv_nsec: 123_456_789,
            },
            vlan: None,
        };
        let size = encode_record(&mut bytes, &packet).unwrap();
        bytes.truncate(size);
        bytes
    }

    #[test]
    fn pcap_sll2_format_and_byte_order() {
        let header = global_header();
        assert_eq!(&header[..8], &[0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0]);
        assert_eq!(u32::from_le_bytes(header[20..24].try_into().unwrap()), 276);
        let packet = record(&[0x45, 0x00, 0xab]);
        assert_eq!(
            u32::from_le_bytes(packet[..4].try_into().unwrap()),
            1_700_000_000
        );
        assert_eq!(
            u32::from_le_bytes(packet[4..8].try_into().unwrap()),
            123_456
        );
        assert_eq!(&packet[8..16], &[23, 0, 0, 0, 23, 0, 0, 0]);
        assert_eq!(
            &packet[16..36],
            &[8, 0, 0, 0, 0, 0, 0, 42, 0, 1, 4, 6, 1, 2, 3, 4, 5, 6, 0, 0]
        );
        assert_eq!(&packet[36..], &[0x45, 0x00, 0xab]);
    }

    #[test]
    fn vlan_offload_metadata_restores_tag() {
        let mut buffer = vec![0u8; 64];
        buffer[PACKET_HEAD..PACKET_HEAD + 2].copy_from_slice(&[0x45, 0x00]);
        let mut address: libc::sockaddr_ll = unsafe { zeroed() };
        address.sll_protocol = 0x0800u16.to_be();
        let packet = Packet {
            size: 2,
            wire_length: 2,
            address,
            timestamp: libc::timespec {
                tv_sec: 1,
                tv_nsec: 0,
            },
            vlan: Some((0x8100, 123)),
        };
        let size = encode_record(&mut buffer, &packet).unwrap();
        assert_eq!(&buffer[16..18], &[0x81, 0]);
        assert_eq!(&buffer[36..size], &[0, 123, 8, 0, 0x45, 0]);
        assert_eq!(buffer[8], 26);
    }

    #[test]
    fn quota_counts_headers_and_never_writes_partial_record() {
        let directory = TestDirectory::new();
        let packet = record(&[1; 10]);
        let limit = GLOBAL_HEADER as u64 + packet.len() as u64;
        let mut writer = SegmentWriter::new(&directory.0, limit, SEGMENT_BYTES).unwrap();
        assert!(writer.append(&packet).unwrap());
        assert!(writer.limited());
        assert!(!writer.append(&packet).unwrap());
        writer.sync(true).unwrap();
        assert_eq!(writer.bytes, limit);
        assert_eq!(writer.packets, 1);
        let file = directory.0.join("capture-000001.pcap");
        let bytes = std::fs::read(&file).unwrap();
        assert_eq!(bytes.len() as u64, limit);
        assert_eq!(&bytes[24..], packet);
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn segments_include_independent_headers_and_respect_total_quota() {
        let directory = TestDirectory::new();
        let packet = record(&[7; 4]);
        let segment = (GLOBAL_HEADER + packet.len()) as u64;
        let limit = segment * 2 + GLOBAL_HEADER as u64 - 1;
        let mut writer = SegmentWriter::new(&directory.0, limit, segment).unwrap();
        assert!(writer.append(&packet).unwrap());
        assert!(writer.append(&packet).unwrap());
        assert!(!writer.append(&packet).unwrap());
        writer.sync(true).unwrap();
        assert_eq!(writer.bytes, segment * 2);
        assert_eq!(writer.packets, 2);
        for number in 1..=2 {
            let bytes =
                std::fs::read(directory.0.join(format!("capture-{number:06}.pcap"))).unwrap();
            assert_eq!(&bytes[..24], global_header());
            assert_eq!(&bytes[24..], packet);
        }
        assert!(!directory.0.join("capture-000003.pcap").exists());
    }

    #[test]
    fn insufficient_quota_does_not_exceed_limit() {
        for limit in [0, 23, 24, 25, 59] {
            let directory = TestDirectory::new();
            let mut writer = SegmentWriter::new(&directory.0, limit, SEGMENT_BYTES).unwrap();
            assert!(writer.limited());
            assert!(!writer.append(&record(&[0; 64])).unwrap());
            writer.sync(true).unwrap();
            assert!(writer.bytes <= limit);
        }
    }

    #[test]
    fn existing_files_and_symlinks_are_never_overwritten() {
        let directory = TestDirectory::new();
        let target = directory.0.join("original");
        let capture = directory.0.join("capture-000001.pcap");
        std::fs::write(&target, b"preserved").unwrap();
        symlink(&target, &capture).unwrap();
        assert!(SegmentWriter::new(&directory.0, 4096, SEGMENT_BYTES).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"preserved");
        std::fs::remove_file(&capture).unwrap();
        std::fs::write(&capture, b"old capture").unwrap();
        assert!(SegmentWriter::new(&directory.0, 4096, SEGMENT_BYTES).is_err());
        assert_eq!(std::fs::read(&capture).unwrap(), b"old capture");
        let link = directory.0.join("linked-directory");
        symlink(&directory.0, &link).unwrap();
        assert!(SegmentWriter::new(&link, 4096, SEGMENT_BYTES).is_err());
    }

    #[test]
    fn truncated_record_keeps_original_wire_length() {
        let mut buffer = vec![0u8; 64];
        let packet = Packet {
            size: 3,
            wire_length: 300_000,
            address: unsafe { zeroed() },
            timestamp: libc::timespec {
                tv_sec: 1,
                tv_nsec: 0,
            },
            vlan: None,
        };
        let size = encode_record(&mut buffer, &packet).unwrap();
        assert_eq!(size, PACKET_HEAD + 3);
        assert_eq!(u32::from_le_bytes(buffer[8..12].try_into().unwrap()), 23);
        assert_eq!(
            u32::from_le_bytes(buffer[12..16].try_into().unwrap()),
            300_020
        );
    }

    #[test]
    fn sync_batches_stay_below_eight_mib_and_only_advise_complete_pages() {
        let directory = TestDirectory::new();
        let mut writer = SegmentWriter::new(&directory.0, 16 * 1024 * 1024, SEGMENT_BYTES).unwrap();
        let packet = record(&[0; 1400]);
        for _ in 0..7000 {
            assert!(writer.append(&packet).unwrap());
            assert!(writer.segment_bytes - writer.synced < SYNC_BYTES);
            assert!(writer.advised <= writer.segment_bytes);
            assert_eq!(writer.advised % writer.page_size, 0);
        }
        assert!(writer.synced > 0);
        writer.sync(true).unwrap();
        assert_eq!(writer.synced, writer.segment_bytes);
        assert!(writer.advised >= writer.segment_bytes);
    }

    #[test]
    fn receiver_fills_blocks_across_batches_before_queue_overflow() {
        use std::os::unix::net::UnixDatagram;

        let (socket, sender) = UnixDatagram::pair().unwrap();
        socket.set_nonblocking(true).unwrap();
        set_option(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_TIMESTAMPNS,
            &1i32,
        )
        .unwrap();
        sender
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let queue = Arc::new(PacketQueue::new());
        let mut capture = cancellable_test_capture();
        let shared = capture.shared.clone();
        let receiver_queue = queue.clone();
        capture.thread = Some(thread::spawn(move || {
            receiver_thread(socket.as_raw_fd(), shared, receiver_queue, DRAIN_BUDGET).unwrap();
        }));

        // 不启动 writer，以真实记录填满整个块池，跨越许多 64 包批次。
        let payload = [0x5a; 1400];
        let record_bytes = PACKET_HEAD + payload.len();
        let packets_per_block = BLOCK_BYTES / record_bytes;
        let count = packets_per_block * BLOCK_COUNT;
        for _ in 0..count {
            assert_eq!(sender.send(&payload).unwrap(), payload.len());
        }
        capture.request_stop();
        capture.thread.take().unwrap().join().unwrap();
        assert_eq!(capture.status().queue_drops, 0);

        let state = queue.state.lock().unwrap();
        assert_eq!(state.ready.len(), BLOCK_COUNT);
        let mut packets = 0;
        let mut buffered_bytes = 0;
        for block in &state.ready {
            assert_eq!(block.packets, packets_per_block as u64);
            assert_eq!(block.len, packets_per_block * record_bytes);
            // 验证实际有效字节，而非 Vec 容量或名义内存配额。
            assert!(block.len * 100 >= BLOCK_BYTES * 99);
            for record in block.bytes[..block.len].chunks_exact(record_bytes) {
                assert_eq!(
                    u32::from_le_bytes(record[8..12].try_into().unwrap()) as usize,
                    SLL2_HEADER + payload.len()
                );
                assert_eq!(&record[PACKET_HEAD..], &payload);
            }
            packets += block.packets;
            buffered_bytes += block.len;
        }
        assert_eq!(packets, count as u64);
        assert!(buffered_bytes * 100 >= BLOCK_COUNT * BLOCK_BYTES * 99);
    }

    #[test]
    fn short_stream_flushes_without_more_packets_or_cancellation() {
        let socket = queued_udp(3);
        let queue = Arc::new(PacketQueue::new());
        let mut capture = cancellable_test_capture();
        let shared = capture.shared.clone();
        let receiver_queue = queue.clone();
        let started = Instant::now();
        capture.thread = Some(thread::spawn(move || {
            receiver_thread(socket.as_raw_fd(), shared, receiver_queue, DRAIN_BUDGET).unwrap();
        }));
        let flushed = queue.take(Duration::from_millis(500));
        let elapsed = started.elapsed();
        capture.request_stop();
        capture.thread.take().unwrap().join().unwrap();
        let QueueWait::Block(block) = flushed else {
            panic!("短流应在 poll 超时后刷新，无需等到状态更新或取消");
        };
        assert!(elapsed >= BLOCK_FLUSH_INTERVAL);
        assert!(elapsed < Duration::from_millis(500));
        assert_eq!(block.packets, 3);
        assert_eq!(block.len, 3 * (PACKET_HEAD + 4));
        for (sequence, record) in block.bytes[..block.len]
            .chunks_exact(PACKET_HEAD + 4)
            .enumerate()
        {
            assert_eq!(&record[PACKET_HEAD..], &(sequence as u32).to_be_bytes());
        }
        assert_eq!(capture.status().queue_drops, 0);
    }

    #[test]
    fn maximum_datagrams_reserve_cooked_headers_and_preserve_wire_length() {
        use std::os::unix::net::UnixDatagram;

        let (socket, sender) = UnixDatagram::pair().unwrap();
        set_option(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_TIMESTAMPNS,
            &1i32,
        )
        .unwrap();
        set_option(
            sender.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            &(SNAPLEN as i32 * 2),
        )
        .unwrap();
        for wire_length in [
            RECEIVE_BYTES - 1,
            RECEIVE_BYTES,
            RECEIVE_BYTES + 1,
            SNAPLEN + 64,
        ] {
            for vlan in [None, Some((0x8100, 123))] {
                let payload = vec![0x5a; wire_length];
                assert_eq!(sender.send(&payload).unwrap(), wire_length);
                // 即使调用方给出整个 snaplen，receive 也必须预留头部空间。
                let mut buffer = vec![0u8; SNAPLEN];
                let Received::Packet(mut packet) =
                    receive(socket.as_raw_fd(), &mut buffer).unwrap()
                else {
                    panic!("预期收到最大长度报文");
                };
                assert_eq!(packet.size, wire_length.min(RECEIVE_BYTES));
                assert_eq!(packet.wire_length, wire_length);
                packet.vlan = vlan;
                packet.address.sll_protocol = u16::from_ne_bytes([0x08, 0x00]);
                let mut record = vec![0u8; RECORD_HEADER + SNAPLEN];
                record[PACKET_HEAD..PACKET_HEAD + packet.size]
                    .copy_from_slice(&buffer[..packet.size]);
                let size = encode_record(&mut record, &packet).unwrap();
                let vlan_size = usize::from(vlan.is_some()) * 4;
                let captured = u32::from_le_bytes(record[8..12].try_into().unwrap()) as usize;
                let original = u32::from_le_bytes(record[12..16].try_into().unwrap()) as usize;
                assert_eq!(captured, packet.size + SLL2_HEADER + vlan_size);
                assert!(captured <= SNAPLEN);
                assert_eq!(original, wire_length + SLL2_HEADER + vlan_size);
                assert_eq!(size, RECORD_HEADER + captured);
                assert_eq!(
                    &record[PACKET_HEAD + vlan_size..size],
                    &payload[..packet.size]
                );
                if vlan.is_some() && wire_length >= RECEIVE_BYTES {
                    assert_eq!(captured, SNAPLEN);
                    assert_eq!(&record[PACKET_HEAD..PACKET_HEAD + 4], &[0, 123, 0x08, 0]);
                }
            }
        }
    }

    #[test]
    fn full_bounded_queue_counts_drops_and_keeps_receiving() {
        let queue = PacketQueue::new();
        for _ in 0..BLOCK_COUNT {
            let block = queue.try_take_free().unwrap();
            queue.enqueue(block).unwrap();
        }
        let socket = queued_udp(3);
        let capture = cancellable_test_capture();
        capture.request_stop();
        receiver_loop(socket.as_raw_fd(), &capture.shared, &queue, DRAIN_BUDGET).unwrap();
        let status = capture.status();
        assert_eq!(status.queue_drops, 3);
        assert_eq!(status.state, "degraded");
        assert!(status.error.unwrap().contains("队列已满"));
    }

    #[test]
    fn writer_failure_is_published_and_stops_receiver() {
        let directory = TestDirectory::new();
        let mut writer = SegmentWriter::new(&directory.0, 1024 * 1024, SEGMENT_BYTES).unwrap();
        let queue = PacketQueue::new();
        let mut block = queue.try_take_free().unwrap();
        let packet = record(&[1, 2, 3]);
        block.bytes[..packet.len()].copy_from_slice(&packet);
        block.len = packet.len();
        block.packets = 1;
        queue.enqueue(block).unwrap();
        queue.close();
        let file = directory.0.join("capture-000001.pcap");
        writer.file = Some(OpenOptions::new().read(true).open(file).unwrap());
        let capture = cancellable_test_capture();
        let error = writer_loop(&capture.shared, &queue, writer).unwrap_err();
        let status = capture.status();
        assert!(error.to_string().contains("写 PCAP 报文失败"));
        assert_eq!(status.state, "error");
        assert!(status.error.unwrap().contains("写 PCAP 报文失败"));
        assert!(capture.shared.abort.load(Ordering::Acquire));
    }

    fn cancellable_test_capture() -> Capture {
        Capture {
            shared: Arc::new(Shared {
                status: Mutex::new(CaptureStatus {
                    segments: 0,
                    state: "running".into(),
                    error: None,
                    packets: 0,
                    bytes: 0,
                    kernel_drops: 0,
                    queue_drops: 0,
                }),
                stop: AtomicBool::new(false),
                abort: AtomicBool::new(false),
                wake: owned_fd(unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) })
                    .unwrap(),
            }),
            thread: None,
        }
    }

    fn queued_udp(count: u32) -> std::net::UdpSocket {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        set_option(
            receiver.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_TIMESTAMPNS,
            &1i32,
        )
        .unwrap();
        let sender = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        for sequence in 0..count {
            sender
                .send_to(&sequence.to_be_bytes(), receiver.local_addr().unwrap())
                .unwrap();
        }
        receiver
    }

    #[test]
    fn cancellation_drains_multiple_batches_to_eagain() {
        let directory = TestDirectory::new();
        let writer = SegmentWriter::new(&directory.0, 1024 * 1024, SEGMENT_BYTES).unwrap();
        let socket = queued_udp(128);
        let capture = cancellable_test_capture();
        capture.request_stop();
        run_capture_threads(
            socket.as_raw_fd(),
            capture.shared.clone(),
            writer,
            DRAIN_BUDGET,
        )
        .unwrap();
        finish_status(&capture.shared);
        assert_eq!(capture.status().packets, 128);
        let bytes = std::fs::read(directory.0.join("capture-000001.pcap")).unwrap();
        let mut sequences = Vec::new();
        let mut offset = GLOBAL_HEADER;
        while offset < bytes.len() {
            let length =
                u32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) as usize;
            sequences.push(u32::from_be_bytes(
                bytes[offset + PACKET_HEAD..offset + RECORD_HEADER + length]
                    .try_into()
                    .unwrap(),
            ));
            offset += RECORD_HEADER + length;
        }
        assert_eq!(sequences, (0..128).collect::<Vec<_>>());
        assert!(matches!(
            receive(socket.as_raw_fd(), &mut [0; 64]).unwrap(),
            Received::Empty
        ));
    }

    #[test]
    fn drain_deadline_reports_incomplete_even_without_kernel_drops() {
        let directory = TestDirectory::new();
        let writer = SegmentWriter::new(&directory.0, 1024 * 1024, SEGMENT_BYTES).unwrap();
        let socket = queued_udp(1);
        let capture = cancellable_test_capture();
        capture.request_stop();
        let started = Instant::now();
        // 零预算稳定覆盖截止点分支，不依赖机器速度或流量调度。
        let error = run_capture_threads(
            socket.as_raw_fd(),
            capture.shared.clone(),
            writer,
            Duration::ZERO,
        )
        .unwrap_err();
        assert!(error.to_string().contains("未确认排空"));
        assert_eq!(capture.status().kernel_drops, 0);
        assert_eq!(capture.status().packets, 0);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// 真正 AF_PACKET 回归：发送端突发后立即退出，应用收齐后立即取消采集。
    #[test]
    #[ignore = "需要隔离 netns 和 CAP_NET_RAW"]
    fn udp_burst_immediate_stop_preserves_pcap_sequences() {
        let directory = TestDirectory::new();
        assert_ne!(
            std::fs::read_link("/proc/self/ns/net").unwrap(),
            std::fs::read_link("/proc/1/ns/net").unwrap(),
            "请在单独的 unshare --net 环境中运行"
        );
        let socket = packet_socket().unwrap();
        let writer = SegmentWriter::new(&directory.0, 1024 * 1024, SEGMENT_BYTES).unwrap();
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let destination = receiver.local_addr().unwrap();
        let sender = thread::spawn(move || {
            let sender = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            for sequence in 0..128u32 {
                sender
                    .send_to(&sequence.to_be_bytes(), destination)
                    .unwrap();
            }
            // 无 sleep 或额外流量，发完立即关闭发送端。
        });
        let mut received = Vec::new();
        for _ in 0..128 {
            let mut payload = [0; 4];
            assert_eq!(receiver.recv(&mut payload).unwrap(), 4);
            received.push(u32::from_be_bytes(payload));
        }
        let capture = cancellable_test_capture();
        capture.request_stop();
        // 故意让采集线程在取消后才开始读取，保证尾包已排队。
        run_capture_threads(
            socket.as_raw_fd(),
            capture.shared.clone(),
            writer,
            DRAIN_BUDGET,
        )
        .unwrap();
        record_kernel_drops(socket.as_raw_fd(), &capture.shared).unwrap();
        finish_status(&capture.shared);
        sender.join().unwrap();
        let bytes = std::fs::read(directory.0.join("capture-000001.pcap")).unwrap();
        let mut captured = Vec::new();
        let mut offset = GLOBAL_HEADER;
        while offset < bytes.len() {
            let length =
                u32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) as usize;
            let record = &bytes[offset + RECORD_HEADER..offset + RECORD_HEADER + length];
            if record[..2] == [0x08, 0x00] && record.len() >= SLL2_HEADER + 20 {
                let ip = &record[SLL2_HEADER..];
                let header = (ip[0] as usize & 15) * 4;
                if ip[9] == 17 && ip.len() >= header + 12 {
                    let udp = &ip[header..];
                    if u16::from_be_bytes(udp[2..4].try_into().unwrap()) == destination.port()
                        && udp[4..6] == [0, 12]
                    {
                        captured.push(u32::from_be_bytes(udp[8..12].try_into().unwrap()));
                    }
                }
            }
            offset += RECORD_HEADER + length;
        }
        assert_eq!(received, (0..128).collect::<Vec<_>>());
        assert_eq!(
            captured,
            received.iter().flat_map(|n| [*n, *n]).collect::<Vec<_>>()
        );
        assert_eq!(capture.status().kernel_drops, 0);
        println!(
            "UDP 收齐 {} 包，PCAP 序号全部一致，kernel_drops=0",
            received.len()
        );
    }

    #[test]
    fn initialization_error_is_prompt() {
        let directory = TestDirectory::new();
        let started = Instant::now();
        assert!(start(File::open("/dev/null").unwrap(), &directory.0, 4096).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
