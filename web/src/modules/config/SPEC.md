---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
references:
  - ../../../DESIGN.md
---
# 运行配置

## 功能意图

展示 runtime 执行器并维护新运行使用的模型与并发上限。

## 关键功能与验收

### 读取和修改

#### 验收

- 读取并显示 executor、model、maxConcurrent；执行器只读。
- 最大并发数接受 1 至 64 的整数，PATCH 仅传变更字段。成功后以返回值更新基线，失败保留输入。
