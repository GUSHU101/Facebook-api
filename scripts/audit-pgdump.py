#!/usr/bin/env python3
"""Build a privacy-safe data-quality profile from a PostgreSQL custom dump.

The report intentionally excludes credentials, raw event identifiers, customer
identifiers, IP addresses, user agents, and raw JSON payloads.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import pgdumplib


FUNNEL_EVENTS = {
    "AddToCart",
    "InitiateCheckout",
    "CheckoutContactInfoSubmitted",
    "CheckoutAddressInfoSubmitted",
    "CheckoutShippingInfoSubmitted",
    "AddPaymentInfo",
    "Purchase",
}
IDENTITY_SIGNALS = (
    "em",
    "ph",
    "external_id",
    "fbp",
    "fbc",
    "client_ip_address",
    "client_user_agent",
)
COMMERCE_FIELDS = ("currency", "value", "content_ids", "contents", "order_id")
COPY_COLUMNS_RE = re.compile(r"^COPY\s+.+?\s+\((.+)\)\s+FROM\s+stdin;$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path, help="Path to a pg_dump custom-format archive")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".audit/production-data-profile.json"),
        help="Privacy-safe JSON output path",
    )
    parser.add_argument(
        "--store-timezone",
        default="America/Los_Angeles",
        help="Timezone used for Shopify/store-day reconciliation",
    )
    return parser.parse_args()


def parse_copy_columns(copy_stmt: str) -> list[str]:
    match = COPY_COLUMNS_RE.match(copy_stmt.strip())
    if not match:
        raise ValueError(f"Unsupported COPY statement: {copy_stmt}")
    return [part.strip().strip('"') for part in match.group(1).split(",")]


def table_rows(dump: Any, table: str) -> list[dict[str, Any]]:
    entry = dump.lookup_entry("TABLE DATA", "public", table)
    if entry is None:
        return []
    columns = parse_copy_columns(entry.copy_stmt)
    return [dict(zip(columns, row, strict=True)) for row in dump.table_data("public", table)]


def json_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}


def meta_event_accepted(value: Any) -> bool:
    """Read one event's Meta API acknowledgement without summing batch counts."""
    response = json_value(value)
    if response.get("accepted_event") is True or integer(response.get("accepted_event_count")) == 1:
        return True
    # Legacy rows stored the same batch-level events_received value on every
    # event. A positive value proves this row belonged to an acknowledged
    # batch, but it must never be added across rows as an event count.
    if integer(response.get("events_received")) > 0:
        return True
    deliveries = response.get("deliveries")
    if isinstance(deliveries, list):
        for delivery in deliveries:
            if not isinstance(delivery, dict):
                continue
            if meta_event_accepted(delivery.get("response")):
                return True
    return False


def postgres_array_length(value: Any) -> int:
    """Count a simple one-dimensional PostgreSQL array from COPY output."""
    if isinstance(value, (list, tuple)):
        return len(value)
    text = str(value or "").strip()
    if text in {"", "{}"}:
        return 0
    if text.startswith("{") and text.endswith("}"):
        return len([item for item in text[1:-1].split(",") if item.strip()])
    return 0


def integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def timestamp(value: Any) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        return value.replace(tzinfo=value.tzinfo or dt.timezone.utc)
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed.replace(tzinfo=parsed.tzinfo or dt.timezone.utc)


def event_timestamp(payload: dict[str, Any], fallback: Any) -> dt.datetime | None:
    raw = number(payload.get("event_time"))
    if raw and raw > 0:
        return dt.datetime.fromtimestamp(raw, tz=dt.timezone.utc)
    return timestamp(fallback)


def iso(value: Any) -> str | None:
    parsed = timestamp(value)
    return parsed.isoformat() if parsed else None


def present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, set)):
        return bool(value)
    return bool(str(value).strip())


def pct(numerator: int | float, denominator: int | float) -> float:
    return round((numerator / denominator) * 100, 2) if denominator else 0.0


