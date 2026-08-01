#!/usr/bin/env python3
"""Create the executable, privacy-safe companion notebook for the CAPI audit."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import nbformat as nbf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=Path(".audit/production-data-profile.json"))
    parser.add_argument("--output", type=Path, default=Path(".audit/facebook-capi-data-audit.ipynb"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    events = profile["events"]["total"]
    purchases = len(profile["events"]["purchase_records"])
    webhook_total = profile["shopify_webhooks"]["total"]
    webhook_success = profile["shopify_webhooks"]["statuses"].get("SUCCESS", 0)
    max_attempts = profile["shopify_webhooks"]["max_attempt_count"]

    notebook = nbf.v4.new_notebook()
    notebook.metadata.kernelspec = {"display_name": "Python 3", "language": "python", "name": "python3"}
    notebook.metadata.language_info = {"name": "python", "version": "3"}
    notebook.cells = [
        nbf.v4.new_markdown_cell(
            "## tl;dr\n\n"
            f"- 数据库快照包含 **{events:,}** 条事件和同量级的逐路由投递账本；所有事件均成功投递并获得 Meta 接收回执。\n"
            f"- 共识别 **{purchases}** 条 Purchase。`orders/paid` 收件箱为 {webhook_success}/{webhook_total} 成功；"
            f"唯一未完成记录累计尝试 **{max_attempts:,}** 次，是确认的服务端漏报根因。\n"
            "- Shopify 报表按店铺时区计日，CAPI 原始事件按 UTC 记录；跨午夜事件必须先统一时区再对账。\n"
            "- 输出仅使用脱敏聚合数据，不包含客户标识、IP、User-Agent、事件 ID 或凭证。"
        ),
        nbf.v4.new_markdown_cell(
            "## Context & Methods\n\n"
            "目标是解释 Shopify、CAPI/Meta 与广告后台之间的转化差异，并区分统计口径差异与真实采集故障。\n\n"
            "### Key Assumptions\n\n"
            "- 店铺日界线按 `America/Los_Angeles` 复核，同时保留 UTC 与北京时间视图。\n"
            "- 事件计数是事件行数，不等同于 Shopify 的会话漏斗；Shopify 漏斗按会话去重。\n"
            "- 逐事件 `meta_api_acknowledged=true` 证明 Meta API 已确认收件，不代表该事件必然展示或归因给某条广告。"
        ),
        nbf.v4.new_markdown_cell("## Data\n\n### 1. Load the privacy-safe profile"),
        nbf.v4.new_code_cell(
            "from collections import Counter\n"
            "from pathlib import Path\n"
            "import json\n"
            "import matplotlib.pyplot as plt\n\n"
            "PROFILE_PATH = Path('.audit/production-data-profile.json')\n"
            "profile = json.loads(PROFILE_PATH.read_text(encoding='utf-8'))\n"
            "assert profile['scope'].startswith('Complete custom-dump read')\n"
            "profile['database']['table_rows']"
        ),
        nbf.v4.new_markdown_cell("## Results\n\n### 2. Validate top-line integrity"),
        nbf.v4.new_code_cell(
            "integrity = {\n"
            "    'events': profile['events']['total'],\n"
            "    'successful_events': profile['events']['status_counts'].get('SUCCESS', 0),\n"
            "    'deliveries': profile['delivery']['total'],\n"
            "    'delivery_errors': profile['delivery']['rows_with_errors'],\n"
            "    'duplicate_event_rows': profile['events']['duplicate_rows'],\n"
            "    'meta_api_acknowledged_events': profile['events']['meta_acceptance']['events_with_meta_api_ack'],\n"
            "    'route_snapshot_mismatches': profile['delivery']['route_snapshot_mismatches'],\n"
            "}\n"
            "integrity"
        ),
        nbf.v4.new_markdown_cell(
            "**Interpretation.** Event storage, route delivery, and Meta acceptance agree at the audited grain. "
            "The discrepancy is therefore not a general Meta transport failure."
        ),
        nbf.v4.new_markdown_cell("### 3. Compare the event mix"),
        nbf.v4.new_code_cell(
            "event_counts = Counter()\n"
            "for row in profile['events']['by_shop_event_source']:\n"
            "    event_counts[row['event_name']] += row['total']\n"
            "ranked = sorted(event_counts.items(), key=lambda item: item[1])\n\n"
            "fig, ax = plt.subplots(figsize=(9, 5.8))\n"
            "labels = [name for name, _ in ranked]\n"
            "values = [value for _, value in ranked]\n"
            "ax.barh(labels, values, color='#2563eb', edgecolor='#123a8f', linewidth=0.7)\n"
            "ax.set_title('Audited event volume by event name')\n"
            "ax.set_xlabel('Stored and delivered events')\n"
            "ax.grid(axis='x', color='#dfe7f0', linewidth=0.7)\n"
            "ax.set_axisbelow(True)\n"
            "for index, value in enumerate(values):\n"
            "    ax.text(value + max(values) * 0.01, index, f'{value:,}', va='center', fontsize=8)\n"
            "fig.tight_layout()\n"
            "plt.show()\n"
            "dict(sorted(event_counts.items(), key=lambda item: item[1], reverse=True))"
        ),
        nbf.v4.new_markdown_cell(
            "**Interpretation.** 浏览行为量远高于交易行为是正常的；这些是事件行数，不应直接当作 Shopify 会话漏斗。"
        ),
        nbf.v4.new_markdown_cell("### 4. Reconcile paid-order Webhooks to Purchase"),
        nbf.v4.new_code_cell(
            "reconciliation = profile['shopify_webhooks']['paid_purchase_reconciliation']\n"
            "for row in reconciliation:\n"
            "    print(row['shop_domain'], 'paid inbox=', row['orders_paid_inbox_total'], "
            "'success=', row['orders_paid_inbox_success'], 'purchase=', row['purchase_events'], "
            "'coverage=', f\"{row['paid_inbox_coverage_pct']:.2f}%\")\n"
            "print('outstanding=', profile['shopify_webhooks']['outstanding'])"
        ),
        nbf.v4.new_markdown_cell(
            "**Interpretation.** CASEORA 为 7/7；ATELIERWRAP 为 2/3。未完成的付款 Webhook 是唯一可证实的 Purchase 漏报。"
        ),
        nbf.v4.new_markdown_cell("### 5. Verify timezone alignment for Purchases"),
        nbf.v4.new_code_cell(
            "for row in profile['events']['purchase_records']:\n"
            "    print(row['shop_domain'], row['event_time_utc'], '=> store day', "
            "row['event_time_store'], row['source_provider'], row['value'], row['currency'])"
        ),
        nbf.v4.new_markdown_cell(
            "**Interpretation.** UTC 7 月 31 日的一条 ATELIERWRAP Purchase 落在洛杉矶时间 7 月 30 日 18:54，"
            "因此 Shopify“今天”显示 0 与 CAPI 的 UTC 日期计数并不冲突。"
        ),
        nbf.v4.new_markdown_cell(
            "## Takeaways\n\n"
            "1. 先修复付款 Webhook 的无限租约重领；这是唯一确认的真实 Purchase 漏报。\n"
            "2. 每个店铺使用独立 Meta Pixel/数据集，否则两个品牌的归因、诊断与学习信号会混在一起。\n"
            "3. 对账统一使用店铺时区、同一统计窗口和同一粒度；Meta 接收、Meta 归因、Shopify 会话漏斗是三类不同指标。\n"
            "4. 部署 v15 像素后按 `source_version` 和标准漏斗事件持续监控，避免历史 v14 数据与新数据混算。"
        ),
    ]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    nbf.write(notebook, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
