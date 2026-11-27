//! 位置契约的最小解析器：`file:///abs` 与 `ssh://<设备名>/abs`。
//!
//! 规则以 `packages/location/src/index.ts` 的 `parse` 为准，测试向量两边共用
//! `packages/location/vectors.json`。这里只做解析，不做 `~` 展开、不构造、不派生。
//! 不经 URL 解析器：OpenSSH 的 Host 别名大小写敏感，设备名必须原样保留。
//!
//! `parse` 目前只由共享测试向量覆盖：按位置 URI 寻址的调用方是后续接入的远程目录
//! provider，本服务内没有生产调用点。它是契约的一部分，不是遗留代码。

use percent_encoding::percent_decode_str;

/// 解析结果：scheme、设备名（本机为 `None`）与设备内绝对路径。
#[allow(dead_code)] // 见模块文档：parse 尚无生产调用方
pub type Location = (Scheme, Option<String>, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // 见模块文档：parse 尚无生产调用方
pub enum Scheme {
    File,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // 见模块文档：parse 尚无生产调用方
pub enum LocationError {
    /// 空输入、`file://` 后带设备名、路径段编码非法。
    InvalidUri,
    /// `file`、`ssh` 之外的 scheme。
    UnsupportedScheme,
    /// `ssh://` 缺少设备名，或设备名不符合白名单。
    BadDevice,
    /// 没有 `://` 时输入不是绝对路径。本解析器不展开 `~`，`~` 与 `~/x` 也落在这里。
    RelativePath,
}

/// 设备名规则：ssh-web 的连接名。首字符限字母数字，其后允许点、下划线、短横线。
/// 不出现 `user@`、`:port`，那些归连接命令表达。按名寻址的接口（`by-name/{name}`）
/// 也用它校验路径参数。
pub fn is_valid_device(device: &str) -> bool {
    let mut chars = device.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 解析位置 URI 或本机路径简写。
///
/// - `file:///abs`、`file://localhost/abs`、`/abs` 解析为本机位置。
/// - `ssh://<device>/abs` 解析为远程位置，设备名大小写原样保留。
/// - 其它 scheme 报 `UnsupportedScheme`；相对路径报 `RelativePath`。
#[allow(dead_code)] // 见模块文档：parse 尚无生产调用方
pub fn parse(input: &str) -> Result<Location, LocationError> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(LocationError::InvalidUri);
    }

    let Some(scheme_end) = raw.find("://") else {
        // 本机路径简写：必须是绝对路径。这里不展开 `~`，`~` 与 `~/x` 按 JS 侧未提供 home 时同样拒绝。
        if !raw.starts_with('/') {
            return Err(LocationError::RelativePath);
        }
        let segments = decoded_segments(raw)?;
        return Ok((Scheme::File, None, normalize_path(&segments)));
    };

    let scheme = match &raw[..scheme_end] {
        "file" => Scheme::File,
        "ssh" => Scheme::Ssh,
        _ => return Err(LocationError::UnsupportedScheme),
    };
    let rest = &raw[scheme_end + 3..];

    let (authority, encoded_path) = match rest.find('/') {
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, ""),
    };

    match scheme {
        Scheme::File => {
            if !authority.is_empty() && authority != "localhost" {
                return Err(LocationError::InvalidUri);
            }
            Ok((Scheme::File, None, normalize_path(&decoded_segments(encoded_path)?)))
        }
        Scheme::Ssh => {
            if authority.is_empty() {
                return Err(LocationError::BadDevice);
            }
            if !is_valid_device(authority) {
                return Err(LocationError::BadDevice);
            }
            Ok((
                Scheme::Ssh,
                Some(authority.to_string()),
                normalize_path(&decoded_segments(encoded_path)?),
            ))
        }
    }
}

/// 把 `/a%20b/c` 形态的编码路径拆成解码后的段；空段（连续斜杠）先丢弃。
fn decoded_segments(encoded_path: &str) -> Result<Vec<String>, LocationError> {
    encoded_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(decode_path)
        .collect()
}

