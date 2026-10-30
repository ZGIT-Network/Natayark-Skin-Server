# Blessing Skin → Node.js 兼容性审计

审计基线：`D:/Projects/mcnskinl/oldbf`（旧 PHP 站点）与 `D:/Projects/mcnskinl/src`（已有 Node.js 重写）。日期：2026-10-29。本文是迁入当前工作区前的源代码差异快照，不代表后续修复的最终状态；未执行写入真实用户数据的测试。

## 结论

现有 Node.js 代码覆盖了主要页面、角色、衣柜、材质、管理基础操作，以及 Yggdrasil/OIDC 的一部分，但不能作为“原功能 100% 实现”交付。除路由缺失之外，积分、权限、注册与令牌行为有实质差异，且包含必须优先修复的账户接管路径。

PHP 插件运行时本身依赖 Laravel/PHP，不能直接在 Node.js 中继续加载。应将现有启用插件的行为逐一移植；若仍需宣称兼容任意旧 PHP 插件，则该承诺与纯 Node.js 运行时不相容。安装目录的存在不等于插件当前启用，最终验收范围应同时依据数据库中的启用列表。

## P0：账户与权限问题

| 问题 | Node 基线证据 | 影响与修复要求 |
| --- | --- | --- |
| 未配置 SMTP 时匿名找回密码响应直接包含重置链接 | `routes/web.ts` 的 `/auth/forgot`，原第 143–164 行 | 任意访客可接管已有账号。禁用无 SMTP 找回、绝不在响应中暴露链接；使用单次、持久化且有明确到期时间的重置凭据。 |
| 重置凭据没有有效期 | `/auth/reset/:uid` 仅比较 `users.verification_token` | 页面宣称一小时，服务端实际永久有效；也混用了邮箱验证字段。需要独立用途、到期与原子消费机制。 |
| 已有密码用户可调用 OAuth 首次设密接口直接覆盖密码 | `/auth/oauth/set-password` 的 POST 无当前密码验证、无 CSRF | 首次设密必须只允许空密码用户，普通改密必须校验原密码。 |
| 普通管理员可提升自身/普通用户为超级管理员 | `routes/api.ts` 的 `permission` 分支允许 2，只阻止修改原本为 2 的用户 | 旧代码禁止自改权限，仅超级管理员可授予管理员且不允许该接口授予超级管理员。应验证操作者、目标和新角色三个条件。 |
| OAuth 仅按远端邮箱自动登录本地账户 | `routes/web.ts` OAuth callback | 未存储 provider + subject 绑定，也无已验证邮箱条件。新接入提供方可声明已有邮箱并造成接管。需要持久身份绑定、明确的首次绑定流程和邮箱信任策略。旧插件也按邮箱关联，属于迁移时应修复的安全缺陷，不能照搬。 |
| OAuth state 未绑定浏览器会话、不能单次消费 | `services/session.ts` 的 `oauthState`/`verifyOauthState` | 签名与过期不足以防登录 CSRF/重放；需要会话 nonce、单次消费；支持时使用 PKCE。 |
| 多项写入未校验 CSRF | `/user/profile`、`/user/sign`、logout、forgot/reset、OAuth 首次设密 | 同站 Cookie 策略不能代替服务端 CSRF 校验；需要统一写操作保护。匿名 CSRF 当前为所有访客共享的固定 HMAC，也应改为浏览器绑定。 |
| 封禁后的现有网页会话仍可写操作 | `services/session.ts` `loadSession` 不拒绝 `permission=-1`，普通 API 只验证 currentUser | 登录入口检查封禁不足以阻止原有会话，应每次鉴权拒绝封禁用户，并吊销相关游戏/OAuth 令牌。 |
| 默认公开签名密钥 | `config.ts` 中 `APP_KEY` 默认 `dev-insecure-key` | 生产启动必须拒绝默认/缺失密钥；Cookie Secure 应随 HTTPS 环境开启。 |