def percentile(values: Iterable[float], quantile: float) -> float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    index = min(len(ordered) - 1, max(0, math.ceil(quantile * len(ordered)) - 1))
    return round(ordered[index], 3)


def counter_dict(counter: collections.Counter) -> dict[str, int]:
    return {str(key): int(value) for key, value in sorted(counter.items(), key=lambda item: str(item[0]))}


def source_metadata(payload: dict[str, Any], event_name: str) -> tuple[str, str]:
    source = payload.get("_source") if isinstance(payload.get("_source"), dict) else {}
    platform = payload.get("_platform_data") if isinstance(payload.get("_platform_data"), dict) else {}
    version = source.get("source_version") or platform.get("source_version") or "MISSING"
    provider = source.get("provider") or source.get("source_provider")
    if not provider and version != "MISSING":
        provider = "shopify_web_pixels"
    if not provider and event_name == "Purchase" and payload.get("_payment_confirmed") is True:
        provider = "shopify_webhook_or_reconcile"
    return str(provider or "MISSING"), str(version)


def summarize_lag(values: list[float]) -> dict[str, float | None]:
    return {
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "min": round(min(values), 3) if values else None,
        "max": round(max(values), 3) if values else None,
    }


def main() -> None:
    args = parse_args()
    store_tz = ZoneInfo(args.store_timezone)
    shanghai_tz = ZoneInfo("Asia/Shanghai")
    dump = pgdumplib.load(str(args.dump.resolve()))

    table_names = [
        "dead_letters",
        "event_deliveries",
        "event_id_aliases",
        "event_store",
        "meta_quality_snapshots",
        "pixels",
        "shop_pixel_routes",
        "shopify_privacy_inbox",
        "shopify_reconcile_state",
        "shopify_webhook_inbox",
        "shops",
    ]
    tables = {name: table_rows(dump, name) for name in table_names}
    shops = tables["shops"]
    shop_by_id = {integer(row.get("id")): str(row.get("shop_domain")) for row in shops}
    routes = tables["shop_pixel_routes"]
    route_by_id = {integer(row.get("id")): row for row in routes}
    events = tables["event_store"]
    deliveries = tables["event_deliveries"]
    webhooks = tables["shopify_webhook_inbox"]
    aliases = tables["event_id_aliases"]
    snapshots = tables["meta_quality_snapshots"]

    event_statuses: collections.Counter = collections.Counter()
    source_versions: collections.Counter = collections.Counter()
    source_providers: collections.Counter = collections.Counter()
    event_key_counts: collections.Counter = collections.Counter()
    event_id_names: dict[tuple[int, str], set[str]] = collections.defaultdict(set)
    aggregate: dict[tuple[str, str, str], dict[str, Any]] = {}
    overall_signal_counts: collections.Counter = collections.Counter()
    daily: dict[str, collections.Counter] = {
        "UTC": collections.Counter(),
        args.store_timezone: collections.Counter(),
        "Asia/Shanghai": collections.Counter(),
    }
    source_lags: dict[str, list[float]] = collections.defaultdict(list)
    event_dates: list[dt.datetime] = []
    future_events = 0
    meta_accepted = 0
    purchase_records: list[dict[str, Any]] = []

    now = dt.datetime.now(dt.timezone.utc)
    for row in events:
        shop_id = integer(row.get("shop_id"))
        shop = shop_by_id.get(shop_id, f"shop:{shop_id}")
        event_name = str(row.get("event_name") or "MISSING")
        event_id = str(row.get("event_id") or "")
        payload = json_value(row.get("request_payload"))
        custom = payload.get("custom_data") if isinstance(payload.get("custom_data"), dict) else {}
        user_data = payload.get("user_data") if isinstance(payload.get("user_data"), dict) else {}
        provider, version = source_metadata(payload, event_name)
        event_at = event_timestamp(payload, row.get("timestamp"))
        inserted_at = timestamp(row.get("timestamp"))

        event_statuses[str(row.get("status") or "MISSING")] += 1
        source_versions[version] += 1
        source_providers[provider] += 1
        event_key_counts[(shop_id, event_name, event_id)] += 1
        event_id_names[(shop_id, event_id)].add(event_name)
        key = (shop, event_name, provider)
        if key not in aggregate:
            aggregate[key] = {
                "shop_domain": shop,
                "event_name": event_name,
                "source_provider": provider,
                "total": 0,
                "statuses": collections.Counter(),
                "versions": collections.Counter(),
                "signals": collections.Counter(),
                "commerce": collections.Counter(),
                "emq": [],
                "first_event_time": None,
                "last_event_time": None,
            }
        item = aggregate[key]
        item["total"] += 1
        item["statuses"][str(row.get("status") or "MISSING")] += 1
        item["versions"][version] += 1
        emq = number(row.get("emq_estimate"))
        if emq is not None:
            item["emq"].append(emq)
        for signal in IDENTITY_SIGNALS:
            if present(user_data.get(signal)):
                item["signals"][signal] += 1
                overall_signal_counts[signal] += 1
        for field in COMMERCE_FIELDS:
            if present(custom.get(field)):
                item["commerce"][field] += 1

        if event_at:
            event_dates.append(event_at)
            event_iso = event_at.isoformat()
            item["first_event_time"] = min(item["first_event_time"] or event_iso, event_iso)
            item["last_event_time"] = max(item["last_event_time"] or event_iso, event_iso)
            if event_at > now + dt.timedelta(minutes=5):
                future_events += 1
            for timezone_name, timezone in (
                ("UTC", dt.timezone.utc),
                (args.store_timezone, store_tz),
                ("Asia/Shanghai", shanghai_tz),
            ):
                local_date = event_at.astimezone(timezone).date().isoformat()
                if event_name in FUNNEL_EVENTS:
                    daily[timezone_name][(shop, local_date, event_name)] += 1
        if event_at and inserted_at:
            source_lags[provider].append((inserted_at - event_at).total_seconds())

        accepted = meta_event_accepted(row.get("fb_response"))
        if accepted:
            meta_accepted += 1

        if event_name == "Purchase" and event_at:
            purchase_records.append({
                "shop_domain": shop,
                "event_time_utc": event_at.isoformat(),
                "event_time_store": event_at.astimezone(store_tz).isoformat(),
                "source_provider": provider,
                "value": number(custom.get("value")),
                "currency": custom.get("currency"),
                "status": row.get("status"),
                "emq_estimate": emq,
                "meta_api_acknowledged": accepted,
            })

    normalized_aggregate = []
    for item in aggregate.values():
        total = item["total"]
        normalized_aggregate.append({
            "shop_domain": item["shop_domain"],
            "event_name": item["event_name"],
            "source_provider": item["source_provider"],
            "total": total,
            "statuses": counter_dict(item["statuses"]),
            "source_versions": counter_dict(item["versions"]),
            "signal_coverage_pct": {
                signal: pct(item["signals"][signal], total) for signal in IDENTITY_SIGNALS
            },
            "commerce_coverage_pct": {
                field: pct(item["commerce"][field], total) for field in COMMERCE_FIELDS
            },
            "emq": {
                "average": round(sum(item["emq"]) / len(item["emq"]), 2) if item["emq"] else None,
                "p50": percentile(item["emq"], 0.50),
                "p95": percentile(item["emq"], 0.95),
            },
            "first_event_time": item["first_event_time"],
            "last_event_time": item["last_event_time"],
        })
    normalized_aggregate.sort(key=lambda item: (item["shop_domain"], item["event_name"], item["source_provider"]))

    duplicate_rows = sum(count - 1 for count in event_key_counts.values() if count > 1)
    reused_event_ids = collections.Counter()
    for (_, _), names in event_id_names.items():
        if len(names) > 1:
            reused_event_ids[" + ".join(sorted(names))] += 1

    delivery_statuses: collections.Counter = collections.Counter()
    delivery_attempts: collections.Counter = collections.Counter()
    delivery_errors = 0
    orphan_deliveries = 0
    cross_tenant_deliveries = 0
    deliveries_by_event: collections.Counter = collections.Counter()
    event_by_id = {integer(row.get("id")): row for row in events}
    for delivery in deliveries:
        delivery_statuses[str(delivery.get("status") or "MISSING")] += 1
        delivery_attempts[str(delivery.get("attempt_count") or "MISSING")] += 1
        if present(delivery.get("error_code")) or present(delivery.get("error_message")):
            delivery_errors += 1
        event_store_id = integer(delivery.get("event_store_id"))
        deliveries_by_event[event_store_id] += 1
        event = event_by_id.get(event_store_id)
        route = route_by_id.get(integer(delivery.get("route_id")))
        if not event or not route:
            orphan_deliveries += 1
        elif integer(event.get("shop_id")) != integer(route.get("shop_id")):
            cross_tenant_deliveries += 1
    route_snapshot_mismatches = 0
    for event_id, event in event_by_id.items():
        expected = postgres_array_length(event.get("delivery_route_snapshot"))
        if expected != deliveries_by_event[event_id]:
            route_snapshot_mismatches += 1

    webhook_topics: collections.Counter = collections.Counter()
    webhook_statuses: collections.Counter = collections.Counter()
    webhooks_by_shop: collections.Counter = collections.Counter()
    webhook_attempts: list[int] = []
    outstanding_webhooks: list[dict[str, Any]] = []
    successful_paid_by_shop: collections.Counter = collections.Counter()
    for webhook in webhooks:
        shop_id = integer(webhook.get("shop_id"))
        shop = shop_by_id.get(shop_id, f"shop:{shop_id}")
        topic = str(webhook.get("topic") or "MISSING")
        status = str(webhook.get("status") or "MISSING")
        attempts = integer(webhook.get("attempt_count"))
        webhook_topics[topic] += 1
        webhook_statuses[status] += 1
        webhooks_by_shop[(shop, status)] += 1
        webhook_attempts.append(attempts)
        if topic == "orders/paid" and status == "SUCCESS":
            successful_paid_by_shop[shop] += 1
        if status not in {"SUCCESS", "FAILED_PERMANENT"}:
            outstanding_webhooks.append({
                "shop_domain": shop,
                "topic": topic,
                "status": status,
                "attempt_count": attempts,
                "triggered_at": iso(webhook.get("triggered_at")),
                "created_at": iso(webhook.get("created_at")),
                "next_attempt_at": iso(webhook.get("next_attempt_at")),
                "lease_expires_at": iso(webhook.get("lease_expires_at")),
                "has_error_message": present(webhook.get("error_message")),
            })

    purchases_by_shop = collections.Counter(record["shop_domain"] for record in purchase_records)
    purchase_webhook_reconciliation = []
    all_shop_domains = sorted(set(shop_by_id.values()))
    for shop in all_shop_domains:
        paid = successful_paid_by_shop[shop]
        purchases = purchases_by_shop[shop]
        total_paid_inbox = sum(
            1 for row in webhooks
            if shop_by_id.get(integer(row.get("shop_id"))) == shop and row.get("topic") == "orders/paid"
        )
        purchase_webhook_reconciliation.append({
            "shop_domain": shop,
            "orders_paid_inbox_total": total_paid_inbox,
            "orders_paid_inbox_success": paid,
            "purchase_events": purchases,
            "successful_webhook_to_purchase_match": paid == purchases,
            "paid_inbox_coverage_pct": pct(paid, total_paid_inbox),
        })

    alias_keys: collections.Counter = collections.Counter()
    alias_types: collections.Counter = collections.Counter()
    for alias in aliases:
        alias_keys[(alias.get("shop_id"), alias.get("event_name"), alias.get("alias_type"), alias.get("alias_value"))] += 1
        alias_types[(alias.get("event_name"), alias.get("alias_type"))] += 1

    snapshot_statuses: collections.Counter = collections.Counter()
    snapshot_metrics: collections.Counter = collections.Counter()
    empty_quality_events = 0
    null_quality_averages = 0
    for snapshot in snapshots:
        snapshot_statuses[str(snapshot.get("status") or "MISSING")] += 1
        snapshot_metrics[str(snapshot.get("metric_type") or "MISSING")] += 1
        summary = json_value(snapshot.get("summary_payload"))
        if summary.get("events") == []:
            empty_quality_events += 1
        if summary.get("average_score") is None:
            null_quality_averages += 1

    pixel_route_counts: collections.Counter = collections.Counter(
        integer(route.get("pixel_id")) for route in routes if str(route.get("status")) == "active"
    )
    active_pixels = [row for row in tables["pixels"] if str(row.get("status")) == "active"]
    shared_active_datasets = sum(1 for count in pixel_route_counts.values() if count > 1)

    daily_output: dict[str, list[dict[str, Any]]] = {}
    for timezone_name, counter in daily.items():
        rows = []
        for (shop, date, event_name), count in sorted(counter.items()):
            rows.append({
                "shop_domain": shop,
                "date": date,
                "event_name": event_name,
                "count": count,
            })
        daily_output[timezone_name] = rows

    findings: list[dict[str, Any]] = []
    if outstanding_webhooks:
        max_attempts = max(item["attempt_count"] for item in outstanding_webhooks)
        findings.append({
            "severity": "critical",
            "code": "SHOPIFY_PAID_WEBHOOK_STUCK",
            "evidence": {
                "outstanding_rows": len(outstanding_webhooks),
                "max_attempt_count": max_attempts,
                "orders_paid_success_rate_pct": pct(webhook_statuses["SUCCESS"], len(webhooks)),
            },
            "impact": "At least one paid order is missing its authoritative server-side Purchase fallback.",
        })
    if shared_active_datasets:
        findings.append({
            "severity": "high",
            "code": "META_DATASET_SHARED_ACROSS_SHOPS",
            "evidence": {
                "shared_active_datasets": shared_active_datasets,
                "active_shops": len([row for row in shops if str(row.get("status")) == "active"]),
                "active_routes": len([row for row in routes if str(row.get("status")) == "active"]),
            },
            "impact": "Ads Manager attribution and diagnostics mix two storefronts in one dataset.",
        })
    if empty_quality_events == len(snapshots) and snapshots:
        findings.append({
            "severity": "high",
            "code": "META_QUALITY_API_EMPTY",
            "evidence": {
                "quality_snapshots": len(snapshots),
                "empty_event_lists": empty_quality_events,
                "null_average_scores": null_quality_averages,
            },
            "impact": "The official quality endpoint is not yielding usable event-level diagnostics.",
        })
    if source_versions.get("MISSING", 0):
        findings.append({
            "severity": "medium",
            "code": "SOURCE_VERSION_MISSING",
            "evidence": {
                "events_without_source_version": source_versions["MISSING"],
                "rate_pct": pct(source_versions["MISSING"], len(events)),
            },
            "impact": "Browser and server events cannot always be separated cleanly in historical data.",
        })
    findings.append({
        "severity": "informational",
        "code": "TIMEZONE_RECONCILIATION_REQUIRED",
        "evidence": {
            "store_timezone_assumption": args.store_timezone,
            "timezone_views_generated": list(daily_output.keys()),
        },
        "impact": "UTC event timestamps can fall on a different Shopify reporting day.",
    })

    result = {
        "generated_at": now.isoformat(),
        "scope": (
            "Complete custom-dump read. Output is aggregated and excludes credentials, raw customer identifiers, "
            "raw event identifiers, IP addresses, user agents, and raw payload bodies."
        ),
        "snapshot": {
            "database": dump.dbname,
            "server_version": dump.server_version,
            "dump_version": dump.dump_version,
            "archive_timestamp": str(dump.timestamp),
            "compression": str(dump.compression_algorithm),
            "store_timezone_assumption": args.store_timezone,
        },
        "database": {
            "table_rows": {name: len(rows) for name, rows in tables.items()},
            "total_profiled_rows": sum(len(rows) for rows in tables.values()),
        },
        "configuration": {
            "shops": [
                {
                    "shop_domain": row.get("shop_domain"),
                    "reporting_timezone": row.get("reporting_timezone") or "UTC",
                    "status": row.get("status"),
                    "created_at": iso(row.get("created_at")),
                    "admin_api_configured": present(row.get("admin_access_token")),
                }
                for row in shops
            ],
            "active_pixel_credentials": len(active_pixels),
            "active_routes": len([row for row in routes if str(row.get("status")) == "active"]),
            "shared_active_datasets": shared_active_datasets,
        },
        "events": {
            "total": len(events),
            "status_counts": counter_dict(event_statuses),
            "first_event_time_utc": min(event_dates).isoformat() if event_dates else None,
            "last_event_time_utc": max(event_dates).isoformat() if event_dates else None,
            "source_versions": counter_dict(source_versions),
            "source_providers": counter_dict(source_providers),
            "duplicate_rows": duplicate_rows,
            "duplicate_rate_pct": pct(duplicate_rows, len(events)),
            "cross_event_reused_event_ids": sum(reused_event_ids.values()),
            "cross_event_reuse_patterns": counter_dict(reused_event_ids),
            "future_dated_events": future_events,
            "signal_coverage_pct": {
                signal: pct(overall_signal_counts[signal], len(events)) for signal in IDENTITY_SIGNALS
            },
            "ingestion_lag_seconds_by_source": {
                provider: summarize_lag(values) for provider, values in sorted(source_lags.items())
            },
            "meta_acceptance": {
                "events_with_meta_api_ack": meta_accepted,
                "acceptance_response_coverage_pct": pct(meta_accepted, len(events)),
            },
            "by_shop_event_source": normalized_aggregate,
            "daily_funnel_by_timezone": daily_output,
            "purchase_records": sorted(purchase_records, key=lambda row: row["event_time_utc"]),
        },
        "delivery": {
            "total": len(deliveries),
            "status_counts": counter_dict(delivery_statuses),
            "attempt_counts": counter_dict(delivery_attempts),
            "rows_with_errors": delivery_errors,
            "orphan_deliveries": orphan_deliveries,
            "cross_tenant_deliveries": cross_tenant_deliveries,
            "route_snapshot_mismatches": route_snapshot_mismatches,
        },
        "shopify_webhooks": {
            "total": len(webhooks),
            "topics": counter_dict(webhook_topics),
            "statuses": counter_dict(webhook_statuses),
            "by_shop_and_status": [
                {"shop_domain": shop, "status": status, "count": count}
                for (shop, status), count in sorted(webhooks_by_shop.items())
            ],
            "max_attempt_count": max(webhook_attempts, default=0),
            "outstanding": outstanding_webhooks,
            "paid_purchase_reconciliation": purchase_webhook_reconciliation,
        },
        "aliases": {
            "total": len(aliases),
            "duplicate_keys": sum(1 for count in alias_keys.values() if count > 1),
            "by_event_and_type": [
                {"event_name": event_name, "alias_type": alias_type, "count": count}
                for (event_name, alias_type), count in sorted(alias_types.items())
            ],
        },
        "dead_letters": {
            "total": len(tables["dead_letters"]),
        },
        "meta_quality": {
            "total": len(snapshots),
            "status_counts": counter_dict(snapshot_statuses),
            "metric_counts": counter_dict(snapshot_metrics),
            "empty_event_lists": empty_quality_events,
            "null_average_scores": null_quality_averages,
        },
        "findings": findings,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.output.resolve())


if __name__ == "__main__":
    main()
