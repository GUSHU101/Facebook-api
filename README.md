# CAPI SaaS 数据中枢

这是一个部署在私有 VPS 上的 Shopify Customer Events 数据中枢，用于将店铺事件可靠地发送到 Meta Conversions API 和 TikTok Events API。

本项目按“独立服务端 + Shopify 自建未上架应用 + Shopify 客户事件自定义像素”设计，不包含 App Store 上架、OAuth 安装页或主题脚本注入：自建应用只提供订单 Webhook、Admin API Token 和 Client Secret；浏览器事件来自店铺后台 `Settings → Customer events` 中粘贴的生成代码。

管理后台使用仓库内固定版本的 Tailwind CSS 和 Vue 浏览器资源，不依赖运行时 CDN。修改后台 HTML/CSS 或升级 Vue 后，请运行：

```bash
npm install
npm run build:admin
```

然后提交重新生成的 `src/public/admin.css` 和 `src/public/vue.global.prod.js`。生产服务器不需要安装这些开发依赖，因为编译后的资源已经包含在仓库中。

先选择一种部署方式，二者不要混用：

- 纯 Ubuntu VPS：[Ubuntu 一键部署指南](DEPLOY_UBUNTU_ONECLICK.md)
- 宝塔 Node 项目部署：[宝塔完整部署指南](DEPLOY_BAOTA_UBUNTU.md)。宝塔用户更新代码后统一运行
  `sudo bash deploy/update_baota.sh`；脚本会先做数据库与 `.env` 快照、按项目所有者管理唯一 Worker，并在失败时保留维护模式。不要再手工寻找 Node/psql、创建 `/tmp` 脚本或用 PM2 重复启动 API。
- 发布前检查：[GitHub 发布检查清单](GITHUB_RELEASE_CHECKLIST.md)

Ubuntu 一键安装示例：

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=your_cloudflare_api_token \
    CF_Zone_ID=your_cloudflare_zone_id \
    bash /tmp/capi-install.sh
```

安装器会自动安装缺失的 Ubuntu 依赖，并在未提供密码时生成强随机密钥。设置 `AUTO_SSL=1` 后，它会通过 acme.sh DNS-01 签发证书、启用非 443 HTTPS，并可将 HTTP 重定向到 `https://域名:8443`。如果已经有 DNS 验证签发的证书，可传入 `CERT_FULLCHAIN=/path/fullchain.pem CERT_KEY=/path/privkey.pem`。

## 采集的事件

生成的 Shopify 自定义像素订阅 Shopify Customer Events，使用稳定的 `event_id` 同时完成两条 Meta 链路：在 Shopify Lax sandbox 中加载官方 Meta Pixel SDK 并发送浏览器事件，同时把同一事件持久化到本数据中枢，由服务端按照保存的路由投递 Meta CAPI。两条链路的 `event_name` 与 `eventID` 完全一致，供 Meta 做 Pixel/CAPI 去重；TikTok 仍使用本项目的服务端 Events API 链路。

浏览器 Meta Pixel 使用 `trackSingle`/`trackSingleCustom` 定向发送到当前店铺关联的每一个 Meta Dataset，不会因为同一自定义像素初始化了多个 Dataset 而交叉广播。SDK 加载、单个 Dataset 的浏览器发送失败或广告拦截不会阻止事件进入 PostgreSQL/CAPI。Shopify 自定义像素只能访问 Lax sandbox 提供的页面能力，不能抓取顶层页面 DOM；页面 URL、商品、结账和客户字段始终以 Shopify Customer Events 数据为准。

生成代码可以携带已配置的 Meta/TikTok Pixel ID 作为诊断提示，但真正的投递目标始终由服务端保存的像素路由决定，客户端传入的 ID 无权选择投递目标。

### Meta 标准事件

- `page_viewed` → `PageView`
- `product_viewed` → `ViewContent`
- `product_added_to_cart` → `AddToCart`
- `checkout_started` → `InitiateCheckout`
- `payment_info_submitted` → `AddPaymentInfo`
- `checkout_completed` → 持久化的 `Purchase` 候选；只有验证通过的 `orders/paid` 到达后才允许投递
- `search_submitted` → `Search`

### Meta 自定义事件

- `alert_displayed` → `ShopifyAlertDisplayed`（仅发送类型/字段目标，不发送提示原文或输入值）
- `cart_viewed` → `CartView`
- `collection_viewed` → `CollectionView`
- `product_removed_from_cart` → `RemoveFromCart`
- `checkout_contact_info_submitted` → `CheckoutContactInfoSubmitted`
- `checkout_address_info_submitted` → `CheckoutAddressInfoSubmitted`
- `checkout_shipping_info_submitted` → `CheckoutShippingInfoSubmitted`
- `ui_extension_errored` → `ShopifyUiExtensionErrored`（仅发送扩展标签/错误类型，不发送消息或堆栈）

### TikTok 事件映射

- `PageView` → `PageView`
- `ViewContent` → `ViewContent`
- `AddToCart` → `AddToCart`
- `InitiateCheckout` → `InitiateCheckout`
- `AddPaymentInfo` → `AddPaymentInfo`
- `Purchase` → `Purchase`（TikTok 当前标准事件名）
- `Search` → `Search`
- Shopify 自定义事件保留生成的自定义事件名

## 准确性与可靠性说明