## 核心功能差异

| 模块 | 已有覆盖 | 缺失或不兼容 |
| --- | --- | --- |
| 登录 | 邮箱密码、第三方跳转 | 旧 `identification` 支持邮箱或角色名，Node 仅邮箱；登录失败 CAPTCHA、keep/记住登录未移植；成功登录缺省 redirect 是空串而不是 `/user`。 |
| 注册 | 邮箱、初始积分、IP 限制、可选角色 | 旧首角色免费，Node 通过 `addPlayer` 扣分且忽略创建失败；旧 last_sign_at 为昨日，Node 为当前时刻；未遵守关闭注册/绑定单角色插件；require_verification 未参与注册参数，Node 默认已验证。 |
| 邮箱验证 | 数据字段存在 | 缺失发送验证邮件、验证页/确认、未验证账户写操作限制、补填邮箱 `/auth/bind`；改邮箱未校验原密码、合法邮箱及重新验证策略。 |
| 密码兼容 | `$2y$` bcrypt 读写 | 旧支持 BCRYPT、PHP_PASSWORD_HASH、ARGON2I、MD5、SHA256、SHA512、SALTED2MD5、SALTED2SHA256、SALTED2SHA512。Node 仅 bcrypt；旧加盐算法使用 `secure.salt`，算法选择来自 `PWD_METHOD`，不是用户逐行自动推断。改密/重哈希仍应能被原 PHP 配置验证。 |
| 用户中心 | 概览、资料、签到、角色、衣柜、授权连接 | 缺失 `/user/score-info`、站内通知读取、用户举报追踪、dark-mode PUT、完整语言切换；UI 的“今天可签到”判断与 sign_gap_time 模式不一致。 |
| 角色管理 | 添加、改名、删除、设置/清空材质 | 缺少旧 `/user/player/list`、复数 `/api/players` 及返回结构；删除未返积分；首角色计费不对；设置公开材质可绕过加入衣柜，旧要求材质在衣柜中；单角色限制未实现。 |
| 衣柜 | 增删改、列表 | 缺失分类/搜索分页、all IDs、likes 增减、收藏奖励及撤回、return_score 返还；删除衣柜条目未清该用户角色的对应材质。 |
| 材质库 | 列表、搜索、预览、上传、删除、公开/私有、描述 | 缺失材质重命名与模型修改；旧路径 `/texture/*`、`/skinlib/list`、`/skinlib/info/*`；旧高级搜索语法、上传者筛选 UI、内容政策配置等未完整移植。 |
| 上传计费 | 基础 KB 计费和衣柜成本 | 旧计费总额先扣上传奖励，再判断余额（旧私有上传同样使用此奖励）；Node 先检查未扣奖励的总额且仅公开奖励。旧初始 likes=1，Node=0；公开相同 hash 或自己相同 hash 旧返回重复 code=2，Node 只检测相同 uploader 并可能新建另一条公开重复。 |
| 隐私/删除计费 | 存在操作 | Node 隐私切换只改 flag，旧需重算公私储存成本、撤回公开奖励及余额/公开重复判断。Node 删除误用 take_back_scores_after_deletion 作退款开关；旧为 return_score 返储存成本、公开且 take_back 时扣回上传奖励。 |
| 举报 | 提交与同意/驳回 | Node 误读 reporter_score_modification 正负，未查重复举报；缺少封禁上传者处理；重复审核可重复奖励；deleteTexture 会删报告后又尝试更新其状态，丢审计记录。旧支持 delete/ban/reject 与 pending 一次性积分结算。 |
| 管理用户/角色 | 基础列表、若干字段修改/删除 | 修改字段的校验、目标权限保护和旧复数路由/JSON 结构不一致；缺失管理衣柜、列表 API、高级搜索、完整统计图、健康状态、站内通知发送。 |
| 站点设置 | 单一 settings 页面 | 旧 customize/score/options/resource 的配置范围、验证器和功能联动未完整映射；Node 任意提交 key 可落入 options，需明确可写键和数据类型。 |
| 国际化 | zh_CN/en 词典 | 大量页面中文硬编码，旧语言库与 `language_lines` 覆盖、管理 CRUD 未实现。 |
| 第三方应用 | 管理客户端、授权连接页、OIDC 路由 | 旧 Passport 客户端管理 `/user/oauth/manage`、OAuth grant/scopes 的通用 API 权限未完整实现；需区分“网站作为OAuth客户端注册”与“网站作为授权服务器给启动器登录”。 |
| PHP 运维能力 | Node 启动/构建 | 旧安装向导、插件安装/市场/配置、在线程序更新、队列任务、扩展事件/过滤钩子未移植；不能仅以界面替换宣称同等运行时能力。 |

