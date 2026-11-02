# Microsoft 登录与 Minecraft 正版验证

本地实现日期：2026-10-29；单角色流程修正：2026-11-03。

## 配置与入口

- Microsoft Live 普通登录由 OAuth 适配器提供，旧 provider 名 `live`、身份映射和 `LIVE_KEY` / `LIVE_SECRET` 保留；它只用于站点登录，不代表已购买 Minecraft。
- 正版验证读取旧插件 `MICROSOFT_KEY`、`MICROSOFT_SECRET`、`MICROSOFT_REDIRECT_URI`。在 Microsoft 应用中登记 `https://你的域名/mojang/callback` 为 Web 回调，应用必须获准使用相应 Xbox/Minecraft 服务。
- 开发环境配置 `PUBLIC_ORIGIN` 时回调使用该本地源站的 `/mojang/callback`，不会将开发登录送回生产站。
- 页面：`/user/verification`。保留旧 `/mojang/verify`、`/mojang/callback`、`POST /mojang/update-uuid` 路径；页面中的发起验证和同步操作使用 POST + CSRF。
- 缺少配置时返回明确的“暂未配置”状态，不模拟验证成功。

## 认证链路

Microsoft 消费者授权码 + S256 PKCE → Microsoft token → Xbox user token → XSTS → Minecraft login_with_xbox → mcstore entitlements → Minecraft Java profile。

state 存于现有扩展表 mcn_oauth_flows，使用随机令牌的哈希索引，绑定浏览器 session.sid 和发起用户 UID，十分钟有效且一次性消费。用户在回调前退出/切换账户，或跨浏览器复制回调，均不能完成绑定。Microsoft/Xbox/Minecraft 的令牌只保留在单次请求内存中，不存库、不打印。上游请求设置超时和禁止重定向，处理授权取消、XSTS 未创建档案/地区/年龄限制、未购买/无Java角色、异常响应。

## 原数据与冲突规则

继续使用原 `mojang_verifications(user_id,uuid,verified,created_at,updated_at)`，并保留现有 `players` 与 `uuid`。数据库事务和锁保证重复/并发回调只发放一次 `mojang_verification_score_award` 奖励，已有 verified=1 记录不会重新发奖。

- 他人已绑定的正版 UUID 或他人同名角色会拒绝绑定，不自动转移他人的角色。
- 单角色插件开启且已有不同名字的角色时，验证游戏所有权仍可完成；不新增第二个角色，不改名、不改原 UUID，不动原皮肤和披风。
- 可以新增角色时，新角色免费创建，首次映射使用经过认证的正版 UUID。
- 现有角色的离线 UUID 保留，绑定不会静默覆盖。用户确认后，可通过原 POST update-uuid 明确同步。单角色模式中，唯一现有角色可更名为经过认证的正版名称，保留 PID、皮肤和披风，再同步 UUID；之后吊销旧令牌以要求启动器重新登录。
- 若目标名称属于其他用户，或单角色模式存在多个历史角色，则拒绝自动同步；不会擅自选择、转移或删除角色。UUID 变更会改变游戏服务器识别的玩家身份，页面确认框明确说明旧 UUID 下的游戏数据需要在游戏服务器处理。
- 原插件使用的 Mojang 名称历史接口已不采用；通过 session profile 按 UUID 获取当前正版名称。

自动转移/删除旧角色的行为与旧插件不同，这是数据保护约束下的明确选择，不应在迁移说明中隐去。

## 验证与边界

`npx tsx tests/mojang.integration.ts` 在 dev_ 表副本运行，当前共 31 项检查通过：完整六步上游响应链、PKCE与secret位置、XSTS错误、无所有权、同用户并发绑定与幂等奖励、跨账户UUID/同名冲突、旧UUID保留与显式同步、单角色保留及更名同步、PID/皮肤/披风保留、多个历史角色保护、缺少配置、CSRF、跨浏览器state、授权取消及重放拒绝。

这些测试的外部 HTTP 响应经过模拟；真实数据库事务与路由被实际执行。没有使用真实 Microsoft 账户完成在线授权，因此 Microsoft 应用权限、实际购买/订阅账户及真实外部回调尚需部署者验收，不能据此宣称真实正版认证已验证成功。

参考：[Microsoft 授权码与 PKCE 文档](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)，以及旧站 mojang-verification、oauth-microsoft-live 实际插件代码。