- Meta 服务端去重依赖 Shopify Customer Events 和订单 webhook 之间保持一致的 `event_name` 与 `event_id`。
- 新生成的 `shopify-pixel-v26` 会给所有事件 ID 及浏览器/CAPI `order_id` 加入店铺域名命名空间。AddToCart、InitiateCheckout 和 AddPaymentInfo 使用同一个 Shopify `event.id` 同时发送浏览器 Pixel 与 CAPI；Purchase 只把浏览器数据保存为 `AWAITING_PAYMENT` 候选，待 `orders/paid` 确认后由服务端 CAPI 发送，避免无法撤回的浏览器 Purchase 提前计入未付款、延期付款或失败订单。Purchase 仍以 checkout/order 为订单粒度并使用持久别名稳定合并。多个店铺共用同一个 Meta Dataset 时，即使 Shopify 局部 ID、订单号或顾客 ID 相同，也不会在 Dataset 侧互相去重或混淆。浏览器代码通过店铺采集 Token 获取服务器当前活动 Meta 路由，并每 60 秒刷新一次；新增、停用或重新分配 Pixel 不再要求为了路由列表单独重新粘贴代码。网络异常时使用生成时内嵌列表回退，服务端数据库路由始终是 CAPI 唯一投递权威。v26 还按 Meta 官方 Parameter Builder 规则在落地页尽早捕获、续期并原样保留 `_fbp/_fbc`，仅用真实、大小写不变的 `fbclid` 更新 `_fbc`，并优先合并创建时间更新的 Cookie。管理后台会在复制前移除缩进、注释和多余空行，保留全部逻辑并确保代码低于 Shopify 自定义像素 64,000 字符上限。
- v26 在首次真实的非 Purchase 浏览器事件上用 Meta Pixel `fbq('init', pixelId, userData)` 发送官方高级匹配字段；浏览器由 Pixel 自行哈希，服务端仍发送规范化后的 SHA-256，双方 `external_id` 使用同一店铺命名空间。服务端也原样接受 Meta Parameter Builder 生成的大小写敏感哈希附录，不再误删或二次哈希。新客/老客状态只发送为官方 `custom_data.customer_segmentation` 枚举，不发送未定义的 ServerEvent 根字段。
- v26 会在真实事件进入网关时更新不含客户信息的运行版本状态（同版本最多每 15 分钟写一次），后台可以确认每个店铺真正运行的像素版本而不额外向每位访客发送心跳。队列容量淘汰、本地存储失败、六天重试窗口到期、重试次数耗尽、服务器永久拒绝和批量请求中的单条拒绝都会写入独立诊断表；成功条目仍按响应顺序确认，不会因同批一条坏数据而重发或误删整批。批量响应不再在循环内声明捕获外层变量的函数，可通过 Shopify Customer Events 的静态检查。
- v26 通过 Shopify 官方 `all_standard_events` 聚合订阅监测未来新增事件；已支持的 15 个事件仍由逐项 schema 处理，新出现的事件名只写入脱敏兼容性诊断，不会盲目上传未知字段。Checkout Extensibility 的套装商品会按官方 `lineComponents` 映射真实组件 Variant；普通商品继续使用顶层 Variant。`npm run audit:shopify-pixel` 会验证纯 JavaScript、官方 Browser/Privacy API、事件覆盖、套装映射、语法和 64,000 字符限制。
- TikTok 服务端投递保留相同的 `event_id`，并使用当前标准事件名 `Purchase`。
- `Purchase` 使用持久化别名注册表：PostgreSQL 事务锁统一 checkout、order、cart 标识，即使 Redis 重启也不会丢失关联。浏览器和 webhook 数据在投递前会合并到准确的 `(shop_id, event_name, event_id)`；不存在可能与数据库权威状态分叉的只写 Redis 去重副本。
- 重复事件在行锁事务内合并：邮箱、电话、姓名、地址和 `external_id` 哈希数组取并集并重新计算 EMQ；付款确认数据优先于未确认浏览器副本，晚到的重复请求不能降低已确认金额、订单号或付款时间。
- Meta 客户字段按官方规则规范化后才进行 SHA-256：邮箱只做首尾清理与小写化并拒绝内部空白，电话仅保留数字并去掉前导零，姓名保留 UTF-8 字母（例如 `é` 和中文），城市/州移除标点与变音符号，美国邮编只取前 5 位，国家只接受 ISO 两位代码。无效哈希、IP、`fbp`、`fbc` 会在外发前剔除，不会把格式正确但永远无法匹配的数据提交给 Meta。
- 浏览器采集接口以反向代理确认后的请求 IP 和请求头 User-Agent 为准，JSON 不能伪造并污染稍后合并的付款事件；Shopify webhook 自身的服务器 IP/UA 不会被误当成顾客信号。可用的来源页会作为 `referrer_url` 一并发送。
- `contents` 是商品快照的权威来源，`content_ids` 会从同一快照重新生成。已付款订单覆盖旧购物车时不会把已移除商品并入 Purchase；`num_items` 仅发送给 `InitiateCheckout`，`search_string` 仅发送给 `Search`。
- `shop_pixel_routes` 提供多对多路由能力，默认通过 `ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=true` 允许多个 Shopify 店铺向同一个 Meta Dataset 积累学习信号。本地事件、动作级 ID、订单别名、归因缓存、去重、重试、测试代码和投递账本始终按认证后的 `shop_id` 隔离；客户端路由提示永远不能选择投递目标。需要强制一店一数据集时可把该开关设为 `false`。
- 多个店铺共用同一个 Meta Dataset 时，Meta 侧的报表、优化和受众本来就是该 Dataset 的汇总视图；本项目隔离店铺身份、事件标识、归因缓存、投递账本和故障状态，但不会把一个外部 Dataset 虚拟拆成多份 Meta 报表。需要完全独立的报表、优化或受众边界时，应为店铺配置不同的 Dataset。
- 共享 Pixel 的 Access Token/限流组使用持久化 `credential_version` 栅栏。管理员轮换凭证时，旧 Worker 的失败结果不能覆盖新凭证状态；若请求已经被旧 Token 成功接收，稳定的店铺级事件 ID 仍允许安全确认。Token 修复后，系统只重新打开 401/403、10、102、190、200、463、467、803、2500 等凭证/权限类永久失败，并唤醒该 Pixel 当前绑定的全部店铺，不会重放已成功或商品数据本身无效的事件。
- Meta Test Event Code 按店铺路由保存且仅用于该路由的服务端 CAPI 请求；默认 30 分钟自动失效，避免生产事件长期停留在测试链路。它不会影响共享 Pixel 下的其他店铺，也不能把浏览器 Pixel 调用切换为 CAPI 测试事件。
- Meta Dataset Quality 拉取与正式 CAPI 投递使用同一个 Token/限流组租约和冷却作用域。请求严格使用官方可执行示例中的 `dedupe_key_feedback{...}`（注意是 `dedupe`，不是会触发 `#100 Tried accessing nonexisting field (dedup_key_feedback)` 的 `dedup`），并显式拉取 EMQ、覆盖率、新鲜度、ACR 和潜在 ACR 提升；仍兼容解析历史响应中的两种拼写。若 Meta 灰度 schema 暂不提供某个可选投影，会自动用保守字段集重试，不让单个诊断字段导致整份质量快照失败。如 Meta 已同意平台标识，可配置 `META_PARTNER_AGENT` 并用 `META_QUALITY_AGENT_NAME` 筛选该集成产生的质量数据；不能自行编造 partner agent。
- `event_deliveries` 是每个事件、每条路由的持久投递账本。Worker 首次处理事件时会在事务和店铺级咨询锁内保存 `delivery_route_snapshot`，父事件只有在该快照里的全部路由均有账本且到达终态后才能成功。投递中新增或重新启用的路由只影响尚未建立快照的积压和后续事件，不会让已处理事件的成功判定随配置漂移。唯一键 `(event_store_id, route_id)`、租约、尝试次数、重试时间和终态成功记录，可防止某个店铺或失败像素覆盖其他路由。即使未来应用代码出现缺陷，PostgreSQL 触发器也会拒绝跨店事件与路由组合。
- 从共享凭证移除店铺时只会停用对应路由，不会删除历史投递证据；重新添加时会重新激活原路由。
- 后台“归档” Pixel 会在一个事务中停用路由、把未完成投递终结为 `ROUTE_ARCHIVED`、清除不再需要的 Token，并保留凭证、路由和投递审计行。数据库外键也禁止物理删除 Pixel 或路由时级联抹掉历史账本。
- 没有配置像素前收到的事件会持久保留为 `PENDING`；新增或重新激活路由后会唤醒该店铺的积压事件，而不是静默丢弃。
- 接口会先把标准化事件写入 PostgreSQL，再返回 `202`。Redis/BullMQ 只用于加速调度，不再是事件的唯一副本；如果持久写入后 Redis 不可用，Redis 恢复后看门狗会继续派发 PostgreSQL 出箱事件。
- 平台部分失败时会保留逐路由历史。重放或重试部分失败事件时，标记为 `SUCCESS` 的路由永远不会再次领取，只发送待处理或可重试路由。
- 手动重放死信先使用同一套事务合并规则吸收载荷，只重置当前启用且永久失败的路由；成功路由保持不可变，停用路由保持停用，未确认付款的 Purchase 也不能通过重放绕过付款门禁。
- 共享凭证使用可续期的分布式投递租约和逐次尝试隔离。过期 Worker 不能覆盖较新的尝试，共用凭证的多个店铺也不会并发冲击同一个平台凭证。
- Meta 响应头 `Retry-After`、`X-Business-Use-Case-Usage`、`X-App-Usage`、`X-Ad-Account-Usage` 会形成持久化的凭证冷却。使用率过高时会提前减缓后续发送，收到 429 后会暂停所有共用该凭证的店铺。
- 店铺采集 Token 是嵌入 Shopify 自定义像素的公开路由凭据，不等同于用户身份认证。默认启用较宽松的店铺/IP 限流（`PIXEL_RATE_LIMIT_PER_MINUTE=600`，按“事件数”和“每 16 KiB 请求体单位数”中的较大值计费）：多 API 实例通过 Redis 共用计数，Redis 故障时自动降级为进程内限流；浏览器会对 `429` 使用稳定事件 ID 重试。只有前置 CDN/WAF 已提供可靠限流时才应显式设为 `0`。
- Shopify GraphQL 对账会逐页读取订单商品行，最终事件默认保留最多 `COMMERCE_ITEM_LIMIT=1000` 行，而不是旧版固定 200 行；超过明确运维上限时会记录截断诊断。该上限可调到 5000，用于在超大订单保真度与单事件内存/请求体积之间建立可控边界。
- Shopify Admin GraphQL 的幂等查询会对 HTTP 429/5xx、暂时性网络错误以及 GraphQL `THROTTLED` 做有上限的指数退避，并在配置的等待上限内参考 `Retry-After` 与 GraphQL cost/throttleStatus。Webhook 创建等 mutation 不自动重试，避免请求实际成功但响应丢失时重复写入；下一轮只读审计会安全确认最终状态。可用 `SHOPIFY_GRAPHQL_MAX_ATTEMPTS`、`SHOPIFY_GRAPHQL_RETRY_BASE_MS` 和 `SHOPIFY_GRAPHQL_RETRY_MAX_MS` 调整。
- Shopify 客户事件代码运行在沙箱中，网络请求的浏览器 Origin 不应被假定为店铺自定义域名。采集与 Pixel 配置接口本身不使用 Cookie 凭据，建议保持 `CORS_ORIGIN=*`；安全边界由店铺采集 Token、服务端店铺查找、批次同租户验证、限流和数据库路由共同提供。管理接口没有启用 CORS。
- Shopify `orders/paid` 在 HMAC 验证后先持久化到 PostgreSQL 收件箱并立即确认，随后通过租约、指数退避和定时扫描生成 Purchase；外部平台或 Redis 短暂故障不会阻塞 Shopify 的确认窗口。
- 系统会定时通过 Shopify Admin GraphQL 只读审计 `ORDERS_PAID` 的店铺级订阅，并在后台显示 `HEALTHY`、`MISSING`、`URI_MISMATCH` 或错误状态。管理员可点击“修复 Webhook”只在正确公网 URI 缺失时创建订阅；已有其他 URI 不会被自动删除，避免误改外部系统。
- webhook 原始 JSON 会以大整数安全模式重新解析，Shopify 64 位订单、商品和变体 ID 不会先被 JavaScript 浮点数改写末位数字。
- 店铺可选保存具备 `read_orders` 的 Admin API Token。系统按 Shopify 官方 `orders` 查询的 `updated_at`、`financial_status:paid` 过滤器分页对账，并继续分页读取每个订单的全部 line items；同时补充订单邮箱、电话、地址、客户/checkout/cart 标识、客户端 IP、成功交易与客户旅程。在当前 Admin GraphQL 订单结构没有可靠 User-Agent 时，只从该 checkout 的先前浏览器事件恢复真实 UA，绝不伪造；无法恢复的网站事件会进入本地校验诊断。Purchase 时间优先使用最后一笔成功 `SALE/CAPTURE` 的 `processedAt`，无交易时间时只回退到稳定的订单 `processedAt`/`createdAt`；`updatedAt` 仅作为增量扫描游标，不能再把历史订单改写成最近转化。后台事件日志分别显示发生时间、收集时间及时间来源。失效游标会在同一窗口内安全重扫一次，对账订单仍进入同一收件箱和 Purchase 去重事务。
- 后台已付款订单闭环按 `shop_id + order_identity` 隔离，分别显示符合网站来源、已进入 Purchase 台账、Meta 成功、待处理、永久失败、本地校验异常和未入台账数量；不同店铺碰巧使用相同订单号或标识时不会再被合并统计。
- 平台回写以内部 `event_store.id` 为准，公开 `event_id` 只承担平台去重；即使不同事件名称偶然复用同一个公开 ID，也不会互相覆盖投递状态。
- 相同平台访问令牌会映射到同一分布式凭据作用域，共享租约、请求节奏和冷却状态；作用域与冷却同时保存在 PostgreSQL，Redis 或进程重启后也不会让多个店铺/像素立即同时冲击同一平台额度。
- 如果不同 Token 仍属于同一 Meta App、Business Use Case 或其他共享平台额度，可在后台填写相同“平台限流组”；系统会让这些 Token 共用租约、节奏和冷却。不同业务额度必须使用不同组名，避免无关像素互相限速。
- 浏览器 `checkout_completed` 会持久保存包含归因与结账数据的 `AWAITING_PAYMENT` Purchase 候选。在相同 checkout/order/cart 别名的 HMAC 验证 `orders/paid` 确认付款前，不会向广告平台发送，避免把未付款、延期付款、付款失败或货到付款订单计为已付款购买。
- Shopify 测试订单会被排除，已付款订单使用网站来源正向白名单。`SHOPIFY_WEB_ORDER_SOURCES=web` 是安全默认值；只有确认某个 Headless/自定义销售渠道属于被跟踪网站时，才应加入对应来源。来源缺失、POS、移动 App、草稿订单和未知来源不会创建网站 Purchase。缺少稳定订单标识或金额/币种无效的付款数据会被拒绝，让 Shopify 进行重试，而不是静默创建不可用转化。
- 已确认 Purchase 保留短暂合并窗口（`PURCHASE_SETTLE_MS`，默认 8000 毫秒），让时间接近的浏览器数据与 webhook 数据在平台投递前完成合并。
- 仍为 `PENDING` 的过期数据库事件，会在活跃路由到期可发送时按照 `DELIVERY_RESCUE_MINUTES` 自动重新入队，可从队列元数据丢失、旧版本残留或部署中断中恢复，同时避免在平台冷却期间空转。
- Worker 在竞争共享凭证前会先确认该路由确有到期事件；已成功、永久失败、仍在租约内或尚未到重试时间的路由不会制造锁竞争和空任务。
- 队列任务只携带 `shopId`；Worker 会使用 `shop_id` 和 `PENDING` 条件重新读取有界 PostgreSQL 批次。损坏或过期的队列负载无法把其他店铺事件拉入当前任务。
- `WORKER_EVENT_BATCH_SIZE` 限制繁忙店铺或共享凭证单次占用 Worker 的时间。成功批次会持续创建后续任务直至数据库积压清空，救援游标会轮换店铺，避免大店铺饿死小店铺。
- 只有 Purchase 使用咨询锁别名注册表；其他事件直接使用 `(shop_id, event_name, event_id)` 唯一索引，避免不必要的锁和别名表增长。
- 每小时的有界清理只删除旧终态事件、超过 `EVENT_RETENTION_DAYS` 仍未付款的候选以及过期诊断数据，永远不会删除等待投递的 `PENDING`。这样既保留付款确认窗口，也不会让永久未付款候选无限占用数据库。规模化索引通过 `CREATE INDEX CONCURRENTLY` 在线创建。
- 后台同时显示数据库总量、事件账本和 Webhook 收件箱占用。`PENDING` 不会为节省空间而被静默删除，因此必须结合“数据库积压、最老待处理、无路由待处理”和磁盘监控提前扩容或修复路由；这是保证流量高峰不丢事件的必要运维边界。
- PostgreSQL 健康但 Redis 暂时不可用，或没有活跃 Worker 心跳时，`/readyz` 返回 HTTP 503 和 `status=degraded`，使宝塔、负载均衡器和部署脚本不会把“只能持久化、不能立即派发”误判为完全就绪。`/healthz` 仍用于 API 进程存活检查；已经到达 API 的采集请求仍可持久写入，Redis/Worker 恢复后由看门狗恢复投递。
- PostgreSQL 账本协调任务会修复“所有逐路由投递已终结、但父事件汇总尚未更新”这一狭窄崩溃窗口。它使用事务咨询锁和有界 `SKIP LOCKED` 批次，多 API 实例不会竞争或无限扫描积压。
- 重复付款 webhook 只能解锁 `AWAITING_PAYMENT` Purchase，不能复活 `SUCCESS`、`FAILED` 或 `PARTIAL_FAILED`，也不能重发已成功路由。
- Redis 缓存、生产者和锁命令在网络分区时快速失败，独立 BullMQ Worker 连接继续重连，防止 HTTP 请求堆积在无限 Redis 离线队列后面。
- 生成的 Shopify 像素会串行化本地存储写入，并在收到确认前保留发送中的批次。页面关闭最多造成使用相同稳定 ID 的安全重试，不会用新事件覆盖尚未确认的旧事件。
- 离线队列遇到同一事件的后续完整副本时，会合入更新的客户/商品字段；未确认事件保留最早发生时间，付款确认副本则权威覆盖 Purchase 时间。达到浏览器存储上限时优先保留 Purchase、AddPaymentInfo、InitiateCheckout 和 AddToCart，并优先淘汰较旧 PageView，避免流量峰值先挤掉高价值转化。
- 同秒调度任务如果碰到 BullMQ 中仍保留的已完成任务 ID，会自动创建唯一后续任务，避免新入库事件等待下一轮救援扫描。
- `LEGACY_REDIS_DRAIN_ENABLED=false` 可避免为过时的 Redis 列表队列扫描所有店铺。只有升级仍含旧版 Redis 列表数据的部署时才临时启用。
- Shopify 像素通过 Web Pixels `browser.cookie` API 保存真实 `_fbp`、`_fbc` 和点击 ID，不依赖 DOM。只有存在真实 `fbclid` 时才创建 `_fbc`；Meta `_fbp` 和 TikTok `_ttp` 只有在真实 Cookie 已存在时才转发，网关不会伪造浏览器标识。
- 归因缓存按店铺和键类型隔离：浏览器/会话键只保存浏览器与点击信号，客户哈希和 checkout/cart 身份只允许进入交易键；顾客 `external_id` 不会被当作跨设备浏览器键，缓存新旧顺序由服务端时间决定。
- Shopify `checkout_completed` 通常在感谢页对每次结账触发一次；加购后优惠流程可能更早触发，如果相关页面没有加载也可能缺失。因此必需的 `orders/paid` webhook 同时承担付款权威来源和服务端兜底职责。
- App 未获得受保护客户数据权限时，Shopify 可能把客户字段返回为 `null`。生成像素能容忍缺失的邮箱、电话、姓名和地址。
- 在权限允许时，组合 `_fbp`、`_fbc`、浏览器 User-Agent、服务端 IP、Shopify `clientId`、邮箱、电话、姓名和地址，可获得更好的事件匹配质量。显式哈希字段必须是有效的 64 位 SHA-256，或 Meta Parameter Builder 返回的完整“SHA-256 + 大小写敏感 8 字符/旧 2 字符附录”；无国际前缀的本地电话号码只有在 US/CA 且能可靠补齐国家码时才使用，其他无法确定国家码的号码会被省略而不是制造错误匹配。
- Shopify 明确提供首次订单状态时，会在本系统私有 `_source.customer_lifecycle` 中保留新客/老客诊断信息；该信息不会作为未被官方 ServerEvent 定义的 Meta 根字段发送，未知状态也不会猜测。
- 本项目生成代码已经包含漏斗前置事件的浏览器 Meta Pixel，Purchase 则仅由付款确认后的 CAPI 发送。相同 Meta Dataset 不应再同时启用 Shopify Facebook & Instagram、GTM、主题 Meta Pixel 或另一套 CAPI；外部来源尤其可能在付款前发送 Purchase，且无法复用本项目的付款权威状态与稳定 ID。Meta CAPI→CAPI 重复不会依靠 `fbp`/`external_id` 去重；无法统一 ID 时必须停用重复事件源。
- 浏览器拦截、用户同意、平台隐私规则和结账界面限制都可能抑制事件或标识，因此任何实现都无法诚实保证 100% 采集。本项目尽量覆盖官方事件，并使用订单 webhook 为 Purchase 提供服务端兜底。只有你拥有或已获授权的店铺才应共用 Business Tools/Dataset，并且每个店铺仍须独立满足适用的告知、同意和隐私义务。