## 原 API 的关键兼容边界

旧 `routes/api.php` 的 API 使用 OAuth Bearer + scope 鉴权。现有 `routes/api.ts` 的全局 hook 要求网页 session，实际为另一套内部 API。仅保留同一数据库不能保证已有第三方应用可继续使用。

必须覆盖原 scope：`User.Read`、`Notification.Read/ReadWrite`、`Player.Read/ReadWrite`、`Closet.Read/ReadWrite`、`UsersManagement.Read/ReadWrite`、`PlayersManagement.Read/ReadWrite`、`ClosetManagement.Read/ReadWrite`、`ReportsManagement.Read/ReadWrite`。应按旧格式输出分页/字段，验证令牌权限不超过已授予 scope；不能直接将游戏 accessToken 当成全部账户写权限。

旧 API 关键路径：

- `GET /api`、`GET /api/user`、`GET/POST /api/user/notifications[/:id]`。
- `/api/players` 的 GET/POST、`/:pid` DELETE、`/:pid/name` PUT、`/:pid/textures` PUT/DELETE。
- `/api/closet` GET/POST、`/:tid` PUT/DELETE。
- `/api/admin/users` 与 `/:uid/{email,verification,nickname,password,score,permission}` PUT、`/:uid` DELETE。
- `/api/admin/players` 与 `/:pid/{name,owner,textures}` PUT、`/:pid` DELETE。
- `/api/admin/closet/:uid` GET/POST/DELETE、`/api/admin/reports` GET、`/:id` PUT、`/api/admin/notifications` POST。

## 材质客户端协议差异

- CustomSkinAPI JSON 基线 Node 用 `default/slim` 作 skins key，而旧 `Player` 序列化格式须以实际模型为准；应使用原 JSON fixture 比较，不能仅检查 200。
- 原 avatar/preview 支持的查询参数、图片格式（PNG/WebP）、缓存、Last-Modified/ETag、404/422 语义需保留。Node 只实现 size 参数与 PNG，缺少旧 height/3D/overlay 等参数。
- 旧 cape 上传同样要求宽度为 64 倍数、高度为 32 倍数；Node 的 cape 分支只查 2:1，尺寸规则不同。协议若另支持 22:17，需明确 padding 处理。
- `/textures/:hash` 的文件读取是 stream，Node try/catch 无法捕获后续异步 ENOENT；需先 stat/open 或统一 stream 错误处理。
- 删除/移除材质清理角色时必须更新 `last_modified`，避免客户端缓存仍用旧资料。
- PHP 正则配置通常带 `/.../` 分隔符；直接 `new RegExp(raw,'u')` 会把分隔符当字面量，需转换/校验而不是无效时静默放过。

## 已安装插件清单与迁移状态

以下清单来自磁盘，不等同于数据库启用列表。

