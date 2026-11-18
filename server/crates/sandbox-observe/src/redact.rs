//! 脱敏助手：摘要文本与凭据类环境变量列表的敏感值处理。
//!
//! 观测记录的 `summary` 必须经 [`redact_summary`] 处理后再写入；
//! 环境变量列表经 [`redact_env`] 处理后只保留键名，任何值都不进入记录。

/// 脱敏替换值。
pub const REDACTED: &str = "[REDACTED]";

/// 剔除摘要文本中常见凭据片段的值，替换为 `[REDACTED]`：
///
/// - `URSI_CRED_*=<value>` 环境变量赋值
/// - `Bearer <value>` 授权头
/// - `password=<value>`、`token=<value>` 等凭据关键词赋值（键名大小写不敏感，
///   允许 `KEY = value` 的空格填充）
///
/// 非凭据内容保持原样。
pub fn redact_summary(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&redact_line(line));
    }
    if text.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn redact_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < line.len() {
        // 命中凭据片段：保留键名前缀（如 `KEY=` 或 `Bearer `），值替换为
        // `[REDACTED]`，便于排查时定位凭据类别而不暴露值本身。
        if let Some((keep, end)) = secret_span_at(line, i) {
            out.push_str(&line[i..i + keep]);
            out.push_str(REDACTED);
            i += end;
        } else {
            let ch = line[i..].chars().next().expect("索引落在字符边界");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// 若 `line[i..]` 以凭据片段开头，返回 `(保留前缀长度, 片段结束偏移)`。
fn secret_span_at(line: &str, i: usize) -> Option<(usize, usize)> {
    let rest = &line[i..];
    // `Bearer <token>`：仅在该位置处于词首时匹配，保留 `Bearer ` 前缀。
    if at_word_start(line, i) {
        if let Some(end) = bearer_value_len(rest) {
            return Some((7, end));
        }
    }
    // `KEY=<value>`：凭据词 + 等号，保留到值起始位置的前缀；仅在该位置
    // 可以开始一段键文本时尝试，避免行中任意偏移误命中。
    if at_key_start(line, i) {
        let (value_start, end) = key_value_span(rest)?;
        return Some((value_start, end));
    }
    None
}

fn at_word_start(line: &str, i: usize) -> bool {
    i == 0
        || matches!(
            line[..i].chars().next_back(),
            Some(' ') | Some('\t') | Some('"') | Some('\'')
        )
}

/// 位置 i 是否可以开始一段 `KEY=` 文本：i 在字符边界上，且 i 的前一字符
/// 不是词字符（避免 `mypassword=`、URL 路径片段等中间命中）。
fn at_key_start(line: &str, i: usize) -> bool {
    if !line.is_char_boundary(i) {
        return false;
    }
    if i == 0 {
        return true;
    }
    !line[..i]
        .chars()
        .next_back()
        .map(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .unwrap_or(false)
}

fn bearer_value_len(rest: &str) -> Option<usize> {
    if !rest.get(..7)?.eq_ignore_ascii_case("bearer ") {
        return None;
    }
    let after = &rest[7..];
    let end = after
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ';' | ',' | ')'))
        .unwrap_or(after.len());
    (end > 0).then_some(7 + end)
}

/// 匹配 `KEY=VALUE`：KEY 为 `URSI_CRED_*` 或以凭据关键词结尾
/// （password、passwd、token、secret、passphrase），返回 `(值起始偏移,
/// 片段结束偏移)`；VALUE 延伸到空白或引号/分号/逗号/右括号为止。
///
/// 关键词允许出现在行中：取等号前的末尾连续词（字母数字与 `-`、`_`）
/// 判定，因此 `prompt password=x` 与 `password=x` 均命中，而
/// `mypassword=x` 因末词不是凭据词而不命中。
fn key_value_span(rest: &str) -> Option<(usize, usize)> {
    let eq = rest.find('=')?;
    if eq == 0 {
        return None;
    }
    let key_text = rest[..eq].trim_end();
    if !is_credential_key(key_text) {
        let word = trailing_word(key_text);
        if !is_credential_key(word) {
            return None;
        }
    }
    // 允许 `password = value` 的空格填充。
    let after_eq = &rest[eq + 1..];
    let trimmed = after_eq.trim_start_matches(' ');
    let value_start = eq + 1 + (after_eq.len() - trimmed.len());
    let after = &rest[value_start..];
    let end = after
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ';' | ',' | ')'))
        .unwrap_or(after.len());
    (end > 0).then_some((value_start, value_start + end))
}

