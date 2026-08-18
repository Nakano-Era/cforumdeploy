# CForum 管理员手册（实施期版本）

## 首次安装

1. 部署 Worker 和资源绑定。
2. 设置所有 HMAC secret、bootstrap secret、`APP_ORIGIN`。
3. 打开站点，使用安装向导创建首位 Lv4 Admin。
4. 安装成功后轮换 `BOOTSTRAP_ADMIN_SECRET`；数据库唯一 bootstrap claim 会继续阻止重复安装。
5. 创建 Turnstile widget 与 Resend 发信域名；未完成前不要开放注册。
6. 为管理员账户设置至少一个 Passkey，并保存恢复码（恢复码流程完成后）。

## 注册模式

- `open`：邮箱验证后 active。
- `approval`：邮箱验证后 pending，进入注册审核队列。
- `invite_only`：必须使用有效邀请；`invite_requires_approval` 默认 false。

`registration_frozen=true` 会停止新注册验证码和注册提交。邮件服务不可用时生产验证码流程 fail closed，不影响已有 Passkey 登录。

Active Admin 可从顶栏“管理”进入邀请工作台：

- “生成新邀请”创建一枚只可成功注册一次的 token；原始邀请链接仅在创建响应和当前结果卡中出现一次，关闭后无法找回。
- 服务端只保存 `INVITE_HMAC_SECRET` 计算出的 HMAC，不在列表或审计中返回 token/hash。
- 管理页可按 keyset 查看状态并撤销未使用邀请；撤销为幂等操作。
- 当前 P0 界面不提供指定邮箱/域名、过期时间、多次使用或自动加组；这些字段不得通过手工改请求绕过严格 schema。
- 收到 `?invite=` 链接的用户会进入注册流程并预填 token；注册成功或进入审批后，token 会从地址栏移除。

Lv0 前若干主题与回复的审核数量分别由 `lv0_first_topics_review_count` 和 `lv0_first_replies_review_count` 控制；设为 `0` 表示关闭。板块自身的强制审核仍独立生效。

Active Admin 可通过 `GET /api/admin/settings` 查看基础设置，并以带会话 CSRF 请求头的 `PATCH /api/admin/settings` 在线调整注册模式、注册冻结、邀请制审批、维护模式及上述两个 Lv0 阈值。该接口使用固定字段白名单并写入 `audit_logs`；版主和非 active 管理员无权调用。当前管理页已提供维护开关与邀请管理，其余设置的完整图形化后台仍在后续阶段。

## 只读维护

- 管理页的“开启只读维护”会立即写入 `maintenance_mode=true`；不使用 isolate 内存缓存，因此下一次请求即生效。
- GET、HEAD、OPTIONS、Bootstrap、登录恢复链及 logout 保持可用。普通成员、游客与 Moderator 的业务 mutation 由中央 middleware 统一拒绝为 `503 / SITE_MAINTENANCE`。
- 状态正常的 Admin 在读取维护设置前直接 bypass，仍可登录管理页、处理紧急写入并关闭维护。停权或无有效 session 的 Admin 不会 bypass。
- 已签发的 R2 Presigned PUT 无法撤回；维护期间 finalize/bind 会被阻止，超过 24 小时的临时对象由媒体清理 Cron 回收。
- 前端横幅与禁用提示仅用于体验，不能替代服务端 guard。

## 审核与举报

- 登录且状态为 active 的成员可用 `POST /api/posts/:id/reports` 举报自己有权查看的已发布帖子。同一成员、帖子和举报类型只产生一份 `reports` 记录及一项审核任务；网络重试不会重复入队。
- Active Admin 和 Active Moderator 使用 `GET /api/admin/review` 查看审核队列。Admin 可查看全站及注册审核；Moderator 只会收到 `moderator_category_scopes` 明确列出的板块项目，越权项目与不存在项目统一返回 404。
- `POST /api/admin/review/:id/decision` 接受 `approve` 或 `reject`。同一结果可安全重试；相反结果或已经取消的项目返回冲突，不会覆盖原处理人。
- 处理动作在一个 D1 batch 内同步写入审核项、目标账号/主题/帖子、举报状态、`moderation_actions`、站内通知和 `audit_logs`。批准注册后会使用 Queue 异步发送结果邮件；邮件失败不回滚已经提交的审核决定。
- 接受举报会隐藏目标帖子；若目标是首帖，则同时删除主题。驳回举报不会修改内容。批准待审首帖/回复会重新精确计算主题回复数与参与人数，避免计数漂移。

通知读取使用 `GET /api/notifications`，标记已读使用 `POST /api/notifications/read`。通知返回前会重新应用当前主题权限；内容已隐藏或成员已经失权时，只保留通用事件提示，目标链接和内容字段会被移除。

## 版主授权

版主必须逐板块写入 `moderator_category_scopes`，不自动继承子板块。授权前确认其只能处理该板块内容、附件、举报与审核项；注册、角色、等级、全站处罚、ACL 和站点设置仅 Admin 操作。

## 媒体与生命周期

- Public bucket：只保存真正 Guest 可见内容的不可变变体，但仍只能通过 Worker 的 `/api/media/*` 读取；不要绑定公开自定义域名，也不要启用 `r2.dev`。
- Private bucket：保存临时、受限和隔离内容。只为浏览器直传的 Presigned PUT 配置精确站点来源、PUT/HEAD 与必要请求头的 CORS，不允许公开读。
- 每小时 Cron 会以固定批次清理超过 24 小时的临时对象、已删除媒体和孤儿对象；单次最多连续处理四页，失败会让 Cron 明确失败以便 Cloudflare 重试。不要手工删除 `_internal.media_cleanup.*` 游标设置。
- 审核批准和权限调整后会重新计算 Public/Private 分级；即使搬运重试尚未完成，读取路径也会按最新主题 ACL fail closed。
- R2 7GB 告警、8GB 硬停上传；不要手工提高硬限制而不评估账单。

## 每日检查

- Worker 请求、错误率与 CPU。
- D1 rows read/write 和数据库大小。
- R2 字节数/Class A/Class B。
- Queue 重试与 DLQ。
- Resend 当日发送数与失败。
- 新增审核、举报、停权与高权限操作审计。

日志中不得出现 OTP、session、邀请 token、Passkey challenge、邮件正文或完整 Presigned URL。

## 上线前站主决策

上线前必须填写社区规则、隐私政策、服务条款、违法/侵权入口和管理员联系方式，并明确未成年人政策、安全日志保留、封禁申诉时限以及用户数据导出/删除流程。