## 安装与配置

1. 安装依赖：

   ```bash
   npm install
   ```

2. 创建或更新 PostgreSQL 数据表：

   ```bash
   npm run migrate
   ```

   `npm run migrate` 会应用统一数据库结构并在线创建规模化索引。它可安全用于新数据库和已有数据库，不会删除业务数据。
   迁移必须使用 `.env` 中 `DATABASE_URL` 指定的应用数据库用户执行，不要用 `postgres` 直接导入 `init.sql`。
   如果宝塔或旧部署已经把表创建为 `postgres` 所有，可执行一次 `sudo bash scripts/repair-db-ownership.sh`；
   它会把专用数据库的 `public` schema、项目表和序列转交给应用用户，之后升级无需重复手工授权。

3. 配置 `.env`：

   ```env
   PORT=3000
   DATABASE_URL=postgres://user:password@host:5432/db
   REDIS_URL=redis://host:6379
   FB_API_VERSION=v26.0
   REQUIRE_INGEST_TOKEN=true
   SHOPIFY_WEB_ORDER_SOURCES=web
   SHOPIFY_API_VERSION=2026-07
   SHOPIFY_GRAPHQL_MAX_ATTEMPTS=3
   SHOPIFY_GRAPHQL_RETRY_BASE_MS=1000
   SHOPIFY_GRAPHQL_RETRY_MAX_MS=15000
   SHOPIFY_RECONCILE_CRON="23 */15 * * * *"
   SHOPIFY_WEBHOOK_AUDIT_CRON="41 7 * * * *"
   SHOPIFY_RECONCILE_LOOKBACK_HOURS=144
   TEST_EVENT_CODE_TTL_MINUTES=30
   SHOPIFY_RECONCILE_MAX_ORDERS=1000
   SHOPIFY_RECONCILE_MAX_LINE_ITEM_PAGES=100
   HTTP_REQUEST_TIMEOUT_MS=30000
   HTTP_HEADERS_TIMEOUT_MS=15000
   HTTP_KEEP_ALIVE_TIMEOUT_MS=5000
   SHUTDOWN_TIMEOUT_MS=120000
   DELIVERY_RETRY_BASE_SECONDS=5
   DELIVERY_RETRY_MAX_SECONDS=900
   DELIVERY_RETRY_AFTER_MAX_SECONDS=86400
   # 0 表示在事件年龄验证到期前持续重试暂时性失败。
   DELIVERY_MAX_ATTEMPTS=0
   DELIVERY_RESCUE_MINUTES=1
   AGGREGATE_RECONCILE_BATCH_SIZE=5000
   CREDENTIAL_LEASE_MS=60000
   CREDENTIAL_BUSY_DELAY_SECONDS=2
   FACEBOOK_ISOLATION_MAX_REQUESTS=16
   PIXEL_RATE_LIMIT_PER_MINUTE=600
   COMMERCE_ITEM_LIMIT=1000
   # 只有所有店铺来源都允许提交事件时才使用 *，否则填写准确 Origin。
   CORS_ORIGIN=*
   TRUST_PROXY_HOPS=1
   DB_POOL_MAX=20
   DB_IDLE_TIMEOUT_MS=30000
   DB_CONNECTION_TIMEOUT_MS=10000
   DB_STATEMENT_TIMEOUT_MS=30000
   DB_POOL_MAX_USES=7500
   LEGACY_REDIS_DRAIN_ENABLED=false
   WORKER_EVENT_BATCH_SIZE=100
   DELIVERY_RESCUE_SHOP_LIMIT=500
   CLEANUP_CRON="17 * * * *"
   CLEANUP_BATCH_SIZE=10000
   CLEANUP_MAX_BATCHES=2
   EVENT_RETENTION_DAYS=90
   DEAD_LETTER_RETENTION_DAYS=90
   BROWSER_DIAGNOSTIC_RETENTION_DAYS=30
   ALIAS_RETENTION_DAYS=120
   QUALITY_RETENTION_DAYS=30
   API_INSTANCES=1
   WORKER_INSTANCES=1
   AES_SECRET_KEY=replace-with-a-long-random-secret
   INGEST_TOKEN_SECRET=replace-with-a-different-long-random-secret
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=replace-with-a-strong-password
   ```

   `AES_SECRET_KEY` 与 `INGEST_TOKEN_SECRET` 均至少需要 32 个字符，生产环境必须使用不同值并分别备份；后台密码必须至少 16 个字符且不能等于用户名。这些规则由运行时直接强制，即使跳过 `npm run doctor` 也会拒绝错误配置启动。`INGEST_TOKEN_PREVIOUS_SECRET` 可在轮换采集密钥时临时兼容已安装的旧像素代码。`SHOPIFY_RECONCILE_LOOKBACK_HOURS` 最大为 144 小时，给 Meta 的七天事件窗口保留一天用于持久队列、限流冷却和重试；更老的订单必须保留真实历史时间，不能伪造为当天转化。`CORS_ORIGIN` 接受 `*` 或以英文逗号分隔的准确 HTTP(S) Origin，不能包含路径或末尾斜杠。CORS 只对 `/api/pixel-event` 和 `/api/pixel-config` 开放，管理接口保持同源。Node 直接接收请求、前面没有反向代理时应设置 `TRUST_PROXY_HOPS=0`。