/// 文本末尾的连续词字符（字母数字与 `-`、`_`）。
fn trailing_word(text: &str) -> &str {
    text.char_indices()
        .rev()
        .find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '-' | '_')))
        .map(|(idx, _)| &text[idx..])
        .unwrap_or(text)
}

/// 键名是否属于凭据类。
fn is_credential_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("URSI_CRED_") {
        return true;
    }
    upper
        .split(['-', '_'])
        .next_back()
        .map(|seg| {
            matches!(
                seg,
                "PASSWORD" | "PASSWD" | "TOKEN" | "SECRET" | "PASSPHRASE"
            )
        })
        .unwrap_or(false)
}

/// 环境变量条目列表（`KEY=VALUE` 或纯键名）脱敏：一律只保留键名，值全部
/// 剔除。凭据类条目同样只保留键名，保证敏感环境变量值不出现在记录中。
pub fn redact_env(entries: Vec<String>) -> Vec<String> {
    entries
        .into_iter()
        .map(|entry| match entry.split_once('=') {
            Some((key, _)) => key.to_string(),
            None => entry,
        })
        .collect()
}

/// 键名是否为凭据类环境变量（`URSI_CRED_*` 或凭据关键词结尾）。
pub fn is_credential_env(key: &str) -> bool {
    is_credential_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_cred_env_assignment() {
        let out = redact_summary("URSI_CRED_GITHUB_TOKEN=ghp_abc123 exported");
        assert!(!out.contains("ghp_abc123"));
        assert!(out.contains("URSI_CRED_GITHUB_TOKEN=[REDACTED]"));
    }

    #[test]
    fn redacts_bearer_token() {
        let out = redact_summary("Authorization: Bearer sk-live-99887766 ok");
        assert!(!out.contains("sk-live-99887766"));
        assert!(out.contains("Bearer [REDACTED]"));
    }

    #[test]
    fn bearer_inside_word_is_kept() {
        let out = redact_summary("carrier bearer-echo done");
        assert_eq!(out, "carrier bearer-echo done");
    }

    #[test]
    fn redacts_password_assignment_with_spaces() {
        let out = redact_summary("password = hunter2please");
        assert!(!out.contains("hunter2please"));
        assert!(out.contains("password = [REDACTED]"));
    }

    #[test]
    fn keeps_non_secret_values() {
        let out = redact_summary("PATH=/usr/bin:/bin HOME=/home/u count=42");
        assert!(out.contains("/usr/bin:/bin"));
        assert!(out.contains("count=42"));
    }

    #[test]
    fn redacts_multiline_output() {
        let text = "cmd done\nURSI_CRED_API_KEY=abcd1234\ntoken=zzz-secret end";
        let out = redact_summary(text);
        assert!(!out.contains("abcd1234"));
        assert!(!out.contains("zzz-secret"));
        assert!(out.contains("cmd done"));
        assert!(out.contains("token=[REDACTED] end"));
    }

    #[test]
    fn redact_summary_keeps_plain_lines_untouched() {
        let plain = "exit code 0\noutput lines kept";
        assert_eq!(redact_summary(plain), plain);
    }

    #[test]
    fn redact_env_keeps_only_key_names() {
        let entries = vec![
            "URSI_CRED_GITHUB_TOKEN=ghp_xxx".to_string(),
            "DB_PASSWORD=hunter2".to_string(),
            "PATH".to_string(),
        ];
        let out = redact_env(entries);
        assert_eq!(out, vec!["URSI_CRED_GITHUB_TOKEN", "DB_PASSWORD", "PATH"]);
        // 结果中不存在任何值片段。
        assert!(out.iter().all(|k| !k.contains('=')));
        assert!(out.iter().all(|k| !k.contains("hunter2")));
    }

    #[test]
    fn credential_env_detection() {
        assert!(is_credential_env("URSI_CRED_API_KEY"));
        assert!(is_credential_env("DB_PASSWORD"));
        assert!(is_credential_env("auth_token"));
        assert!(!is_credential_env("PATH"));
        assert!(!is_credential_env("HOME"));
    }
}

