# Yggdrasil 与 Yggdrasil Connect 兼容记录

验证日期：2026-10-29。实现是内置 Node.js 服务；不再要求独立运行 Janus。下面的“已验证”指隔离数据库中的协议请求，不能代替真实启动器/图形客户端联机验收。

## 已实现并通过集成检查

- 传统 Auth Server：authenticate / refresh / validate / invalidate / signout。邮箱及角色名登录、角色绑定、多角色选择、任意字符串 clientToken、明确失效、旧密钥 JWT 验签、token 数量上限和按用户名限流。
- Session Server：join / hasJoined，严格验证 Server.Join 权限和绑定角色；会话按 serverId 与角色隔离，30 秒有效期；hasJoined 重新验证令牌，支持 IP 检查。
- Profile Server：单角色、批量角色查询及 minecraftservices 别名；无连字符 UUID、默认 unsigned、SHA1withRSA 材质属性签名、旧纹理密钥与材质 hash URL。
- 材质 PUT/DELETE：Bearer、角色所有权与绑定检查；复用站内 PNG 上传/经济规则。
- ALI 元数据：meta 下的 feature.openid_configuration_url、non_email_login、links、skinDomains 和 signaturePublickey；公开材质公钥。
- Connect：OpenID discovery、JWKS、授权码、S256 PKCE、明确同意与角色选择、nonce、state、device grant、离线刷新、userinfo、客户端令牌吊销和用户撤销授权。
- 公共客户端必须使用 S256 PKCE；保留 Janus 用 /yggc/client/public 标识公共客户端的旧数据习惯。授权页面仅使用 client_id，机密仅在令牌端点验证。支持 client_secret_basic、client_secret_post 和 none，以及旧 bcrypt 客户端机密。
- code / refresh / device 兑换使用数据库行锁及同连接事务；失败的 PKCE 不消费 code，成功兑换只可执行一次；refresh 保留角色绑定，禁止扩大 scope。

## 原数据库与密钥

users、players、uuid、options、oauth_* 和 yggc_* 沿用原表名及列。原始 uuid 无 pid 仍可读取；已有 UUID 不重算。Janus 的 grants/interactions/sessions 没有 consumed 列，只有三个一次性令牌表读写该列。

材质签名沿用 options.ygg_private_key。OIDC/访问 JWT 优先使用已有 ygg_oidc_private_key，未配置则读取 storage/oauth-private.key；新 key 只有两者都不存在时才生成。验签同时接受原 oauth-public.key。旧密码 JWT 若签名、数据库记录、账号状态、scope 和角色归属仍有效，可以继续使用。

不能承诺旧的进行中 Janus 交互或 refresh token 无缝延续：原 oidc-provider 的 payload/token 编码与本实现不同。无法恢复可靠角色/授权绑定的旧 refresh 会返回 invalid_grant，要求重新授权；不会猜测绑定关系。已有 OAuth 客户端、授权和账户数据保留。

## 验证方法

Minecraft Java 26.2/26.3 的角色好友列表已实现，包含好友申请、隐私偏好、在线状态和条件轮询。启用迁移、接口和官方 authlib HTTP 测试见 [Minecraft 好友列表](minecraft-friends.md)。这不包含 P2P 联机。

运行：`npx tsx tests/protocol.integration.ts`。脚本强制 DB_TABLE_PREFIX 以 dev_ 开头，只在隔离副本创建临时用户和应用，finally 清理。

2026-10-30 已完成 44 项检查，包括 4 并发兑换 code 只有 1 次成功、3 并发 refresh 只有 1 次成功、ID token 签名/issuer/audience/nonce、设备授权、传统登录、join→hasJoined、跨角色拒绝、旧纹理公钥验签及 RFC 7009 吊销；新增 POST 授权／UserInfo、动态 loopback 端口、缺少 Join 权限、刷新范围扩大及 HTTP 错误检查。

`tests/connect-http.integration.test.ts` 另用独立 `openid-client` 6 通过实际 HTTP 验证发现、授权 HTML／CSRF／角色选择、S256、ID token 的 RS256 签名、UserInfo subject、刷新、Minecraft join／hasJoined 以及吊销。授权、令牌、UserInfo 和 JWKS 都由同一个应用提供，无需 Janus。

