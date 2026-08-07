# Meta CAPI / Shopify 官方文档深度审查（2026-08-07）

## 审查范围

本轮逐页核对了用户文档中列出的 22 个 Meta Conversions API 官方入口：

1. [Using the API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api)
2. [Verifying Your Setup](https://developers.facebook.com/documentation/ads-commerce/conversions-api/verifying-setup)
3. [Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters)
4. [Main Body](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/main-body)
5. [Server Event Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event)
6. [Customer Information Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters)
7. [External ID](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/external-id)
8. [Fbp and Fbc](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc)
9. [Custom Data](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/custom-data)
10. [App Data](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/app-data)
11. [Original Event Data](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/original-event)
12. [Parameter Builder Library](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameter-builder-library)
13. [Parameter Builder Get Started](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameter-builder-library/get-started)
14. [Workflow and Examples](https://developers.facebook.com/documentation/ads-commerce/conversions-api/workflow-and-examples)
15. [App Events](https://developers.facebook.com/documentation/ads-commerce/conversions-api/app-events)
16. [Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging)
17. [Conversion Leads Integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration)
18. [Dataset Quality API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/dataset-quality-api)
19. [Deduplicate Pixel and Server Events](https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events)
20. [Conversions API Gateway](https://developers.facebook.com/documentation/ads-commerce/conversions-api/gateway-products/conversions-api-gateway)
21. [Gateway Advanced Matching](https://developers.facebook.com/documentation/ads-commerce/conversions-api/gateway-products/conversions-api-gateway/enable-advanced-matching)
22. [Payload Helper](https://developers.facebook.com/documentation/ads-commerce/conversions-api/payload-helper)

同时核对了 Shopify 当前 `2026-07` Admin GraphQL、Web Pixels / Customer Events 的全部 15 个标准事件、Pixel Privacy、Browser API、自定义像素 sandbox、`orders/paid` Webhook、Webhook HMAC/去重/乱序/重试、订单与交易时间、游标分页、限流、API 版本和受保护客户数据文档。

## 关键结论与已落地修复

### 1. `(#100) Tried accessing nonexisting field (dedup_key_feedback)`

根因是字段拼写和投影不符合 Meta 当前可执行示例。错误字段是 `dedup_key_feedback`；当前示例使用：

```text
dedupe_key_feedback{
  dedupe_key,
  browser_events_with_dedupe_key{percentage,description},
  server_events_with_dedupe_key{percentage,description},
  overall_browser_coverage_from_dedupe_key{percentage,description}
}
```

项目现已改为官方 `dedupe` 拼写和完整子字段投影。若 Meta 对某个 Dataset 灰度提供的 schema 较旧，代码会只在 Graph `#100` 字段投影错误时退回保守字段集，不会把鉴权、限流或 Token 错误误判为字段兼容问题。解析器继续接受历史快照里的两种拼写。

### 2. 历史订单不能使用扫描当天时间

Shopify `Order.updatedAt` 只是增量对账游标；标签、退款、履约或编辑都会更新旧订单。它不能代表转化发生时间。Purchase 时间现在按以下优先级确定：

1. 最新一笔成功 `SALE` / `CAPTURE` 交易的 `processedAt`；
2. 该交易的 `createdAt`；
3. 订单 `processedAt`；
4. 订单 `createdAt`。

Webhook 实时入口使用 `X-Shopify-Triggered-At` 表示 `orders/paid` 触发时间；对账入口把真实交易时间写入同一字段，并保留 `event_time_source` / `event_time_confidence` 审计信息。对账现在还会按真实支付时间过滤：旧订单仅因今天被编辑，不再进入 Meta 转化队列；历史时间绝不改写为 `Date.now()`。

### 3. Meta Parameter Builder 值不能二次处理

Meta Parameter Builder 可能在 SHA-256、`fbp`、`fbc` 后加入大小写敏感的 8 字符附录（并兼容旧 2 字符形式）。完整返回值必须原样发送。项目此前只接受 64 位小写十六进制，会丢弃附录；现已原样验证、去重和传递，不再小写化或二次哈希。

### 4. Shopify Customer Events 与套装商品

生成代码仍逐项订阅 Shopify 当前 15 个标准事件，并用 `all_standard_events` 只监测未来新增事件。Checkout Extensibility 的 bundle 现在优先使用官方 `CheckoutLineItem.lineComponents` 映射真实组件 Variant；组件身份不可用时才退回顶层 bundle Variant。这样 `contents` / `content_ids` 更接近 Meta Catalog 的真实商品身份。

### 5. Purchase 权威与去重

`checkout_completed` 可能因目标页面未加载而完全不触发，也不能证明异步、延期或线下支付已经成功，因此它只保存浏览器归因候选，不直接发送不可撤回的浏览器 Purchase。最终 Purchase 只由已验签的 `orders/paid` 或 Admin GraphQL 对账确认。浏览器与服务端共享同一个店铺命名空间 Purchase ID；Webhook 重试还按 `X-Shopify-Webhook-Id` 去重。

## 当前官方契约检查结果

- Website 事件具备 `action_source=website`、`event_source_url`、`client_user_agent`、`event_time`、`event_id` 和至少一个有效匹配信号。
- Purchase 强制同时具备非负 `value` 与三位大写 `currency`。
- CAPI / Pixel 去重使用完全相同的 `event_name + event_id`，服务端字段为 `event_id`，浏览器字段为 `eventID`。
- `_fbp` / `_fbc` 不哈希，保留 `fbclid` 大小写，落地页尽早捕获，并按 90 天 Cookie 规则续期。
- Customer Events 时间使用 Shopify `event.timestamp`；无效、未来或超过可靠窗口的浏览器事件直接拒绝，不伪造成当前时间。
- Webhook 在 JSON 解析前用原始 body 验证 HMAC，并使用常量时间比较；响应持久化后快速返回 2xx，后台处理可重试。
- Shopify 不保证 Webhook 顺序或绝对投递，项目使用 `X-Shopify-Triggered-At` / payload 时间排序，并用六天 Admin GraphQL 对账补偿。
- Admin GraphQL 使用当前稳定版 `2026-07`、游标分页、响应版本审计和 query-cost throttle 信息。
- 受保护客户字段允许为空；未获批字段不会导致非 PII 事件链路中断。项目不编造被 Shopify 隐去的邮箱、电话、姓名或地址。
- App Events、Business Messaging、CRM Leads 和 CAPI Gateway 是不同数据源契约，本项目的 Shopify Website 事件不会混入这些专用字段。

## 部署后必须执行的验证

1. 在每个 Shopify 店铺重新复制后台生成的最新 `shopify-pixel-v25` 代码，并在 Customer Events 界面连接、声明营销/分析/数据共享用途。
2. 运行 `npm run doctor`、`npm run check`、`npm test`。
3. 在 Shopify Pixel Helper 中分别触发页面、商品、加购、结账各阶段与测试付款，确认 15 个订阅没有运行时错误。
4. Meta Test Events 只临时配置测试码；生产确认后让测试码过期，避免长期污染正式诊断。
5. 后台确认 `ORDERS_PAID` Webhook 状态为 `HEALTHY` 或 `HEALTHY_WITH_ALTERNATES`，并核对实际 Shopify API 版本为 `2026-07`。
6. Meta Events Manager 中核对 Browser / Server 相同事件 ID、Deduplication、Event Match Quality、Event Coverage、Data Freshness 和 Diagnostics。

任何第三方平台都不能由代码“永久保证永不变更”：Meta/Shopify schema、授权、商店同意配置、网络和 Token 都是外部状态。本项目已对当前官方契约加入静态审计、回退、重试、持久台账与诊断；上线后仍需持续监控官方版本和后台健康状态。