4. 运行自检并启动 API 与 Worker：

   ```bash
   npm run doctor
   npm start
   npm run worker
   ```

5. 打开管理后台。避免使用公网 `443` 时，可使用 `https://capi.example.com:8443/admin`。
   宝塔部署可运行 `deploy/configure_baota_nginx.sh` 并设置 `INSTALL_WATCHER=1`，自动生成、验证、回滚并持续维护
   8443 vhost；具体参数见 [宝塔部署指南](DEPLOY_BAOTA_UBUNTU.md)。
6. 添加 Shopify 店铺；建议同时填写具备 `read_orders` 的 Admin API Token，以启用支付订单对账。再添加一条或多条平台路由，路由表单支持让同一个凭证同时关联多个店铺：
   - Facebook / Meta：Pixel 或 Dataset ID，以及 System User Access Token。
   - TikTok：Pixel Code，以及 Events API Access Token。
7. 把生成代码作为自定义像素粘贴到 Shopify Customer events，按业务实际声明 Marketing/Analytics 隐私用途并连接像素；确认其中的 API 地址包含相同的公网 HTTPS 端口，例如 `https://capi.example.com:8443`。代码会自动加载 Meta Pixel 并同时投递本项目 CAPI；连接前应移除相同 Dataset 的主题 Meta 代码、GTM Meta 标签或 Shopify Facebook & Instagram 数据共享，避免第三条不可去重的数据源。

