# 官方文档对照与 v17 升级记录

核对日期：2026-08-01

## 采用的官方资料

- [Meta Node.js Business SDK](https://github.com/facebook/facebook-nodejs-business-sdk)
- [Meta Conversions API Direct Integration Playbook](https://storage.googleapis.com/lr-tech-docs-resources/PDFs/Conversions-API-Direct-Integration-Playbook_English.pdf)
- [Meta Pixel / Dataset 官方说明](https://www.facebook.com/help/messenger-app/952192354843755)
- [Shopify API 版本机制](https://shopify.dev/docs/api/usage/versioning)
- [Shopify Web Pixels API](https://shopify.dev/docs/api/web-pixels-api)
- [Shopify Web Pixels 标准事件](https://shopify.dev/docs/api/web-pixels-api/standard-events)
- [payment_info_submitted](https://shopify.dev/docs/api/web-pixels-api/standard-events/payment_info_submitted)
- [checkout_completed](https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed)
- [Shopify Pixel Privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy)
- [Shopify Browser API](https://shopify.dev/docs/api/web-pixels-api/standard-api/browser)
- [Shopify 管理 Webhook 订阅](https://shopify.dev/docs/apps/build/webhooks/subscribe)
- [Shopify webhookSubscriptions 查询](https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions)
- [Shopify webhookSubscriptionCreate 变更](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate)

## 版本结论

- Meta 默认升级到 `v26.0`。2026-08-01 核对官方“使用 API”示例后，当前 CAPI 请求路径与 Server Event 字段集合已按 v26 验证；仍可通过 `FB_API_VERSION` 显式覆盖。
- Shopify Admin GraphQL 保持 `2026-07`。这是 2026-08-01 的最新稳定版本，支持到 2027-07-16。
- Shopify Web Pixels API 不采用季度版本号，因此生成像素必须对运行时能力做安全检测并持续跟进官方变更。

## v16 已落地调整

1. 订阅 `payment_info_submitted` 并映射 Meta `AddPaymentInfo`。
2. 使用 Shopify 每条标准事件的 `event.id` 记录加购和结账动作；Purchase 使用 checkout/order 稳定身份。
3. 浏览器 Pixel 与 CAPI 使用完全一致的 `event_name + event_id`，多店共享 Dataset 时在 ID 中加入店铺域名命名空间。
4. 订阅 `visitorConsentCollected`；明确撤回 Marketing 或 Sale of Data 授权后停止浏览器 Pixel/CAPI，并清除未发送的持久队列。
5. 继续使用 `browser.cookie`、`browser.localStorage` 与 `fetch(..., {keepalive: true})`，不依赖 Custom Pixel sandbox 无法保证的顶层 DOM/Cookie API。
6. `checkout_completed` 不是绝对可靠的付款凭据：官方说明目标页面未加载时事件可能完全不触发。因此 Purchase 继续以验签后的 `orders/paid` Webhook 为付款权威，并用 Admin GraphQL 定期补偿。
7. 保存 Shopify Webhook 的 `X-Shopify-API-Version`，后台展示近 7 天实际版本；`npm run doctor` 会对版本不一致失败告警。
8. Meta 官方质量响应没有事件级指标时标记 `EMPTY`，不伪装为成功或编造 EMQ。
9. 删除 Meta 官方 `ServerEvent` 未定义的根字段 `customer_segmentation`；Shopify 新客/老客状态只保存在本系统私有 `_source.customer_lifecycle`，不会进入实际 CAPI 请求。
10. Admin GraphQL 补偿的在线订单仍使用 `action_source=website`；补偿 Purchase 的事件时间优先取最后一笔成功 `SALE/CAPTURE` 交易的 `processedAt`，而不是把订单创建/处理时间误当付款时间。
11. 浏览器批量采集中被 4xx 拒绝的单条事件会进入脱敏死信诊断，避免有效事件继续处理后，被拒绝事件在后台无痕消失；诊断不保存采集 Token 或原始邮箱/电话。
12. 商品匹配只使用 Shopify Variant/Product/SKU 这类持久商品身份；临时的 CartLine、CheckoutLineItem 和 Order LineItem ID 不再冒充 Meta Catalog 商品 ID，缺少真实商品身份时宁可省略并在参数诊断中显示缺失。
13. Purchase 别名同时桥接 checkout token、订单名称和不可变 Shopify Order ID，并兼容带/不带店铺前缀的历史别名；即使浏览器事件缺少 checkout token，付款 Webhook 仍可与同一订单合并。
14. 严格保留网站事件必需的 `client_user_agent`、`event_source_url` 和 `action_source=website`。Admin GraphQL 只能恢复真实存在的浏览器归因信息，绝不伪造 UA，也不把在线购买错误标记为自动续费式的 `system_generated`；缺失时保留到本地校验/死信供修复。
15. 已付款订单对账按 `shop_id + order_identity` 隔离，修复多店出现相同 Shopify 订单标识时被汇总为一单的问题；后台新增“已进入 Purchase 台账、Meta 已成功、待处理、永久失败、本地校验异常、未入台账”闭环指标。
16. 重复事件合并后重新执行 Meta 本地校验；只有补充数据真正消除全部错误时，才重新打开 `LOCAL_VALIDATION` 永久失败，避免无效重复请求形成失败/重开循环。

## 运营边界

### 本轮深度补强（逐事件回执与测试链路防误用）

17. Meta 批量响应的 `events_received` 是请求批次级计数，旧版把同一响应复制给批次内每条事件，快照审计若逐行求和会虚高。新版为每条投递分别保存 `accepted_event=true`、`accepted_event_count=1`、对应 `fbtrace_id`、批次大小与批次接收数；审计只按逐事件确认计数，不再累加批次值。
18. 后台文案由“Meta 已成功接收”调整为“Meta API 已确认收件”，明确区分接口收件、Events Manager 展示、事件匹配和广告归因四个不同阶段。
19. Test Event Code 新增路由级有效期，默认 30 分钟；Worker 只在有效期内发送测试码，旧版无过期时间的遗留代码在迁移时自动清除，生产预检发现仍有效的测试路由会报警失败。
20. Shopify 付款订单首次补偿回看窗口默认由 48 小时提高到 144 小时，在 Meta 七天事件时效前保留一天以上处理余量，降低停机或 Webhook 异常造成的漏单风险。

### v17 浏览器损失可观测性与 Webhook 漂移修复

21. 浏览器对 `202/200` 批量响应逐条读取 `results`，只确认成功/去重条目；同批永久拒绝条目会形成脱敏诊断，不再因整个 HTTP 请求成功而无痕消失。
22. 本地持久队列容量淘汰、重试 32 次耗尽、六天重试窗口到期、存储读写失败、非重试型 HTTP 拒绝和 Meta 浏览器 SDK 队列溢出均记录固定错误代码、事件名计数和像素版本，不保存邮箱、电话、Cookie、URL 或事件 ID。
23. v17 在真实事件进入网关时更新逐店 `source_version` 与最后在线时间；同版本状态最多每 15 分钟落库一次，不额外为每位访客制造心跳请求，因此不再依赖人工猜测店铺是否仍粘贴旧版代码。
24. 官方文档说明：在 Admin API 中创建的店铺级 Webhook 订阅可能在持续失败后被 Shopify 删除；自建应用也必须通过 Admin GraphQL 管理订阅。系统新增 `ORDERS_PAID` 订阅只读定时审计，识别缺失、旧 URI 和查询错误。
25. 后台“修复 Webhook”先查询现状，只在正确的 `${PUBLIC_BASE_URL}/api/webhook/orders/paid` 缺失时调用 `webhookSubscriptionCreate`。系统不会自动删除其他地址，避免破坏并行系统；数据库稳定 Purchase ID 仍会吸收重复订阅产生的重复付款通知。

- 多店共享一个 Meta Dataset 时，Meta 端的质量、受众、归因和学习结果必然是合并视图；本项目后台的店铺自然日漏斗用于逐店对账。
- 每个 Shopify 店铺必须粘贴为该店铺生成的 v17 代码，不能跨店复制采集 Token。
- 同一 Dataset 不应同时启用另一套主题 Pixel、GTM Meta 标签或 Shopify Facebook & Instagram 数据共享，除非它能复用完全相同的事件名与事件 ID。
