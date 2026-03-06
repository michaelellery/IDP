# IDP CloudWatch Alarms & Dashboard

**Account:** 430695043165 (idp-dev) | **Region:** us-east-1
**Created:** 2026-03-06

## SNS Topic

- **Topic:** `idp-dev-alerts` — `arn:aws:sns:us-east-1:430695043165:idp-dev-alerts`
- **Note:** No subscriptions configured yet. Add email/Slack/PagerDuty endpoints as needed.

## Alarms Summary (42 total)

### Step Functions (3 alarms)
| Alarm | Metric | Threshold | Period |
|-------|--------|-----------|--------|
| `idp-dev-sfn-ExecutionsFailed` | ExecutionsFailed | > 0 | 5 min |
| `idp-dev-sfn-ExecutionsTimedOut` | ExecutionsTimedOut | > 0 | 5 min |
| `idp-dev-sfn-ExecutionThrottled` | ExecutionThrottled | > 0 | 5 min |

### Lambda (30 alarms — 3 per function × 10 functions)
Per function: Errors > 0, Throttles > 0, Duration > 25s (max)

**Functions:** idp-decomposition, idp-quality-check, idp-classification, idp-data-extraction, idp-fraud-check, idp-mark-complete, idp-mark-rejected, idp-send-feedback, idp-api, idp-populate-db

### Aurora (3 alarms)
| Alarm | Metric | Threshold | Eval Periods |
|-------|--------|-----------|--------------|
| `idp-dev-aurora-cpu` | CPUUtilization | > 80% | 2 × 5 min |
| `idp-dev-aurora-memory` | FreeableMemory | < 256 MB | 2 × 5 min |
| `idp-dev-aurora-connections` | DatabaseConnections | > 80 | 1 × 5 min |

### SQS (4 alarms — 2 per queue)
**Queues:** idp-dev-fraud-review-queue, idp-dev-hitl-queue

| Metric | Threshold |
|--------|-----------|
| ApproximateNumberOfMessagesVisible | > 100 |
| ApproximateAgeOfOldestMessage | > 3600s (1 hr) |

### API Gateway (2 alarms)
| Alarm | Metric | Threshold |
|-------|--------|-----------|
| `idp-dev-apigw-5xx` | 5XXError | > 0 (sum) |
| `idp-dev-apigw-latency-p99` | Latency p99 | > 5000ms |

## Dashboard

- **Name:** `IDP-Pipeline-Health`
- **URL:** https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/IDP-Pipeline-Health
- **Widgets:** SF executions, SF duration, Lambda errors, Lambda duration, Aurora CPU/memory, Aurora connections, SQS depth, API Gateway errors, API Gateway latency

## Next Steps

1. **Add SNS subscriptions** — email, Slack webhook, or PagerDuty integration
2. **Tune thresholds** — adjust after observing baseline metrics for a week
3. **Add OK actions** — to get notified when alarms recover
4. **Consider composite alarms** — e.g., "pipeline unhealthy" combining multiple signals
