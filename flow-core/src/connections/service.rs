//! 连接配置交付：向角色查询方提供非敏感视图，向运行创建方提供可冻结配置。
//!
//! SPEC：角色查询方拿到连接标识、模型信息和能力判断；运行创建方拿到
//! 可冻结的连接配置及凭据引用。运行时凭据解析与配置读取分开调用，
//! 交付结果具有明确的缺失及失效语义。
//!
//! 过渡设计说明：本文件当前直连 [`super::store::ConnectionStore`]。
//! 集成后 `ConnectionService` 将由 app 装配为 `dyn ConnectionQuery`，
//! roles/runs 只依赖 trait（与 storage 事务设施接线），接口不变。

use async_trait::async_trait;

use super::error::ConnectionError;
use super::model::{ConnectionView, FreezableConfig};
use super::store::ConnectionStore;

/// 角色查询方使用的连接查询接口（非敏感视图，无凭据字段）。
#[async_trait]
pub trait ConnectionQuery: Send + Sync {
    async fn view(&self, id: &str) -> Result<ConnectionView, ConnectionError>;
    async fn list_views(&self) -> Result<Vec<ConnectionView>, ConnectionError>;
}

/// 运行创建方使用的可冻结配置接口（含凭据引用，不含明文）。
/// 运行时凭据解析（[`super::credential`]）与配置读取分开调用。
#[async_trait]
pub trait ConnectionConfigSource: Send + Sync {
    async fn get_freezable_config(&self, id: &str) -> Result<FreezableConfig, ConnectionError>;
}

/// 基于本域存储的交付实现。交付值均为克隆，读取后修改连接不影响已交付值。
pub struct ConnectionService {
    store: ConnectionStore,
}

impl ConnectionService {
    pub fn new(store: ConnectionStore) -> Self {
        Self { store }
    }

    /// 角色查询方视图。
    pub fn view(&self, id: &str) -> Result<ConnectionView, ConnectionError> {
        self.store.get(id).map(|c| ConnectionView::from_connection(&c))
    }

    /// 全部连接的非敏感列表。
    pub fn list_views(&self) -> Result<Vec<ConnectionView>, ConnectionError> {
        self.store
            .list()
            .map(|cs| cs.iter().map(ConnectionView::from_connection).collect())
    }

    /// 可冻结配置：完整记录 + 凭据引用，不含凭据明文。
    /// 返回克隆值，交付后修改连接不影响已取得的配置。
    pub fn get_freezable_config(&self, id: &str) -> Result<FreezableConfig, ConnectionError> {
        self.store
            .get(id)
            .map(|c| FreezableConfig::from_connection(&c))
    }
}

#[async_trait]
impl ConnectionQuery for ConnectionService {
    async fn view(&self, id: &str) -> Result<ConnectionView, ConnectionError> {
        self.view(id)
    }

    async fn list_views(&self) -> Result<Vec<ConnectionView>, ConnectionError> {
        self.list_views()
    }
}

