# Minecraft 游戏内好友列表

支持 Minecraft Java 26.2、26.3 的好友列表协议。使用本站 Yggdrasil 外置登录后，本站角色可以互相发送好友申请、接受、拒绝、撤回、删除，并查看好友的在线或游戏中状态。好友关系及隐私设置按角色分别保存，同账号不同角色不会共用。

## 启用与升级

已有安装先备份数据库，再执行：

```sh
npm run migrate -- --apply
npm run build
```

迁移 `004_minecraft_friends.sql` 只新增 `mcn_social_profiles`、`mcn_friendships`，不会修改原有表字段和 UUID。新安装的 `npm run db:init -- --apply` 已包含这两张表。`DB_TABLE_PREFIX` 同样作用于扩展表及其外键。

两张扩展表存在时，ALI 元数据才返回 `meta.feature.enable_mojang_anti_features: true`，让 authlib-injector 将好友设置请求交给本站。升级后重新启动游戏，以重新获取元数据。authlib-injector 版本需要支持所用 Minecraft 版本；26.3 的 discovery 适配包含于 authlib-injector 1.2.8。

默认开启好友列表及接收申请。登录需要调整的角色后，在游戏「在线选项」中设置好友列表和是否接收申请。关闭好友列表会隐藏自己的在线状态，保留关系供重新开启后使用；关闭接收申请会阻止新申请，已收到的申请仍可接受或拒绝。

## 协议接口

以下路径同时位于 `/api/yggdrasil/minecraftservices` 和 `/minecraftservices`：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/player/attributes` | 读取该角色的好友和隐私偏好 |
| POST | `/player/attributes` | 保存部分好友或过滤偏好，返回更新后的属性 |
| GET | `/friends` | 好友、收到的申请、发出的申请 |
| PUT | `/friends` | `ADD` 申请或接受；`REMOVE` 删除、拒绝或撤回 |
| POST | `/presence` | 上报本角色状态，仅返回已确认好友的状态 |
| GET | `/privileges` | 本站客户端能力：聊天及服务器多人游戏允许，Realms 和遥测关闭 |
| GET | `/privacy/blocklist` | 空阻止列表；本次没有实现账号屏蔽管理 |

使用有效 Bearer 游戏令牌，要求绑定 `selectedProfile`、拥有 `Yggdrasil.Server.Join` 权限，且角色仍属于该账号。账号或客户端封禁、令牌到期或吊销都会失效。请求体不能指定自己的身份。

好友操作支持名字或标准带连字符/不带连字符 UUID；两者都有时以 UUID 为准。双方相向申请会确认同一条关系；重复发送同一待处理申请不会重复创建记录。每个角色的关系及待处理申请合计最多 1000 条，写入接口另有限流。

好友与在线状态轮询支持 `ETag`、`If-None-Match`、`304` 和 `Retry-After: 30`。每次仍检查鉴权。在线状态接口即使返回 `304` 也会先更新本角色心跳。状态 120 秒未更新，或最近上报使用的令牌已失效时，会显示离线；原始心跳时间不向陌生角色公开。

角色改名后返回新名字；删除角色会通过外键清理关系和偏好；替换 UUID 会建立新的社交身份，不继承旧 UUID 的好友关系。无官方 PMID 的外置角色省略 `pmid` 字段：Mojang authlib 的 UUID 解码器不能接受显式 JSON `null`。

## 验证与范围

```sh
# 必须配置隔离的 dev_ 数据表前缀
node --import tsx --test tests/friends.integration.test.ts
# 需要 JDK 21+、java/javac 或 JAVA_HOME，以及 Mojang 下载站网络访问
npm run test:friends:client
```

客户端测试下载 26.2/26.3 官方版本清单中的 authlib 和运行依赖，校验清单 SHA-1，缓存到忽略目录 `.test-artifacts/friends-authlib`。它通过真实 HTTP 调用未经修改的 authlib 9.0.75 / 10.0.77，检查好友请求与列表解码、隐私设置、在线状态及时间解码、错误处理、删除和撤回。Bearer 令牌通过子进程标准输入传递，不放入命令行参数。

本次范围是本站角色间的好友列表。不会同步 LittleSkin、微软或其他认证站的好友关系，不包含 P2P 世界邀请、NAT 穿透、Realms 或 Mojang 签名证书。官方 authlib HTTP 测试与两个完整图形游戏客户端验收是不同证据；完整客户端内的显示、皮肤加载和联机验收仍需实际完成。

核对来源：

- [LittleSkin 公开公告](https://littleskin.cn/api/announcements)
- [authlib-injector 的 Minecraft Services 重定向](https://github.com/yushijinhun/authlib-injector/blob/develop/src/main/java/moe/yushi/authlibinjector/httpd/DefaultURLRedirector.java)
- [authlib-injector 默认属性拦截](https://github.com/yushijinhun/authlib-injector/blob/develop/src/main/java/moe/yushi/authlibinjector/httpd/AntiFeaturesFilter.java)
- [26.2 官方 authlib 9.0.75](https://libraries.minecraft.net/com/mojang/authlib/9.0.75/authlib-9.0.75.jar)，SHA-1 `d61056a234d5e4b272e09d59b0713f80d6c0b6af`
- [26.3 官方 authlib 10.0.77](https://libraries.minecraft.net/com/mojang/authlib/10.0.77/authlib-10.0.77.jar)，SHA-1 `add8754cda96cf0cd840441632875648836f8a71`
