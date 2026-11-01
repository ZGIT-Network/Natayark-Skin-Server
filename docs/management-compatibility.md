# 管理与账户接口补齐记录

核验日期：2026-11-01。对照本地旧站 Laravel 控制器及 texture-description 插件，采用现有 Node.js 会话、CSRF、OAuth scope 与隔离数据库。

## 本轮接口

| 路径 | 行为 |
| --- | --- |
| `GET /admin/chart` | 管理员可读取 `labels`、31 个 `xAxis` 日期及两组 `data`，缺失日期补零。 |
| `GET /admin/status` | 系统状态页面，显示运行时、数据库连通性、材质目录权限及邮件配置状态，不输出凭据。 |
| `PUT /admin/players/:pid/textures`、`/api/admin/players/:pid/textures` | `type=skin/cape`、`tid`；0 清除；检查类型、权限及 CSRF／Bearer scope。改名兼容 `player_name`，转移归属兼容 `uid`。 |
| `GET /admin/closet/:uid` | 衣柜管理页面；POST／DELETE 及 `/api/admin/closet/:uid` 保留管理操作，错误不再返回成功状态。 |
| `/admin/{customize,score,options,resource}` | GET 映射设置页的相应区域，POST 复用受保护的设置处理器。 |
| `GET /user/closet/list`、`GET /api/closet` | 旧分页结构，支持 `category`、`q`、`perPage` 和 `page`。材质列表 `/skinlib/list` 支持旧 `filter`／`uploader`，返回 `data` 与分页字段。 |
| `GET /api/user/notifications` | 返回当前账户未读通知的 `id`、`title` 摘要。 |
| `POST /{api/,}user/notifications/:id` | 读取本人通知并返回 `title`、已净化的 Markdown HTML `content`、`time`；重复读取不重写首次已读时间。`all` 标记全部未读。兼容旧 `Notification.Read` scope。 |
| `POST /api/admin/notifications`、`/admin/notifications/send` | 支持 `receiver=all/normal/uid/email` 和旧标题／正文参数，也保留明确用户 ID 数组。验证接收人存在，批量发送在事务中执行。 |
| `GET/PUT /texture/:tid/description`、`/api/textures/:tid/description` | 读取 HTML 或 `?raw` Markdown；更新校验权限、字数与存储大小，返回净化后的 HTML。内部 `/api/skinlib/:tid/description` 保留 JSON 并附 `html`。 |
| `/oauth/personal-access-tokens`、`/oauth/scopes` | 新增对应界面。令牌只在创建时显示，API 账户状态和角色权限仍逐次检查；不能通过声明管理 scope 提权。 |
| `/auth/bind`、`/user/email-verification`、`/auth/verify/:uid` | 补填需邮箱证明后才保存；已填邮箱须使用受保护的资料修改流程。旧验证入口只接受当前一次性 challenge，拒绝 UID 不匹配和重复消费，不能凭 UID 标记已验证。 |

用户通知、举报追踪和积分规则页替换了通用数据库字段表。通知、衣柜、统计图保留常规展开和页面淡入，未增加卡片悬浮、发光或跨页形变。

## 描述存储迁移

`migrations/003_texture_description.sql` 将原 `textures_description.description` 从 `VARCHAR(255)` 扩大为 `TEXT`，不删除已有内容；旧 PHP 读取器仍可读取同一列。新安装的 `schema.sql` 同步采用 TEXT。

保持原始列结构，仅添加独立扩展表：

```powershell
node --import tsx scripts/migrate.ts --apply
```

上述命令默认跳过可选的 `003_texture_description.sql`。程序检测实际列容量，原来的 `VARCHAR(255)` 无需修改即可使用；`textures_description_limit=0` 时仍最多 255 个字符。配置更大的上限也不能越过原列容量。

确实需要长描述时，再明确执行：

```powershell
node --import tsx scripts/migrate.ts --apply --long-descriptions
```

此命令读取目标环境配置。当前工作区的 `dev_20261029_` 描述列此前已扩大为 TEXT；原始 29 张表始终未修改。TEXT 下 `textures_description_limit=0` 表示不额外限制字符数，仍有 65535 UTF-8 字节上限。超限返回 422，保留原内容。原始列结构和完整数据的独立副本已通过 67 项检查，见 [原站兼容验证](legacy-compatibility-verification.md)。

## 验证与范围

- `tests/management.integration.test.ts` 检查实际数据库和 Fastify 请求，创建、清理独立测试账户及材质。
- `output/playwright/management-design-review.js` 检查十个页面的桌面与手机排版，并实际完成通知、衣柜搜索、描述与个人令牌操作。
- 验证码、保持登录和高级搜索随后已补充，见 [认证迁移](authentication.md)及[高级搜索](advanced-search.md)。新站提供空库初始化与管理员命令，旧 PHP 插件运行时仍不执行。测试结果不能代替真实 SMTP、第三方登录和游戏客户端验收。
