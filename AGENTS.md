# persona 开发 Agent 入口

本仓库开发规则统一见 [CONTRIBUTING.md](CONTRIBUTING.md)，本文件不重复维护第二套规则。

- **仅 GitHub Issue 是开发需求与验收依据**；Issue 被创建不等于授权开始，须得到用户明确实施指令。
- 基于最新 `main` 建独立任务分支，只完成已批准 Issue 的范围；不得直接修改 `main`。
- 实施后运行受影响的必要验证，提交关联 PR；**开发 Agent 不得自行 merge**。
- 审核者无 blocker 时直接 Squash and merge；有 blocker 时在原 PR 评论，Agent 原分支修复并等待复审。
- 个人离线单 HTML 应用，JSON 工程独立保存；不无故引入服务器、账号、多用户、复杂仿真和兼容迁移体系。
- 不为每个任务另写任务书或实施报告；PR 中如实记录执行过的验证、失败及未验证项。