/// 严格 percent-decode，语义对齐 JS 的 `decodeURIComponent`：
/// 残缺的 `%`、非十六进制的转义都报 `InvalidUri`；解码后的字节必须构成合法 UTF-8。
///
/// `percent_decode_str` 本身是宽松的（非法转义原样放行），所以先逐字符核对 `%` 后面
/// 恰好跟两位十六进制，再把整段交给它解码。
fn decode_path(segment: &str) -> Result<String, LocationError> {
    check_percent_escapes(segment)?;
    let decoded = percent_decode_str(segment).collect::<Vec<u8>>();
    String::from_utf8(decoded).map_err(|_| LocationError::InvalidUri)
}

/// 核对每个 `%` 后面恰好是两位十六进制。
fn check_percent_escapes(segment: &str) -> Result<(), LocationError> {
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3).ok_or(LocationError::InvalidUri)?;
            if !hex.iter().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(LocationError::InvalidUri);
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    Ok(())
}

/// 路径规范化，只做三件事：以 `/` 开头，折叠连续斜杠，去尾斜杠。
/// 不折叠 `..`：文件系统给什么就是什么，越界由各 provider 的 realpath 防护负责。
fn normalize_path(segments: &[String]) -> String {
    if segments.is_empty() {
        return "/".to_string();
    }
    format!("/{}", segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 TS 侧共用同一份向量文件。
    const VECTORS: &str = include_str!("../../../../packages/location/vectors.json");

    #[test]
    fn parse_vectors_match_scheme_device_and_path() {
        let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let cases = vectors["parse"].as_array().expect("parse 数组缺失");
        assert!(!cases.is_empty());
        for case in cases {
            let input = case["input"].as_str().expect("input 缺失");
            let (scheme, device, path) = parse(input)
                .unwrap_or_else(|error| panic!("parse({input:?}) 应成功，实际报 {error:?}"));
            assert_eq!(scheme_name(scheme), case["scheme"], "scheme 不符：{input:?}");
            assert_eq!(device.as_deref(), case["device"].as_str(), "device 不符：{input:?}");
            assert_eq!(path, case["path"], "path 不符：{input:?}");
        }
    }

    #[test]
    fn reject_vectors_are_rejected() {
        let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let cases = vectors["reject"].as_array().expect("reject 数组缺失");
        assert!(!cases.is_empty());
        for case in cases {
            let input = case["input"].as_str().expect("input 缺失");
            let error = parse(input)
                .err()
                .unwrap_or_else(|| panic!("parse({input:?}) 应被拒绝，实际成功"));
            assert_eq!(error, error_code(case["code"].as_str().expect("code 缺失")));
        }
    }

    #[test]
    fn device_name_case_is_preserved() {
        let (scheme, device, path) = parse("ssh://NM105/srv").unwrap();
        assert_eq!(scheme, Scheme::Ssh);
        assert_eq!(device.as_deref(), Some("NM105"));
        assert_eq!(path, "/srv");
    }

    #[test]
    fn malformed_percent_encoding_is_rejected() {
        // 残缺的转义与非 UTF-8 序列对齐 decodeURIComponent 的严格语义。
        assert_eq!(parse("ssh://nm105/a%2").unwrap_err(), LocationError::InvalidUri);
        assert_eq!(parse("ssh://nm105/a%zz").unwrap_err(), LocationError::InvalidUri);
        assert_eq!(parse("ssh://nm105/%FF").unwrap_err(), LocationError::InvalidUri);
    }

    fn scheme_name(scheme: Scheme) -> &'static str {
        match scheme {
            Scheme::File => "file",
            Scheme::Ssh => "ssh",
        }
    }

    fn error_code(code: &str) -> LocationError {
        match code {
            "invalid_uri" => LocationError::InvalidUri,
            "unsupported_scheme" => LocationError::UnsupportedScheme,
            "bad_device" => LocationError::BadDevice,
            "relative_path" => LocationError::RelativePath,
            other => panic!("未知错误码：{other}"),
        }
    }
}
