//! 运行产物：节点产生的交付物与产物契约校验。

use serde::{Deserialize, Serialize};

use super::workflow::ArtifactContract;

/// 运行产物。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub name: String,
    pub path: String,
    /// 是否必需。
    #[serde(default)]
    pub required: bool,
    /// 内容类型。
    #[serde(default)]
    pub media_type: Option<String>,
}

/// 产物契约校验错误：按声明逐项定位失败原因。
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ArtifactContractError {
    #[error("缺少必需产物：name={name}, path={path}")]
    MissingArtifact { name: String, path: String },
    #[error(
        "产物 {name}（path={path}）内容类型不匹配：声明 {expected}，实际 {actual}"
    )]
    MediaTypeMismatch {
        name: String,
        path: String,
        expected: String,
        actual: String,
    },
}

/// 校验执行结果是否满足节点声明产物契约。
///
/// 逐项检查每条必需声明：必须存在按 name+path 匹配的产物，且声明了
/// content type 时产物 media_type 需一致。非必需声明缺失不报错；
/// 未声明 content type 的必需声明只要求存在。
pub fn check_artifact_contract(
    declared: &[ArtifactContract],
    produced: &[Artifact],
) -> Result<(), ArtifactContractError> {
    for contract in declared.iter().filter(|c| c.required) {
        let produced = produced
            .iter()
            .find(|a| a.name == contract.name && a.path == contract.path);

        let Some(artifact) = produced else {
            return Err(ArtifactContractError::MissingArtifact {
                name: contract.name.clone(),
                path: contract.path.clone(),
            });
        };

        if let Some(expected) = &contract.media_type {
            let actual = artifact.media_type.as_deref();
            if actual != Some(expected.as_str()) {
                return Err(ArtifactContractError::MediaTypeMismatch {
                    name: contract.name.clone(),
                    path: contract.path.clone(),
                    expected: expected.clone(),
                    actual: artifact
                        .media_type
                        .clone()
                        .unwrap_or_else(|| "未知".to_string()),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract(name: &str, path: &str, required: bool, media_type: Option<&str>) -> ArtifactContract {
        ArtifactContract {
            name: name.to_string(),
            path: path.to_string(),
            required,
            media_type: media_type.map(|s| s.to_string()),
        }
    }

    fn artifact(
        name: &str,
        path: &str,
        required: bool,
        media_type: Option<&str>,
    ) -> Artifact {
        Artifact {
            id: format!("art-{name}-{path}"),
            name: name.to_string(),
            path: path.to_string(),
            required,
            media_type: media_type.map(|s| s.to_string()),
        }
    }

    #[test]
    fn passes_when_all_required_declarations_satisfied() {
        let declared = [
            contract("设计文档", "out/design.md", true, Some("text/markdown")),
            contract("草稿", "out/draft.tmp", false, Some("text/plain")),
        ];
        let produced = [
            artifact("设计文档", "out/design.md", true, Some("text/markdown")),
            artifact("其他产物", "out/extra.log", false, Some("text/plain")),
        ];
        check_artifact_contract(&declared, &produced).unwrap();
    }

    #[test]
    fn missing_optional_artifact_is_ok() {
        let declared = [contract("可选产物", "out/optional.md", false, None)];
        check_artifact_contract(&declared, &[]).unwrap();
    }

    #[test]
    fn no_declarations_is_ok() {
        check_artifact_contract(&[], &[]).unwrap();
    }

    #[test]
    fn missing_required_artifact_fails_with_name_and_path() {
        let declared = [
            contract("报告", "out/report.md", true, None),
            contract("附录", "out/appendix.md", false, None),
        ];
        let err =
            check_artifact_contract(&declared, &[artifact("报告", "out/other.md", true, None)])
                .unwrap_err();
        assert_eq!(
            err,
            ArtifactContractError::MissingArtifact {
                name: "报告".to_string(),
                path: "out/report.md".to_string()
            }
        );
        assert!(err.to_string().contains("out/report.md"));
    }

    #[test]
    fn media_type_mismatch_fails_with_expected_and_actual() {
        let declared = [contract("报告", "out/report.md", true, Some("text/markdown"))];
        let err = check_artifact_contract(
            &declared,
            &[artifact("报告", "out/report.md", true, Some("application/pdf"))],
        )
        .unwrap_err();
        assert_eq!(
            err,
            ArtifactContractError::MediaTypeMismatch {
                name: "报告".to_string(),
                path: "out/report.md".to_string(),
                expected: "text/markdown".to_string(),
                actual: "application/pdf".to_string(),
            }
        );
    }

    #[test]
    fn produced_artifact_without_media_type_fails_declared_content_type() {
        let declared = [contract("报告", "out/report.md", true, Some("text/markdown"))];
        let err = check_artifact_contract(
            &declared,
            &[artifact("报告", "out/report.md", true, None)],
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ArtifactContractError::MediaTypeMismatch { .. }
        ));
    }

    #[test]
    fn undeclared_content_type_only_requires_existence() {
        let declared = [contract("报告", "out/report.md", true, None)];
        check_artifact_contract(
            &declared,
            &[artifact("报告", "out/report.md", true, Some("application/pdf"))],
        )
        .unwrap();
    }
}
