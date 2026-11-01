# 原站兼容验证

核验日期：2026-11-01。原站代码：`D:\Projects\mcnskinl\oldbf`；源数据库：MySQL 5.7.26 的 `mcnskin`。结论按证据范围记录，不能据此宣称所有 Blessing Skin 功能或外部服务均已验收。

## 原始表与数据

| 核验项目 | 当前证据 |
| --- | --- |
| 29 张原表 | 逐表检查字段类型、默认值、空值、排序规则、索引及行数；原始校验和 29/29 未变化。 |
| 完整原库副本启动 | 每次重新复制全部原始数据至唯一临时命名空间，保留原始外键；只添加 001、002 扩展表，不修改任何原始列。67 项检查通过，结束后清理临时表。 |
| 原账户 | 原库 2474 个用户，2403 个无本地密码；无空邮箱，无重复邮箱组。71 个非空密码均为支持的 bcrypt 格式。保留原密码算法与盐配置，不批量重置密码。 |
| 角色与 UUID | 逐个序列化并对照全部 1292 个非封禁账户角色的档案、材质和原 UUID；登录及迁移不重新分配 UID 或 UUID。 |
| 材质文件 | 154 个原始文件均存在，SHA-256 与原哈希相同，PNG 可解码并通过校验；兼容旧 GD 接受的 IEND 尾随元数据。 |
| OAuth 客户端 | 保留原 `oauth_clients` 的客户端 ID、密钥、回调和所属用户。这里是本站 OAuth 服务的客户端表，不是第三方账户绑定表。 |
| 描述列 | 原 `VARCHAR(255)` 可直接使用并遵守容量；默认迁移不扩大此列。只有显式 `--long-descriptions` 才执行可选 TEXT 扩容。 |
| 配置 | 对照确认原密码算法、盐、Natayark ID 客户端配置、SMTP 参数一致；报告仅记录布尔比较结果。Microsoft Live 和阿里云刷新凭据在原配置及当前配置均不存在。 |

原表包括：`_prisma_migrations`、`code_id_to_uuid`、`jobs`、`language_lines`、`migrations`、`mojang_verifications`、`notifications`、`oauth_access_tokens`、`oauth_auth_codes`、`oauth_clients`、`oauth_personal_access_clients`、`oauth_refresh_tokens`、`options`、`players`、`reg_link`、`reports`、`scopes`、`textures`、`textures_description`、`user_closet`、`users`、`uuid`、`ygg_log`、`yggc_authorization_codes`、`yggc_device_codes`、`yggc_grants`、`yggc_interactions`、`yggc_refresh_tokens`、`yggc_sessions`。

当前开发副本的描述列此前已经扩大为 TEXT；本轮独立快照刻意使用未扩容的原列，不用开发副本的改动代替兼容证明。

## 原有第三方登录

原 PHP OAuth 插件按邮箱查找账户，没有保存稳定的提供方用户标识。不能从旧库凭空恢复 `(provider, subject)`。

现有处理：旧用户从第三方回调后，确认一次原邮箱或原密码，再绑定至原 UID。无密码账户走邮箱确认；即使关闭注册及邮箱密码登录也能完成。后续按稳定标识登录。测试覆盖其他浏览器拒绝、错误密码拒绝、一次性消费、并发解绑保护、提供方邮箱变化后的再次登录，以及迁移前后账户、角色、UUID 不变。

真实 Chromium 已在独立临时服务完成密码确认并检查 UID 不变；该服务禁止真实 SMTP。邮件路径使用本地 SMTP 捕获服务验证，不发送到真实邮箱。真实 Natayark ID 授权回调与实际邮件到达仍待验收；回调白名单必须包含部署环境的完整 URL。

## 原站启用的 18 个插件

旧 `plugins_enabled` 是包含 `{name, version}` 的数组。已统一解析，避免旧代码用字符串 `includes()` 导致全部判定为关闭。