## 验证

- Meta Test Event Code 保存在每个 `shop_pixel_routes` 路由上，而不是共享 Pixel 凭证上，并按 `TEST_EVENT_CODE_TTL_MINUTES` 自动失效。测试某个店铺不会把其他店铺的 CAPI 事件带入测试模式；生产预检发现仍在有效期内的测试路由会失败并明确报警。
- 确认 Meta 服务端事件包含预期 `event_id`、页面 URL、User-Agent、可用时的 `_fbp`/`_fbc`，以及 Shopify 允许访问的客户匹配字段。
- 确认 TikTok 服务端事件包含预期 `event_id`、可用时的 `_ttp`/`ttclid`、金额、币种和商品内容。
- 确认 `Purchase` 的金额、币种、商品 ID 和订单 ID 正确。

本地代码检查：

```bash
npm run check
npm test
npm audit --omit=dev --audit-level=moderate
```

单元测试覆盖 Shopify 订单到 Purchase 的转换、Meta 官方客户字段规范化、商品快照一致性、无效匹配信号过滤、事件参数预检、生成像素真实转义结果、TikTok Events API 数据映射、去重事件 ID 保留、付款优先合并、跨设备归因隔离、私有字段剥离、Meta 暂时性错误分类、`Retry-After`、使用率响应头主动冷却、过期尝试隔离、运行时安全配置、部分投递保护以及部署升级安全。CI 还会验证生产依赖安装、固定前端资源和 Ubuntu 部署脚本语法。