| 插件 | 作用 | Node 基线 |
| --- | --- | --- |
| yggdrasil-api / yggdrasil-connect | 游戏外置登录、资料/材质、Yggdrasil Connect | 有部分重写；应由独立协议审计逐端点验收，二者旧站不可同时启用。 |
| oauth / oauth-natayark | 第三方登录/注册 | 通用配置存在，但 Natayark 预设常量未自动装载，且身份绑定、安全注册未完整实现。 |
| oauth-microsoft-live | Microsoft 登录提供方 | 无预设/兼容导入，通用OAuth模块不足以自动等价。 |
| oauth-set-password | OAuth账号首次设密和强制流程 | 有危险的部分实现，需要只允许空密码、CSRF、策略/重定向。 |
| single-player-limit | 禁增删、昵称跟随角色、初次绑定角色页 | 未实现；addPlayer 注释提及该限制但实际未限制。 |
| disable-registration | 关闭注册入口及注册过滤 | 未实现。 |
| share-registration-link | 生成/列出/删除分享码、注册奖励 | 未实现；并非强制邀请码，旧 code 是可选分享奖励。 |
| mojang-verification | Microsoft/Xbox/Minecraft正版验证与绑定UUID | 未实现；通用OAuth不足以替代该多阶段流程。 |
| texture-description | 描述表和读写API | 内容读写已有；旧 `/texture/:tid/description`、`/api/textures/:tid/description` 缺失，长度/权限/Markdown配置需比对。 |
| legacy-api | `/skin/:player.png`、`/cape/:player.png` | 缺失。 |
| usm-api | `/usm/:player.json`、`/usm/textures/:hash` | 缺失。 |
| 204-for-unexisted-players | 不存在角色返回204 | 缺失，当前返回404。 |
| config-generator | 客户端皮肤Mod配置生成 | 缺失。 |
| batch-import | CLI批量导入皮肤/角色 | 缺失。 |
| gravatar | Gravatar默认头像 | 缺失。 |
| hitokoto | 首页一言 | 缺失。 |
| refresh-ali-cdn | 更新材质/角色后刷新阿里CDN | 缺失。 |
| remote-addr | 覆盖客户端IP获取 | Node trustProxy 可部分替代，需受信代理范围配置，不能直接信任任意来源头。 |
| hide-advanced-menu / insider | 隐藏高级菜单、内测资源渠道 | 无相应可配置行为。 |
| lang / resources / src / views | 插件语言/资源/自定义设密资源 | 不是可据目录名直接推定的独立插件，需读取 package.json/启用配置确认。 |

Natayark 原提供方源码明确端点为 `https://account.naids.com/oauth2/authorize`、`https://account.naids.com/api/oauth2/token`、`https://account.naids.com/api/api/user/data`；用户字段在 `data.id/username/email`，凭据从 `NYKID_KEY`、`NYKID_SECRET`、回调 `NYKID_REDIRECT_URI` 获取。这是旧插件证据，服务当前能力与真实回调仍需凭据/联调验证，不能视作已完成实测。

## 数据库兼容验收要求

1. 先做 schema / 约束 / 索引只读盘点；原 `users`、`players`、`textures`、`user_closet`、`uuid`、`oauth_*`、`options` 等不可改名或重写现有ID。
2. 启动不得自动生成/覆盖原签名密钥、Passport客户端、site_url 或用户数据；新增表通过独立、可审查的迁移执行。
3. 用数据库副本验证原密码算法（包括盐）、原签名资料与JWT、原账号/角色UUID、现存材质hash和文件路径。
4. 经济回归必须覆盖上传公开/私有、切隐私、收藏/移除、自收藏/他人收藏、删除、举报各分支；并发请求应原子扣分，避免负余额/双签到/双消费。
5. 旧表无邮箱/角色名唯一约束时，注册与绑定应通过事务/锁或兼容新增唯一保护避免并发重复；不得只做先查询再INSERT。
6. 对原 API 建路由/状态码/响应体 fixture，对新增 OAuth 做本地 provider 的完整注册、重登、绑定冲突、取消、state重放、PKCE回归。
7. 实际 Natayark授权、SMTP投递、HMCL等启动器和图形Minecraft客户端，是与单元/API测试分开的验证边界；未测试必须明确写明。