2026-11 修复了响应早于事务提交的竞态：授权确认、拒绝、令牌签发／刷新及注销均在 COMMIT 成功后发送响应；提交失败会回滚并返回错误。`tests/oidc-transactions.integration.test.ts` 用提交屏障和故障注入覆盖 16 个场景，验证提交期间不会提前返回令牌、重定向或成功响应，提交后状态立即可见，失败后仍可使用原状态。这些检查已加入完整数据库集成测试。

保留 `/auth`、`/token`、`/jwks`、`/device/auth`、`/device`、`/token/revocation` 等 Janus 常用路径及已有 `/oauth/*` 别名。UserInfo 的三个地址支持 GET／POST，旧 `/yggc/userinfo` 也支持表单 Bearer；拒绝重复令牌传输方式。UserInfo 旧别名支持 CORS；令牌、设备授权与 UserInfo 响应使用 no-store。

## 渲染服务(2026-10-29 重写)

`services/render.ts` 参考 blessing/texture-renderer：逐纹素四边形、正交投影、画家算法顺序、2× 超采样。已修复投影未应用和身体面片重复偏移；Alex UV、手臂连接及 HD 外层采用正确的 Minecraft 布局。端点行为：

- `/avatar/*`:仅头部;2D 平面(默认)与 `?3d` 等距;`size` 输出精确尺寸;无材质时使用旧站自带的 `storage/misc/avatar2d.png` / `avatar3d.png` 默认图;披风材质 422;用户不存在返回默认头像(与旧站一致,不再是 404)。
- `/preview/*`:皮肤为前后双等距视图(ratio 12,与旧站几何一致);披风按 `?height` 缩放并加边距。
- avatar/preview 带 ETag(md5)+ Last-Modified(纹理文件 mtime)+ 304 + `public, max-age=cache_expire_time`;内存缓存 TTL 跟随 `enable_avatar_cache` / `enable_preview_cache`。
- 默认无损 WebP，`?png` 输出 PNG；两种编码具有各自 ETag。PNG 解析容忍 IEND 后的尾随字节。披风缓存区分请求高度，预览 URL 带渲染版本避免旧浏览器缓存。
- 实际用旧 PHP + GD 生成默认皮肤参考图并回归比较；抗锯齿存在差异，不能据此称所有图像逐像素一致。
- 前端共享 `[data-skin-viewer]` 组件，用 skinview3d v3 显式创建 canvas；支持行走／奔跑、旋转、暂停、重置、2D／3D、模型、披风及背景。隐藏／离屏时暂停，离开页面释放资源，支持减少动态效果及加载骨架。

## 尚不能宣称全兼容的边界


- 未经过 HMCL/PCL/Prism 等实际启动器及两个真实 Minecraft 图形客户端联机验收。
- join 状态存于共享数据库的短期认证表，保留 30 秒；使用 AES-256-GCM 加密，所有实例共享数据库和 APP_KEY。独立进程及重启、过期、吊销、密文损坏均有检查。
- 聊天玩家证书 POST /minecraftservices/player/certificates 未实现，feature.enable_profile_key 明确为 false。公钥 API 不声称已提供聊天证书。
- 不支持动态客户端注册、隐式流、password/client_credentials grant、DPoP、PAR 等可选功能；发现文档只广告实际实现的功能。
- 手写 Connect 提供者没有获得 OpenID Foundation 认证。规范覆盖测试不等于通过官方 OIDC conformance suite。
- 仅承诺已列明的原始插件数据兼容，不能直接运行 PHP 插件代码。

## 核对来源

- 工作区 .refs/yggc-spec.md 与 .refs/yggc-spec.json。
- 旧站 plugins/yggdrasil-connect 和 .refs/janus 的实际代码/表定义。
- authlib-injector 官方当前规范：https://yushijinhun.github.io/authlib-injector/zh/Yggdrasil-%E6%9C%8D%E5%8A%A1%E7%AB%AF%E6%8A%80%E6%9C%AF%E8%A7%84%E8%8C%83.html
- Yggdrasil Connect 原提案：https://github.com/yushijinhun/authlib-injector/issues/268
- RFC 7636、RFC 8628、RFC 7009 及 OpenID Connect Core 1.0。