故障语义、运行阈值、官方参考资料和负载/故障注入清单请查看 [可靠性说明](RELIABILITY.md)。

### 升级已有部署

宝塔部署不要直接执行下面的 `npm ci`，也不要以 root 手工寻找 npm；请按
[宝塔完整部署指南](DEPLOY_BAOTA_UBUNTU.md)只运行 `sudo bash deploy/update_baota.sh`，
脚本会识别宝塔不同版本的 Node 安装目录并使用项目所有者执行安装。

以下命令只适用于 Node/npm 已在当前用户 `PATH` 中的非宝塔部署。停止 API 和 Worker、备份 PostgreSQL并拉取新代码后执行：

```bash
npm ci --omit=dev
npm run check
npm test
npm run migrate
npm run doctor
```

迁移会保留已有店铺、像素、事件和 Token。旧版 `pixels.shop_id` 关系会复制到 `shop_pixel_routes`，旧所有者字段变为可空，因此删除某个店铺不会删除仍被其他店铺使用的凭证。迁移完成且自检通过后再启动 API 和 Worker。

水平扩容时逐步增加 `API_INSTANCES` 和 `WORKER_INSTANCES`。PostgreSQL 最大连接数近似为 `(API_INSTANCES + WORKER_INSTANCES) × DB_POOL_MAX`，必须低于数据库可用连接预算。逐店铺租约防止重复排空，共享凭证租约会串行调用同一个外部像素，逐次尝试隔离会拒绝过期结果。