#[async_trait]
impl ConnectionConfigSource for ConnectionService {
    async fn get_freezable_config(&self, id: &str) -> Result<FreezableConfig, ConnectionError> {
        self.get_freezable_config(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::{ConnectionValidationError, ServiceType};
    use crate::connections::store::{ConnectionChanges, NewConnection};

    fn service() -> (ConnectionService, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svc.db").to_string_lossy().to_string();
        std::mem::forget(dir);
        let svc = ConnectionService::new(ConnectionStore::open(&path).unwrap());
        let c = svc
            .store
            .create(NewConnection {
                name: "main".into(),
                service_type: ServiceType::OpenAiCompatible,
                endpoint: "https://api.example.com/v1".into(),
                credential_ref: "vault://keys/main".into(),
            })
            .unwrap();
        (svc, c.id)
    }

    /// SPEC「连接配置交付」：存在的连接返回完整非敏感配置。
    #[tokio::test]
    async fn view_返回完整非敏感配置() {
        let (svc, id) = service();
        let v = svc.view(&id).unwrap();
        assert_eq!(v.id, id);
        assert_eq!(v.endpoint, "https://api.example.com/v1");
        assert_eq!(v.service_type, ServiceType::OpenAiCompatible);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("credential"), "视图不得含凭据字段：{json}");
    }

    /// SPEC「连接配置交付」：不存在或已删除的连接返回明确失败。
    #[tokio::test]
    async fn 缺失连接返回明确失败() {
        let (svc, id) = service();
        assert!(matches!(svc.view("conn_none"), Err(ConnectionError::NotFound(_))));
        assert!(matches!(
            svc.get_freezable_config("conn_none"),
            Err(ConnectionError::NotFound(_))
        ));
        svc.store.delete(&id).unwrap();
        assert!(matches!(svc.view(&id), Err(ConnectionError::NotFound(_))));
        assert!(matches!(
            svc.get_freezable_config(&id),
            Err(ConnectionError::NotFound(_))
        ));
    }

    /// SPEC「连接配置交付」：读取可冻结配置后再修改连接，已交付值保持
    /// 原样，后续读取返回修改后的配置。
    #[tokio::test]
    async fn 冻结配置是克隆值不受后续修改影响() {
        let (svc, id) = service();
        let frozen = svc.get_freezable_config(&id).unwrap();
        assert_eq!(frozen.credential_ref, "vault://keys/main");
        svc.store
            .update(
                &id,
                ConnectionChanges {
                    name: "renamed".into(),
                    service_type: ServiceType::Anthropic,
                    endpoint: "https://other.example.com".into(),
                    credential_ref: "vault://keys/rotated".into(),
                },
            )
            .unwrap();
        assert_eq!(frozen.name, "main", "已交付配置不得被修改影响");
        assert_eq!(frozen.credential_ref, "vault://keys/main");
        let again = svc.get_freezable_config(&id).unwrap();
        assert_eq!(again.name, "renamed");
        assert_eq!(again.credential_ref, "vault://keys/rotated");
    }

    /// SPEC「凭据引用与受控解析」/「连接配置交付」：DTO、Debug 输出中
    /// 不含测试密钥标记；视图路径不触碰凭据。
    #[tokio::test]
    async fn 交付路径无密钥标记() {
        const MARKER: &str = "sk-LIVE-TEST-MARKER";
        let (svc, id) = service();
        // 引用与密钥不同；MARKER 是密钥值，任何 DTO 都不应出现。
        // 用它污染 endpoint 也应被校验拒绝（脱敏验证归 store/model 测试）。
        let v = svc.view(&id).unwrap();
        assert!(!format!("{v:?}").contains(MARKER));
        let cfg = svc.get_freezable_config(&id).unwrap();
        assert!(!format!("{cfg:?}").contains(MARKER));
        let views = svc.list_views().unwrap();
        assert_eq!(views.len(), 1);
        assert!(!format!("{views:?}").contains(MARKER));
    }

    /// SPEC「连接配置管理」：校验失败经交付入口同样保留原配置并返回
    /// 字段级脱敏错误。
    #[tokio::test]
    async fn 经_service_更新的校验失败保留原配置() {
        let (svc, id) = service();
        let before = svc.get_freezable_config(&id).unwrap();
        let err = svc
            .store
            .update(
                &id,
                ConnectionChanges {
                    name: "n".into(),
                    service_type: ServiceType::OpenAiCompatible,
                    endpoint: "https://u:p@host.example.com".into(),
                    credential_ref: "r".into(),
                },
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ConnectionError::Validation(ConnectionValidationError::EmbeddedCredential)
        ));
        assert!(!err.to_string().contains("u:p"), "错误泄漏了 userinfo");
        assert_eq!(svc.get_freezable_config(&id).unwrap(), before);
    }
}