| 原插件 | 当前对应能力与验证范围 |
| --- | --- |
| batch-import | 原生命令行批量导入、dry-run、去重、皮肤／披风校验；保持不扣积分、不自动加入衣柜的原行为。隔离目录和数据库测试通过。 |
| config-generator | 启动器配置与认证地址页面；插件及 Web 检查覆盖，真实启动器仍待验收。 |
| 204-for-unexisted-players | 原配置对象数组可正确启用；不存在角色返回 204，快照／附加功能检查覆盖。 |
| gravatar | 原账户头像路径与重定向兼容；快照／附加功能检查覆盖。 |
| hitokoto | 用户页一言、可配置来源、缓存、上游失败时旧值／备用文本；本地 HTTP 测试通过。 |
| oauth | 客户端管理、授权、访问与刷新令牌、个人令牌及吊销；协议、管理和独立 HTTP 客户端测试通过。旧运行中的授权交互不保证延续。 |
| mojang-verification | Microsoft → Xbox → XSTS → Minecraft 验证、UUID 冲突和奖励幂等；21 项模拟上游检查通过，真实正版账户待验收。 |
| oauth-microsoft-live | 内置提供方配置；原配置没有客户端凭据，真实授权未验收。 |
| remote-addr | 默认使用直连地址，与原插件 `Whip::REMOTE_ADDR` 一致；可显式配置受信任代理 CIDR，伪造转发头测试通过。 |
| single-player-limit | 对象数组开关、免费初始绑定、角色增删／昵称同步；快照和业务测试覆盖。 |
| Natayark ID | 原客户端配置与原回调路径保留；旧账户一次性归属确认和稳定身份绑定已实现。真实提供方回调待验收。 |
| share-registration-link | 原注册链接、启用状态、积分奖励和领取约束；附加功能及经济测试覆盖。 |
| usm-api | 旧材质和角色协议路径；附加功能／协议测试覆盖，游戏客户端显示待验收。 |
| hide-advanced-menu | 根据原插件开关隐藏开发者应用菜单；页面断言通过，已有接口权限照常检查。 |
| refresh-ali-cdn | 提交后刷新角色相关 URL，含改名前后档案；回滚不刷新。签名与独立 PHP 向量一致，本地 POST 验证通过。源配置无云凭据，未做真实刷新。 |
| texture-description | 原描述记录、Markdown、HTML 净化、读取／编辑权限与实际列容量；管理及原库快照测试通过。 |
| legacy-api | 旧皮肤／披风 PNG 路径和缓存行为；附加功能／Web 测试覆盖。 |
| yggdrasil-api | authenticate、refresh、validate、invalidate、signout、join／hasJoined、档案和签名；44 项协议检查通过。真实启动器／双游戏客户端仍待验收。 |

云刷新按 [阿里云 RefreshObjectCaches 接口](https://help.aliyun.com/en/cdn/developer-reference/api-cdn-2018-05-10-refreshobjectcaches) 使用 POST 表单和换行分隔的 URL；测试始终指向本地模拟服务。使用隔离表前缀时不会刷新真实 CDN。

## 其他业务及验收边界

构建、23 项单测和 14 组集成套件通过，覆盖认证、积分、原生集成、Yggdrasil、正版验证、Web、外观、Connect HTTP、管理、高级搜索、跨进程 join、首次安装及旧站缺表迁移。新站在全空命名空间验证，不依赖原站数据。高级搜索有 27 组 PHP 参考查询和 15 组日期对照。验证码服务端校验参考 [reCAPTCHA 官方契约](https://developers.google.com/recaptcha/docs/verify)。

本轮浏览器检查登录、注册、找回密码、原账户确认及验证码后台设置；1440px／390px、浅色／自动深色、验证码刷新、原密码迁移和后台密钥不回显通过。常规管理设计的此前验收见 `docs/progress.md`。

以下仍不能标记为全部完成：

- 真实 Natayark ID／Microsoft／SMTP／阿里云调用和 HMCL、PCL、Prism、Minecraft 图形客户端联机。
- 旧 Laravel 浏览器会话、Janus 中正在进行的交互，以及无法恢复可靠授权绑定的旧 refresh token；这些需要重新登录／授权。
- PHP 自然语言日期解析器的全部输入和全站所有多语言文案仍未完全覆盖。常用搜索语法、日期、排序、字段投影与 invisible 模式已实现，见 [高级搜索](advanced-search.md)。
- 任意第三方 PHP 插件执行、旧 PHP 插件市场、在线更新器及原安装向导；PHP 队列任务也不会被 Node 自动执行。
- 玩家聊天证书功能标记关闭。join 状态现以加密记录存于共享数据库，支持多实例。

因此，当前可确认原始表及数据在上述业务范围内兼容，也已有旧 OAuth 账户迁移路径；不能把它表述为 Blessing Skin 全功能已 100% 完成。

## 重跑方式与本地证据

```powershell
node scripts/audit-legacy-database.mjs
node --import tsx scripts/verify-legacy-snapshot.ts
node scripts/verify-original.mjs
npm run build
npm test
npm run test:integration
```

原库审计只读；快照检查创建、清理受限定前缀的独立副本。集成测试要求 `dev_` 命名空间，测试邮件被强制重定向到本地捕获服务或禁用发送。

本地报告：`artifacts/legacy-database-audit.json`、`artifacts/legacy-snapshot-verification.json`；PHP 签名基准：`tests/fixtures/cdn-signature.json`；新增浏览器截图：`output/playwright/legacy-*.png`。报告不包含用户邮箱、密码哈希、OAuth 密钥或 SMTP 密码。
