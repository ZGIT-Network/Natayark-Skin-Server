# 高级搜索

用户、角色和举报管理页面，以及 `/admin/{users,players,reports}/list`、`/api/admin/{users,players,reports}` 共用解析器。旧接口使用 `q`，页面使用 `keyword`。

## 条件

```text
uid:123
nickname:"Alice Smith"
score>=100 verified
uid in (1,2,3)
permission:-1,0
not verified
(permission:0 or permission:1) score>0
not (uid:1 or uid:2)
email:NULL
not email:NULL
```

冒号和等号用于精确匹配。空格相当于 `and`，`and` 的优先级高于 `or`；括号可以改变组合顺序。含空格的值加引号。`NULL` 是特殊空值，带引号的 `"NULL"` 是普通字符串。布尔字段建议使用 `verified`／`not verified` 或数值条件 `verified:1`／`verified:0`。

普通文本搜索用户的邮箱和昵称、角色的名称或举报理由。页面还支持纯数字 ID 查询。

## 字段

| 对象 | 可用字段 |
| --- | --- |
| 用户 | uid、email、nickname、avatar、score、permission、ip、last_sign_at、register_at、verified、is_dark_mode |
| 角色 | pid、uid、name、tid_skin／skin、tid_cape／cape、last_modified |
| 举报 | id、tid、uploader、reporter、reason、status、report_at |

密码、remember token 等不在可检索或显示字段中。字段名、排序和投影均采用允许列表，值通过 SQL 参数绑定。

## 日期

```text
register_at:2020
register_at>=2020-01
register_at:"2020-12-31 16:30"
register_at:"Dec 31 2020 5pm"
register_at:today
register_at>=tomorrow
register_at:"3 days ago"
```

年、月、日、小时和分钟会按精度展开范围，使用站点 `TZ` 时区。比较符遵守范围边界，例如 `>2020` 表示晚于该年末，`>=2020` 从年初开始。日期范围的否定按“在范围外”处理，修正了参考实现中不可能同时满足的前后边界组合。

支持常用绝对日期、today／yesterday／tomorrow／now，以及部分相对日期。不会宣称兼容 PHP 日期解析器的所有自然语言表达式。

## 排序与投影

```text
score>0 sort:-score,uid
uid in (1,2) fields:uid,nickname
not fields:email,ip
```

`-` 表示降序。JSON 列表接口支持 `fields`；HTML 表格仍保留操作所需的列。`limit`、`from` 可被识别和校验，但列表接口和页面的分页参数优先，与原分页行为一致。

非法字段、未闭合引号、缺失条件或过深嵌套返回 422，并在页面显示错误 message，保留输入。单次表达式最多 4096 字符、512 个词法单元和 32 层嵌套。