升级后打开管理后台，把最新生成的 Shopify Customer Events 代码（当前 `shopify-pixel-v26`）复制到每个已连接店铺。v26 覆盖 Shopify 当前 15 个标准 Customer Events；`alert_displayed` 和 `ui_extension_errored` 作为脱敏的 Meta 自定义诊断事件发送，不包含提示原文、客户输入值、错误消息或堆栈。它使用 Shopify `event.id` 统计每次真实动作，加入 Meta 浏览器高级匹配与官方客户分群字段，并停止在 `checkout_completed` 时直接发送无法撤回的浏览器 Purchase；Purchase 候选仍保留完整浏览器归因，只在付款 Webhook/对账确认后由 CAPI 发送。v26 还要求有效的 Shopify 原始事件 ID/时间戳，拒绝把无效时间伪造成收集时刻，通过 `all_standard_events` 对未来新增事件发出脱敏兼容性告警，并使用 Shopify `browser.cookie` 实现 Meta 官方 90 天 `_fbp/_fbc` 管理规则。生成器会安全压缩空白和注释，使完整代码保持在 Shopify 64,000 字符限制以内。只有在 Shopify 明确允许营销、分析和数据销售三种声明用途后才会发送；字段缺失、状态未知或撤回任一用途都会停止浏览器 Pixel/CAPI 并清除未发送队列。普通 Pixel 路由变更会自动同步，但客户事件代码本身的版本升级仍需重新复制；旧代码不会自动改写。连接自定义像素时必须在 Shopify 界面声明营销、分析和数据销售用途，并按店铺所在地区配置客户隐私同意。生成代码包含店铺级采集 Token；默认 `REQUIRE_INGEST_TOKEN=true` 时，仅伪造其他 `shop_domain` 的事件会在路由前被拒绝。

## 使用教程

1. 将项目上传到 GitHub，并确认 CI 通过。
2. 按 [Ubuntu 一键部署指南](DEPLOY_UBUNTU_ONECLICK.md) 或 [宝塔部署指南](DEPLOY_BAOTA_UBUNTU.md) 部署。
3. 打开 `https://你的域名:8443/admin`。
4. 使用 `myshopify.com` 域名和 webhook secret 添加 Shopify 店铺；可选填写 `read_orders` Admin API Token 作为漏投 webhook 的对账兜底。
5. 添加 Facebook / Meta 路由：
   - 平台：`Facebook / Meta`
   - 像素/数据集 ID
   - 系统用户访问令牌
   - 可选：具备 Dataset Quality API 权限的 Token，用于官方 EMQ 快照
   - 可选：Meta Test Event Code
6. 可选添加 TikTok 路由：
   - 平台：`TikTok`
   - TikTok 像素代码
   - Events API 访问令牌
   - 可选测试事件代码
7. 进入“追踪代码”，选择或输入店铺域名，确认 API Origin 是 `https://你的域名:8443` 之类的公网 HTTPS 地址。
8. 将生成代码复制到 Shopify 后台：`Settings → Customer events → Add custom pixel`。
9. 配置必需的 Shopify `orders/paid` webhook：

   ```text
   https://你的域名:8443/api/webhook/orders/paid
   ```

   在该 webhook 到达前，Purchase 会保持 `AWAITING_PAYMENT`。Shopify 会重试失败的 webhook 投递，浏览器候选会保存归因和 checkout 标识，供后续合并。

   后台店铺表单中的 `Webhook Secret` 填该店铺自建应用的 Client Secret；`Admin API Token` 填同一应用安装后生成、具备 `read_orders` 的访问令牌。若多个店铺实际使用同一个自建应用，可选在服务端 `.env` 填一次 `SHOPIFY_APP_SECRET` 作为共享验签密钥；每店分别创建应用时保持为空，并在每个店铺记录中保存各自 Secret。

   如果你还为自建应用注册了 Shopify 隐私主题，可分别指向 `/api/webhook/customers/data_request`、`/api/webhook/customers/redact`、`/api/webhook/shop/redact`。删除请求自动清理匹配数据；数据访问请求会在后台“Shopify 隐私请求”中生成最小化 JSON 报告，安全交付后必须点击“确认已交付”以清除暂存内容。

10. 在 Meta Events Manager 中验证：
    - 服务端事件来自正确的平台路由。
    - checkout 与 webhook 丰富数据使用稳定一致的 `event_id`。
    - `Purchase` 包含金额、币种、`contents`、`content_ids` 和 `order_id`。
    - 随着邮箱、电话、fbp、fbc、IP、User-Agent 和地址可用，EMQ 相应改善。
11. 查看后台“日志与死信”：
    - EMQ 较低通常表示缺少邮箱、电话、fbp、fbc 或地址。
    - 配置具备 Dataset Quality API 权限的 Token 后会显示 Meta 官方数据集质量；缓存快照可能晚于实时事件。
    - 出现 DLQ 表示 Token、权限、限流或平台 API 问题需要处理。

## Shopify 权限建议

| 权限 | 建议 | 原因 |
|---|---|---|
| `read_orders` | 强烈建议 | Admin API Token 启用已付款订单分页对账；webhook 正常时仍是低延迟权威入口 |
| `write_orders` | 不需要 | 项目不创建或修改订单 |
| `read_assigned_fulfillment_orders` | 不需要 | 项目不处理履约或发货 |
| `write_assigned_fulfillment_orders` | 不需要 | 项目不创建或修改履约单 |
| `read_checkouts` | 不需要 | 加购和发起结账由 Shopify Customer Events Pixel 捕获，不依赖 Admin API |
| `write_checkouts` | 不需要 | 项目不创建或修改 checkout |
| `read_draft_orders` | 不需要 | 项目不读取草稿订单 |
| `write_draft_orders` | 不需要 | 项目不创建或修改草稿订单 |
| `read_customers` | 可选 | Shopify 要求客户数据权限时可开启，有助于提高匹配数据完整性 |
| `write_customers` | 不需要 | 项目不创建或修改客户 |
| `read_products` | 不需要 | Pixel/webhook 已携带商品 ID，无需额外读取商品 |
| `write_products` | 不需要 | 项目不创建或修改商品 |
| `read_merchant_managed_fulfillment_orders` | 不需要 | 项目不处理商家履约订单 |
| `write_merchant_managed_fulfillment_orders` | 不需要 | 项目不创建或修改履约订单 |
| `read_price_rules` | 不需要 | 项目不读取 Shopify 价格规则，订单事件已包含实际成交金额 |
| `write_price_rules` | 不需要 | 项目不创建或修改价格规则 |
| `read_discounts` | 不需要 | 项目不读取折扣规则，订单 webhook 包含最终成交信息 |
| `write_discounts` | 不需要 | 项目不创建或修改折扣 |
| `read_markets` | 不需要 | 项目不查询 Shopify 市场或汇率配置 |
| `read_locations` | 不需要 | 项目不根据库存地点或门店位置进行归因 |
| `read_online_store_navigation` | 不需要 | 项目不读取网站导航 |
| `read_online_store_pages` | 不需要 | 项目不读取页面内容 |
